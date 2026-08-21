import { StructuredToolInterface } from "@langchain/core/tools";
import { jsonSchemaToTs } from "./sdk-generator.js";

const PTC_SYSTEM_PROMPT = `你处于 PTC（程序化工具调用）模式。你可以编写 TypeScript 程序，通过 run_code 工具一次执行多步工具操作。

编写规则：
1. 程序体是 async 函数体：支持顶层 await 与 return；return 值会成为工具结果的一部分。
2. 通过 await tools["工具名"](args) 调用工具；args 必须与工具 schema 匹配（见下方类型声明）。
3. 只读、相互独立的调用可以用 Promise.all([...]) 重叠执行；
4. 变更类调用（写文件、执行命令）必须串行，按提交顺序；
5. 有依赖关系的调用用 await 序列化；
6. 工具调用失败会抛出 ToolCallError（含 toolName 与 message 属性），请 try/catch 捕获并自行处理；
7. 只把需要回灌上下文的摘要、结果 return 出来，不要在程序里打印大段内容；
8. 仅使用可擦除 TypeScript：禁止 enum、namespace、类型断言以外的非擦除语法；
9. 程序运行有墙钟与输出大小上限，超出会以 error 返回，请根据 error.kind 自纠。`

/** PTC_SYSTEM_PROMPT + SDK 类型声明 → 完整系统提示 */
export function buildPtcSystemPrompt(sdkTools: StructuredToolInterface[]): string {
    return `${PTC_SYSTEM_PROMPT}
  
  以下为程序内可用工具的类型声明（ts-ignore 仅为提示用，运行时执行前剥离类型）：
  \`\`\`typescript
  ${jsonSchemaToTs(sdkTools)}
  \`\`\``;
}