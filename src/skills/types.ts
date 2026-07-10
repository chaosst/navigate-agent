export type SkillActionType = "template" | "shell" | "http" | "code";

export interface SkillAction {
  type: SkillActionType;
  template?: string;
  command?: string;
  workdir?: string;
  timeout?: number;
  url?: string;
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  code?: string;
}

export interface SkillDefinition {
  name: string;
  description: string;
  schema: {
    type: "object";
    properties: Record<string, unknown>;
    required?: string[];
  };
  action: SkillAction;
}
