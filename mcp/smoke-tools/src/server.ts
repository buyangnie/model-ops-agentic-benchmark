import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import { z } from "zod"

function jsonResult(data: Record<string, unknown>) {
  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(data)
      }
    ],
    structuredContent: data
  }
}

const server = new McpServer({
  name: "ops-benchmark-smoke-tools",
  version: "0.1.0"
})

server.tool(
  "smoke_ping",
  "Return a small fixed JSON response. Use this for goosed MCP sanity checks.",
  {
    label: z.string().describe("Short label to echo back, for example hello.")
  },
  async ({ label }) => jsonResult({ ok: true, label })
)

await server.connect(new StdioServerTransport())
