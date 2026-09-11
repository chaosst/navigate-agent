#!/usr/bin/env node
/**
 * Server-only entry point — starts the web server (RAG, Wiki, Resume)
 * without the TUI chat interface.
 *
 * Usage: npx tsx src/server-entry.ts
 */
import "dotenv/config";
import { loadConfig } from "./config/index.js";
import { createChatModel, createEmbeddings } from "./agent/langchain.js";
import { GraphAgentExecutor } from "./agent/graph-agent-executor.js";
import { buildResumeSystemPrompt } from "./resume/prompt.js";
import { analyzeJdMatch, serializeResumeForJd } from "./resume/jd-analyzer.js";
import type { JdMatchResult } from "./resume/jd-analyzer.js";
import type { ResumeData } from "./resume/types.js";
import { loadResumeSource } from "./resume/loader.js";
import type { StructuredTool } from "@langchain/core/tools";
import { PgVectorStore } from "./storage/pg-vector-store.js";
import { getPool } from "./storage/pool.js";
import { createRagServer } from "./server/index.js";
import { answerAcrossDocs } from "./rag/parallel-answer.js";
import { ResumeStore } from "./resume/store.js";
import { ResumeSearchTool } from "./resume/search-tool.js";
import { parseResumeText } from "./resume/parser.js";
import { createHash } from "node:crypto";
import { ApiKeyStore } from "./server/key-store.js";
import type { ApiKeyAuthConfig } from "./server/api-key-auth.js";
import { ToolStatsRegistry } from "./tools/stats-registry.js";
import { PermissionWrapper } from "./tools/permission.js";
import { ReadOnlyToolFilter } from "./tools/tool-filter.js";
import { buildApproval, resolveApprovalMode } from "./tools/human-channel.js";

