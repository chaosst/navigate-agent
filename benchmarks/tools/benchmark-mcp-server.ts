// benchmarks/tools/benchmark-mcp-server.ts —— MCP 包装（stdio 传输），三方（navigate / CrewAI / MAF）共用

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { z } from "zod"
import { calculator, weather_now } from "./tools.js"

const server = new McpServer(
    {
        name: "benchmark-mcp-server",
        version: "1.0.0",
    },
    {
        capabilities: {
            tools: {},
        },
    },
)

// 与 tool-contract.json / tools.ts 三方一致：输入 expression，非法表达式返回 { ok:false, error }
server.registerTool(
    "calculator",
    {
        title: "calculator",
        description:
            "四则运算求值器：输入算术表达式（如 '3+4*2'）返回计算结果；支持括号/小数/一元负号。非法表达式返回 { ok:false, error }。",
        inputSchema: {
            expression: z.string().min(1).trim().describe("要计算的算术表达式，如 '3+4*2'"),
        },
    },
    (args) => {
        const result = calculator(args.expression)
        return {
            content: [
                {
                    type: "text",
                    text: JSON.stringify(result, null, 2),
                },
            ],
        }
    },
)

server.registerTool(
    "weather_now",
    {
        title: "weather_now",
        description: "查询天气（mock，固定数据）：任意城市返回同一份固定天气，source 固定为 mock。",
        inputSchema: {
            city: z.string().min(1).trim().describe("城市名"),
        },
    },
    async (args) => {
        const result = weather_now(args.city)
        return {
            content: [
                {
                    type: "text",
                    text: JSON.stringify(result, null, 2),
                },
            ],
        }
    },
)

async function main() {
    const transport = new StdioServerTransport()
    await server.connect(transport)
}

main().catch((err) => {
    console.error("[benchmark-mcp-server] 启动失败:", err)
    process.exit(1)
})
