import { StructuredToolInterface } from "@langchain/core/tools";
import { z } from "zod";

/**
 * 将 zod schema 递归映射为 TS 类型字符串。
 * - 覆盖常见构造：string / number / boolean / enum / literal / array / object / record / tuple / union
 * - 对 optional / nullable / default / effects 等 wrapper 递归取其 innerType
 * - 不支持的构造退化为 unknown
 */
function zodToTs(schema: unknown): string {
  if (!schema) return "unknown";

  // wrapper 类型：剥壳后递归
  if (
    schema instanceof z.ZodOptional ||
    schema instanceof z.ZodNullable ||
    schema instanceof z.ZodDefault ||
    schema instanceof z.ZodEffects ||
    schema instanceof z.ZodBranded ||
    schema instanceof z.ZodCatch
  ) {
    const inner = (schema as z.ZodTypeAny)._def?.innerType;
    return inner ? zodToTs(inner) : "unknown";
  }

  // 基础标量
  if (schema instanceof z.ZodString) return "string";
  if (schema instanceof z.ZodNumber) return "number";
  if (schema instanceof z.ZodBoolean) return "boolean";
  if (schema instanceof z.ZodBigInt) return "bigint";

  // 字面量与枚举
  if (schema instanceof z.ZodLiteral) return JSON.stringify(schema.value);
  if (schema instanceof z.ZodEnum) {
    return schema.options.map((o: unknown) => JSON.stringify(o)).join(" | ");
  }
  if (schema instanceof z.ZodNativeEnum) {
    return Object.values(schema.enum as Record<string, unknown>)
      .map((v) => JSON.stringify(v))
      .join(" | ");
  }

  // 容器
  if (schema instanceof z.ZodArray) return `${zodToTs(schema.element)}[]`;
  if (schema instanceof z.ZodTuple) {
    return `[${schema.items.map((i: unknown) => zodToTs(i)).join(", ")}]`;
  }
  if (schema instanceof z.ZodRecord) {
    return `Record<string, ${zodToTs((schema as any).valueType)}>`;
  }
  if (schema instanceof z.ZodObject) {
    const entries = Object.entries(schema.shape).map(([k, v]) => {
      const isOptional =
        v instanceof z.ZodOptional || v instanceof z.ZodNullable;
      return `${k}${isOptional ? "?" : ""}: ${zodToTs(v)}`;
    });
    return `{ ${entries.join("; ")} }`;
  }
  if (schema instanceof z.ZodUnion) {
    return schema.options.map((o: unknown) => zodToTs(o)).join(" | ");
  }
  if (schema instanceof z.ZodIntersection) {
    return `(${zodToTs(schema._def.left)} & ${zodToTs(schema._def.right)})`;
  }

  return "unknown";
}



/**
 * 工具 → TS 类型声明
 * - JSON Schema 的 type/description/enum/required 映射为 TS 类型 + JSDoc
 * - 工具暴露为引号对象键 tools["my-tool"](…)：支持任意工具名，零别名/碰撞逻辑
 * - 不支持的 schema 构造退化为 unknown
 * - 输出是咨询性的：运行时执行前剥离类型
 */
export function jsonSchemaToTs(tools: StructuredToolInterface[]): string {
    return tools.map((item) => {
        const schema = item.schema
        const params = zodToTs(schema)
        return `/**
        * ${item.description ?? ""}
        */
        type ${item.name}_args = ${params};

        // @ts-ignore 未定义工具引用
        declare const tools: {
        [key: string]: (args: never) => Promise<unknown>;
        } & {
        ${tools.map((t2) => `"${t2.name}"(args: ${t2.name}_args): Promise<unknown>`).join(";\n  ")}
        };`; 
    })
    .join("\n\n");
}