async function main() {
  const config = loadConfig();
  const apiAuth: ApiKeyAuthConfig | undefined =
    config.apiKeys || config.apiKeyLegacy
      ? {
          keyStore: ApiKeyStore.fromEnv(config.apiKeys, config.apiKeyLegacy),
          ipWhitelist: config.apiIpWhitelist
            ? config.apiIpWhitelist.split(",").map((s) => s.trim()).filter(Boolean)
            : undefined,
          signatureWindowMs: config.apiSignatureWindowMs,
          trustProxy: config.apiTrustProxy,
          failureLimit: config.apiFailureLimit,
          failureWindowMs: config.apiFailureWindowMs,
        }
      : undefined;
  const llm = createChatModel(config);

  const embeddings = createEmbeddings(config)

  // RAG setup
  const pool = await getPool(config);
  const ragStore = new PgVectorStore(pool, embeddings);

  // ——— 工具装配基础设施 ———
  // 本进程（H5/Web）只对外暴露简历问答一个 agent 面，故只装配它需要的最小权限基础设施。
  // 完整能力面（shell / 文件 / RAG / skills）的入口在 TUI（src/bootstrap.ts + src/index.ts），
  // server 进程**不再**构造全量 executor —— 见下方 resumeExecutor 注释里的安全说明。

  // 无人值守：审批默认 deny（APPROVAL_POLICY 可覆盖为 interactive/allow）
  const approvalMode = resolveApprovalMode(process.env.APPROVAL_POLICY, "deny");
  const { channel: humanChannel, policy: approvalPolicy } = buildApproval(approvalMode);
  // 统计注册表：工具经 PermissionWrapper 包装后注册（统计 / 限流 / 熔断生效）
  const toolStatsRegistry = new ToolStatsRegistry();

  /**
   * 只读包装：显式赋予 permission="read" 元数据。必要而非装饰：
   *  ① ReadOnlyToolFilter 按 permission 判等过滤，**裸工具（permission 为 undefined）
   *     会被判为不可用 → 简历问答将完全没有工具可调**；
   *  ② permission 是统计 / 限流 / 审批门的前提。
   * read 级工具不会触发审批门（ThresholdApprovalPolicy 阈值是 ≥ write），故无人值守
   * 的 server 端不会因它卡住。
   */
  const wrapRead = (tool: StructuredTool): StructuredTool =>
    new PermissionWrapper(tool, "read", undefined, toolStatsRegistry, humanChannel, approvalPolicy);

  // Resume setup — 入口归一化：resume.md 优先，其次 resume.docx（mammoth 本地转 md）。
  // 下游（结构化解析 / RAG / JD 诊断 / 展示页）只消费归一化后的 markdown 单一事实源。
  let resumeSummary: string | undefined;
  let resumeTool: StructuredTool | undefined;
  let resumeData: Awaited<ReturnType<typeof parseResumeText>> | undefined;
  let resumeStore: ResumeStore | undefined;
  let resumeMarkdown: string | undefined;

  const resumeSource = await loadResumeSource();
  if (resumeSource) {
    try {
      resumeStore = await ResumeStore.create("navigate.db", embeddings);
      resumeMarkdown = resumeSource.text;
      resumeData = parseResumeText(resumeMarkdown);

      // ⚠️ 空索引守卫（2026-09-11）：0 章节 ⇒ 0 chunk ⇒ search 恒返回空。
      // 此时若继续装配，接口会返回 200 而 agent 对任何问题都答「简历中未提及」——
      // 比直接 503 更危险：故障从「服务不可用」伪装成「服务正常但简历没写」，
      // 面试演示时表现为「智能体不认识自己的简历」，且排查时第一直觉会怀疑模型而非解析。
      // 常见成因：源文件不是解析器契约形态（分节标题不是 `##`、或 docx 用了中文编号段落）。
      if (resumeData.sections.length === 0) {
        throw new Error(
          "解析出 0 个章节 —— 索引将为空，简历问答无法回答任何问题。" +
            `源文件：${resumeSource.sourcePath}。` +
            "请确认分节能被识别为 `## 标题`（docx 的中文编号标题如「一、教育背景」会由 loader 自动提升）。",
        );
      }

      const hash = md5(resumeMarkdown);
      if (await resumeStore.hasChanged(hash)) {
        await resumeStore.import(resumeData, resumeMarkdown);
        console.log(`Resume indexed successfully (source: ${resumeSource.sourcePath})`);
      } else {
        console.log("Resume unchanged, using cached index");
      }

      resumeSummary = await resumeStore.getSummary();
      // 必须经 wrapRead 包装：裸工具没有 permission 元数据，会被只读过滤器 fail-closed 掉
      resumeTool = wrapRead(new ResumeSearchTool(resumeStore));
    } catch (err) {
      console.error("Resume loading skipped:", (err as Error).message);
    }
  }

  // 简历问答专用 sub-agent（最小权限面 + 只读硬闸门，两层独立防御）：
  // - 第 1 层「最小工具集」：只有 resumeTool，不含 shell / 文件 / RAG / skills；
  // - 第 2 层「只读过滤器」：ReadOnlyToolFilter 忽略用户输入、恒定只留 permission="read"
  //   的工具。即使将来有人往工具数组里加了 write/dangerous 工具，也进不了 LLM 的工具面。
  //   ⚠️ 不要用 ToolFilter 代替它 —— 那是「按关键词向上放开权限」的体验优化，
  //   用户一句「帮我执行命令」就会把 dangerous 工具重新展开，不能当安全边界。
  //   ⚠️ 边界：过滤器管的是「LLM 可见面」。执行层（TrackingToolNode）持有的正是这份工具
  //   数组本身，所以真正让越权无从下手的是第 1 层——数组里只有 resumeTool。两层缺一不可：
  //   只做过滤而数组里仍有危险工具时，被 prompt 注入诱导出的未绑定 tool_call 仍有执行风险。
  // - 不传 toolStatsRegistry / tracer → finalize 时 buildStatsFooter() 输出空串，
  //   回答末尾不会带主 agent 的「工具调用统计 / Tokens」脚注；
  // - 专用 system prompt 固化「只答简历 + 越界拒绝」规则。
  let resumeExecutor: GraphAgentExecutor | undefined;
  if (resumeTool) {
    resumeExecutor = new GraphAgentExecutor(
      llm,
      [resumeTool],
      buildResumeSystemPrompt(resumeSummary),
      Math.min(config.maxIterations, 8), // 简历问答检索收敛快，限制轮数防烧钱
      undefined, // toolStatsRegistry — 故意不传（消除脚注）
      new ReadOnlyToolFilter(), // toolFilter — 只读硬闸门
      undefined, // tracer
      config.llmTimeoutMs,
    );
  }

  // JD 匹配诊断器：结构化紧凑序列化（serializeResumeForJd）而非 resume.md 原文——
  // 去 frontmatter/装饰噪音、token 更省；超过 MAX_JD_RESUME_CHARS 时 analyze
  // 抛 ResumeTooLongError，jd-match 路由转可读 400。
  const jdAnalyzer = resumeData
    ? { analyze: (jd: string): Promise<JdMatchResult> => analyzeJdMatch(llm, serializeResumeForJd(resumeData as ResumeData), jd) }
    : undefined;

  // ⚠️ 安全不变量（2026-09-11 修复）：本进程**不构造全量 executor**，简历问答也绝不回退
  // 到任何通用 agent。旧实现在 resume 未装配时会 buildFallbackExecutor()（含 execute_command /
  // write_file 的完整核心工具面），而 /api/resume/chat 写的又是 `resumeExecutor ?? executor`
  // —— 一个缺失的 resume.md（或一次索引构建异常）就足以把只读问答入口降级成可执行命令的
  // agent（fail-open）。现在 resume 装配失败 = 简历问答不可用，由接口返回 503。
  // 若将来要开 H5 通用问答，请新建一个**显式带权限白名单**的装配函数，
  // 不要把全量工具面接到任何面向 guest 的入口上。
  if (!resumeExecutor) {
    console.warn(
      "[resume] ⚠️  简历问答 agent 未装配 —— /api/resume/chat 将返回 503（不会降级到完整工具集）。\n" +
      "[resume]    常见原因：缺少 resume.md / resume.docx，或索引构建失败（见上方 Resume 日志）。",
    );
  } else {
    console.log(
      "[resume] 简历问答已装配：工具面 = [search_resume]（只读），未含 shell / 文件 / RAG 工具",
    );
  }

  // 跨文档并行问答：worker 并发数走环境变量（server-entry 已 import "dotenv/config"）
  const maxConcurrency = Math.max(1, Number(process.env.MAX_PARALLEL_WORKERS ?? 4));
  createRagServer(
    ragStore,
    3001,
    resumeStore,
    resumeData,
    apiAuth,
    resumeExecutor,
    jdAnalyzer,
    {
      parallelAsk: (question: string, docIds: string[]) =>
        answerAcrossDocs({ question, docIds, store: ragStore, llm, maxConcurrency }),
    },
  );

  console.log("");
  console.log("──────────────────────────────────────────");
  console.log("  Web server running on http://localhost:3001");
  console.log("  zyplayer-doc on http://localhost:8083");
  console.log("  Agent CLI: npm run dev");
  console.log("──────────────────────────────────────────");

  // Keep the process alive
  await new Promise(() => {});
}

function md5(s: string): string {
  return createHash("md5").update(s).digest("hex");
}

main().catch(err => { console.error("Fatal:", err); process.exit(1); });
