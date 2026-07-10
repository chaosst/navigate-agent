import { readFileSync, existsSync, readdirSync, watch } from "node:fs";
import { join } from "node:path";
import { load as parseYaml } from "js-yaml";
import { StructuredTool } from "@langchain/core/tools";
import { SkillTool } from "./skill-tool.js";
import type { SkillDefinition } from "./types.js";

export class SkillRegistry {
  private skillsDir: string;
  private tools: Map<string, StructuredTool> = new Map();

  constructor(skillsDir: string = "skills") {
    this.skillsDir = skillsDir;
  }

  /** Scan directory and load all .skill.yaml files */
  async loadAll(): Promise<StructuredTool[]> {
    this.tools.clear();

    if (!existsSync(this.skillsDir)) {
      console.log(`[skills] Directory "${this.skillsDir}" not found, skipping skill loading`);
      return [];
    }

    const files = readdirSync(this.skillsDir)
      .filter(f => f.endsWith(".skill.yaml") || f.endsWith(".skill.yml"));

    if (files.length === 0) {
      console.log(`[skills] No .skill.yaml files found in "${this.skillsDir}"`);
      return [];
    }

    console.log(`[skills] Loading ${files.length} skill(s) from "${this.skillsDir}"...`);

    for (const file of files) {
      try {
        const tool = await this.loadSkill(join(this.skillsDir, file));
        if (tool) {
          if (this.tools.has(tool.name)) {
            console.warn(`[skills] Warning: duplicate skill name "${tool.name}" — overwriting from ${file}`);
          }
          this.tools.set(tool.name, tool);
          console.log(`[skills]   ✓ ${tool.name} (${file})`);
        }
      } catch (err) {
        console.warn(`[skills]   ✗ Skipping "${file}": ${(err as Error).message}`);
      }
    }

    console.log(`[skills] Loaded ${this.tools.size} skill(s) successfully`);
    return Array.from(this.tools.values());
  }

  /** Load a single skill file */
  async loadSkill(filePath: string): Promise<StructuredTool | null> {
    if (!existsSync(filePath)) {
      console.warn(`[skills] File not found: ${filePath}`);
      return null;
    }

    const raw = readFileSync(filePath, "utf-8");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let parsed: any;
    try {
      parsed = parseYaml(raw);
    } catch (e) {
      throw new Error(`Invalid YAML: ${(e as Error).message}`);
    }

    // Validate required fields
    if (!parsed.name || typeof parsed.name !== "string") {
      throw new Error("Missing or invalid 'name' field");
    }
    if (!parsed.description || typeof parsed.description !== "string") {
      throw new Error("Missing or invalid 'description' field");
    }
    if (!parsed.action || !parsed.action.type) {
      throw new Error("Missing or invalid 'action.type' field");
    }
    if (!["template", "shell", "http", "code"].includes(parsed.action.type)) {
      throw new Error(`Invalid action type: "${parsed.action.type}". Must be one of: template, shell, http, code`);
    }

    // Validate action-specific requirements
    switch (parsed.action.type) {
      case "template":
        if (!parsed.action.template) throw new Error("template action requires 'template' field");
        break;
      case "shell":
        if (!parsed.action.command) throw new Error("shell action requires 'command' field");
        break;
      case "http":
        if (!parsed.action.url) throw new Error("http action requires 'url' field");
        break;
      case "code":
        if (!parsed.action.code) throw new Error("code action requires 'code' field");
        break;
    }

    const def: SkillDefinition = {
      name: parsed.name,
      description: parsed.description,
      schema: parsed.schema || { type: "object", properties: {} },
      action: {
        type: parsed.action.type,
        template: parsed.action.template,
        command: parsed.action.command,
        workdir: parsed.action.workdir,
        timeout: parsed.action.timeout,
        url: parsed.action.url,
        method: parsed.action.method,
        headers: parsed.action.headers,
        body: parsed.action.body,
        code: parsed.action.code,
      },
    };

    return new SkillTool(def);
  }

  /** Get a loaded tool by name */
  getTool(name: string): StructuredTool | undefined {
    return this.tools.get(name);
  }

  /** Get all loaded tools */
  getAllTools(): StructuredTool[] {
    return Array.from(this.tools.values());
  }

  /** Watch directory for changes (optional, for hot-reload) */
  watch(): void {
    if (!existsSync(this.skillsDir)) return;

    watch(this.skillsDir, async (eventType: string, filename: string | null) => {
      if (!filename) return;
      if (!filename.endsWith(".skill.yaml") && !filename.endsWith(".skill.yml")) return;
      console.log(`[skills] File changed: ${filename}, reloading...`);
      try {
        const filePath = join(this.skillsDir, filename);
        if (existsSync(filePath)) {
          const tool = await this.loadSkill(filePath);
          if (tool) {
            this.tools.set(tool.name, tool);
            console.log(`[skills]   ✓ Reloaded "${tool.name}"`);
          }
        } else {
          console.log(`[skills]   File "${filename}" removed — consider restarting to clear skills`);
        }
      } catch (err) {
        console.warn(`[skills]   ✗ Reload failed: ${(err as Error).message}`);
      }
    });
  }
}
