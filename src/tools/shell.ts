import { execSync } from "node:child_process";
import { StructuredTool } from "@langchain/core/tools";
import { z } from "zod";

export class ShellTool extends StructuredTool {
  name = "execute_command";
  description = "Execute a shell command in the current working directory. Returns stdout, stderr, and exit code.";
  schema = z.object({
    command: z.string().describe("The shell command to execute"),
    workdir: z.string().optional().describe("Working directory (defaults to cwd)"),
    timeout: z.number().optional().describe("Timeout in milliseconds (default 30000)"),
  });

  protected async _call({ command, workdir, timeout }: z.infer<typeof this.schema>): Promise<string> {
    try {
      const output = execSync(command, {
        cwd: workdir || process.cwd(),
        timeout: timeout || 30000,
        encoding: "utf-8",
        maxBuffer: 10 * 1024 * 1024,
      });
      return `Exit code: 0\n\n${output.toString()}`;
    } catch (error: unknown) {
      const err = error as { status?: number; stdout?: string; stderr?: string; message?: string };
      return `Exit code: ${err.status ?? 1}\n\nstdout:\n${err.stdout || ""}\nstderr:\n${err.stderr || ""}\n${err.message || ""}`;
    }
  }
}
