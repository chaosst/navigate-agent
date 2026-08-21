import { Server } from '@modelcontextprotocol/sdk/server'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types'

const API_BASE = "https://jsonplaceholder.typicode.com"


// --- 1. 创建 Server 实例 ---
const server = new Server(
    {
        name: 'json-placeholder-mcp',
        version: '1.0.0'
    },
    {
        capabilities: {
            tools: {

            }
        }
    }
)

// --- 2. 注册 tools/list 处理器：告诉 Client 我有什么工具 ---
server.setRequestHandler(ListToolsRequestSchema, async()=>({
    tools: [
        {
            name: 'getUser',
            description: '根据用户ID获取用户详情',
            inputSchema: {
                type: 'object',
                properties: {
                    id: {
                        type: 'number',
                        description: '用户id（1-10）'
                    }
                },
                required: ["id"]
            }
        },
        {
            name: "getUserPosts",
            description: "根据用户 ID 获取该用户的帖子列表",
            inputSchema: {
                type: "object",
                properties: {
                userId: {
                    type: "number",
                    description: "用户 ID（1-10）",
                },
                },
                required: ["userId"],
            },
        }
    ]
}))

// --- 3. 注册 tools/call 处理器：执行实际逻辑 ---
server.setRequestHandler(CallToolRequestSchema, async(request)=>{
    const { name, arguments: args } = request.params

    if (name === 'getUser') {
        const res = await fetch(`${API_BASE}/users/${args?.id}`)
        const user = await res.json()
        return {
            content: [
                {
                    type: 'text',
                    text: JSON.stringify(user, null, 2)
                }
            ]
        }
    }

    if (name === 'getUserPosts') {
        const res = await fetch(`${API_BASE}/users/${args?.userId}/posts`)
        const posts = await res.json()
        return {
            content: [
                {
                    type: 'text',
                    text: JSON.stringify(posts, null, 2)
                }
            ]
        }
    }

    throw new Error(`未知工具: ${name}`)

})

// --- 4. 用 stdio 传输启动 ---
const transport = new StdioServerTransport()
await server.connect(transport)
console.info("MCP Server 已启动（stdio)")