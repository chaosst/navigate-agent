import { StructuredTool } from "@langchain/core/tools";
import { z } from "zod";
import { execSync } from "node:child_process";
import type { SkillDefinition, SkillAction } from "./types.js";

/** Render a simple template: replace {{ param }} with values */
function renderTemplate(template: string, params: Record<string, unknown>): string {
  return template.replace(/\{\{\s*(\w+)\s*\}\}/g, (_, key) => {
    if (params[key] === undefined) throw new Error(`Missing required parameter: ${key}`);
    return String(params[key]);
  });
}

/** Execute HTTP request */
async function callHttp(action: SkillAction, params: Record<string, unknown>): Promise<string> {
  const url = renderTemplate(action.url || "", params);
  const method = action.method || "GET";
  const headers: Record<string, string> = {};
  if (action.headers) {
    for (const [k, v] of Object.entries(action.headers)) {
      // Resolve ${ENV_VAR}
      headers[k] = v.replace(/\$\{(\w+)\}/g, (_, name) => process.env[name] || "");
    }
  }
  const body = action.body ? renderTemplate(action.body, params) : undefined;

  const res = await fetch(url, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text();
  if (!res.ok) return `HTTP ${res.status}: ${text}`;
  try {
    return JSON.stringify(JSON.parse(text), null, 2);
  } catch {
    return text;
  }
}

/** Execute shell command */
function execShell(action: SkillAction, params: Record<string, unknown>): string {
  const command = renderTemplate(action.command || "", params);
  try {
    const output = execSync(command, {
      cwd: action.workdir || process.cwd(),
      timeout: action.timeout || 30000,
      encoding: "utf-8",
      maxBuffer: 10 * 1024 * 1024,
    });
    return `Exit code: 0\n${output}`;
  } catch (err: any) {
    return `Exit code: ${err.status ?? 1}\nstdout: ${err.stdout || ""}\nstderr: ${err.stderr || ""}`;
  }
}

/** Execute inline code in a sandbox */
async function runCode(code: string, params: Record<string, unknown>): Promise<string> {
  try {
    const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor;
    const fn = new AsyncFunction("params", code);
    const result = await fn(params);
    if (result === undefined || result === null) return "Done (no return value)";
    if (typeof result === "object") return JSON.stringify(result, null, 2);
    return String(result);
  } catch (err) {
    return `Error: ${(err as Error).message}`;
  }
}

export class SkillTool extends StructuredTool {
  name: string;
  description: string;
  schema: z.ZodObject<any>;
  private def: SkillDefinition;

  constructor(def: SkillDefinition) {
    super();
    this.def = def;
    this.name = def.name;
    this.description = def.description;

    // Build Zod schema from JSON Schema
    const shape: Record<string, z.ZodTypeAny> = {};
    if (def.schema.properties) {
      for (const [key, prop] of Object.entries(def.schema.properties)) {
        const p = prop as Record<string, unknown>;
        let zType: z.ZodTypeAny;
        switch (p.type) {
          case "string": zType = z.string(); break;
          case "integer": zType = z.number().int(); break;
          case "number": zType = z.number(); break;
          case "boolean": zType = z.boolean(); break;
          default: zType = z.string(); break;
        }
        if (p.description) zType = zType.describe(p.description as string);
        if (p.enum) zType = (zType as any).enum(p.enum as [string, ...string[]]);
        if (p.default !== undefined) zType = zType.default(p.default);
        shape[key] = zType;
      }
    }
    const required = def.schema.required || [];
    this.schema = z.object(shape).partial().required(Object.fromEntries(required.map(k => [k, true])) as any);
  }

  async _call(input: Record<string, unknown>): Promise<string> {
    const action = this.def.action;
    try {
      switch (action.type) {
        case "template":
          return renderTemplate(action.template!, input);
        case "shell":
          return execShell(action, input);
        case "http":
          return await callHttp(action, input);
        case "code":
          return await runCode(action.code!, input);
        default:
          return `Unknown action type: ${action.type}`;
      }
    } catch (err) {
      return `Skill error: ${(err as Error).message}`;
    }
  }
}
