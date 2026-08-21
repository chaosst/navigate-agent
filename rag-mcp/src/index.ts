#!/usr/bin/env node
import { Server } from '@modelcontextprotocol/sdk/server'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

const API_BASE = "http://localhost:3001"

// 固定 API key 从环境变量读取,不硬编码进源码。
// 启动时注入,例如: RAG_API_KEY=sk-xxx tsx src/index.ts
const RAG_API_KEY = process.env.RAG_API_KEY
if (!RAG_API_KEY) {
  console.error("[rag-mcp] 缺少环境变量 RAG_API_KEY(固定 API key)。无法调用 navigate 接口。")
  process.exit(1)
}

const server = new Server({
    name: 'navigate-rag-mcp',
    version: '1.0.0'
}, {
    capabilities: {
        tools: {}
    }
})


server.setRequestHandler(ListToolsRequestSchema, async ()=>{
    return {
        tools: [
            {
                name: 'queryByVector',
                description: '通过把入参的keyword进行分词后转为向量，再进行向量数据库查询，并通过RRF排序输出最贴合搜索词语义的内容',
                inputSchema: {
                    type: 'object',
                    properties: {
                        keyword: {
                            type: 'string',
                            description: '搜索词'
                        }
                    }
                }
            },
            {
                name: 'searchByKeyword',
                description: '通过把入参的keyword进行数据库精准匹配查询，并通过排序输出搜索词相关的内容',
                inputSchema: {
                    type: 'object',
                    properties: {
                        keyword: {
                            type: 'string',
                            description: '搜索词'
                        }
                    }
                }
            }
        ]
    }
})


server.setRequestHandler(CallToolRequestSchema, async (request)=>{
    const { name, arguments: args } = request.params

    const body = args ? JSON.stringify(args) : undefined

    if (name === 'queryByVector') {
        const res = await fetch(`${API_BASE}/api/query`, {
            body,
            method: 'post',
            headers: {
                "Content-Type": "application/json",
                "Authorization": `Bearer ${RAG_API_KEY}`
            }
        })
        const data = await res.json()

        return {
            content: [
                {
                    type: 'text',
                    text: JSON.stringify(data, null, 2)
                }
            ]
        }
    }

    if (name === 'searchByKeyword') {
        const res = await fetch(`${API_BASE}/api/query/fts`, {
            body,
            method: 'post',
            headers: {
                "Content-Type": "application/json",
                "Authorization": `Bearer ${RAG_API_KEY}`
            }
        })
        const data = await res.json()

        return {
            content: [
                {
                    type: 'text',
                    text: JSON.stringify(data, null, 2)
                }
            ]
        }
    }
    
    throw new Error(`未知工具: ${name}`)
})

// ════════════════════════════════════════════
//  启动
// ════════════════════════════════════════════

const transport = new StdioServerTransport();
await server.connect(transport);
