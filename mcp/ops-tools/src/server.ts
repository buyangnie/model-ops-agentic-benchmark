import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import { z } from "zod"
import { promises as fs } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import YAML from "yaml"

const fallbackRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../../sandbox/work")
const sandboxRoot = path.resolve(process.env.BENCHMARK_SANDBOX ?? fallbackRoot)

function resolveSandboxPath(relativePath: string): string {
  const normalized = path.normalize(relativePath).replace(/^(\.\.(\/|\\|$))+/, "")
  const resolved = path.resolve(sandboxRoot, normalized)
  if (!resolved.startsWith(sandboxRoot + path.sep) && resolved !== sandboxRoot) {
    throw new Error(`Path escapes benchmark sandbox: ${relativePath}`)
  }
  return resolved
}

async function readText(relativePath: string): Promise<string> {
  try {
    return await fs.readFile(resolveSandboxPath(relativePath), "utf8")
  } catch (error) {
    throw new Error(`Unable to read ${relativePath}: ${(error as Error).message}`)
  }
}

function jsonResult(data: Record<string, unknown>) {
  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(data, null, 2)
      }
    ],
    structuredContent: data
  }
}

function filterLogLines(text: string, keyword?: string, since?: string): string[] {
  const lines = text.split(/\r?\n/).filter(Boolean)
  return lines.filter((line) => {
    const matchesKeyword = keyword ? line.toLowerCase().includes(keyword.toLowerCase()) : true
    const matchesSince = since ? line.slice(0, since.length) >= since : true
    return matchesKeyword && matchesSince
  })
}

function diffLines(left: string, right: string): string[] {
  const a = left.split(/\r?\n/)
  const b = right.split(/\r?\n/)
  const max = Math.max(a.length, b.length)
  const diff: string[] = []
  for (let i = 0; i < max; i += 1) {
    if (a[i] !== b[i]) {
      if (a[i] !== undefined) diff.push(`- ${a[i]}`)
      if (b[i] !== undefined) diff.push(`+ ${b[i]}`)
    }
  }
  return diff
}

async function validateDeployFailure() {
  const apiConfigText = await readText("configs/prod/api.yaml")
  const apiConfig = YAML.parse(apiConfigText) as { port?: number }
  const passed = apiConfig.port === 3001
  return {
    incidentId: "incident-001-deploy-failure",
    passed,
    checks: [
      {
        name: "prod api port moved away from admin port 3000",
        passed,
        observed: apiConfig.port
      }
    ],
    message: passed
      ? "Validation passed. prod api now uses port 3001."
      : "Validation failed. Change configs/prod/api.yaml port from 3000 to 3001."
  }
}

const server = new McpServer({
  name: "ops-benchmark-tools",
  version: "0.1.0"
})

server.tool(
  "ops_inspect_logs",
  "Read sandbox service logs with optional keyword and time prefix filtering.",
  {
    service: z.string().describe("Service name, for example api or admin."),
    keyword: z.string().optional().describe("Optional case-insensitive keyword filter."),
    since: z.string().optional().describe("Optional timestamp prefix lower bound, for example 2026-05-11T14:30.")
  },
  async ({ service, keyword, since }) => {
    const text = await readText(`logs/${service}.log`)
    const lines = filterLogLines(text, keyword, since)
    return jsonResult({ service, keyword, since, lineCount: lines.length, lines })
  }
)

server.tool(
  "ops_read_config",
  "Read one sandbox service config file.",
  {
    env: z.string().describe("Environment name, for example prod or staging."),
    service: z.string().describe("Service name, for example api or admin.")
  },
  async ({ env, service }) => {
    const relativePath = `configs/${env}/${service}.yaml`
    const text = await readText(relativePath)
    return jsonResult({ path: relativePath, config: YAML.parse(text), text })
  }
)

server.tool(
  "ops_diff_config",
  "Compare one service config between two sandbox environments.",
  {
    service: z.string().describe("Service name, for example api."),
    envA: z.string().describe("Left environment name."),
    envB: z.string().describe("Right environment name.")
  },
  async ({ service, envA, envB }) => {
    const pathA = `configs/${envA}/${service}.yaml`
    const pathB = `configs/${envB}/${service}.yaml`
    const left = await readText(pathA)
    const right = await readText(pathB)
    return jsonResult({ service, envA, envB, diff: diffLines(left, right) })
  }
)

server.tool(
  "ops_run_health_check",
  "Read sandbox health state for a service.",
  {
    service: z.string().describe("Service name, for example api or admin.")
  },
  async ({ service }) => {
    const text = await readText(`health/${service}.json`)
    return jsonResult(JSON.parse(text) as Record<string, unknown>)
  }
)

server.tool(
  "ops_search_runbook",
  "Search sandbox runbook files for operational guidance.",
  {
    query: z.string().describe("Case-insensitive search query.")
  },
  async ({ query }) => {
    const runbookDir = resolveSandboxPath("runbooks")
    const entries = await fs.readdir(runbookDir)
    const matches: Array<{ file: string; lines: string[] }> = []
    for (const entry of entries) {
      if (!entry.endsWith(".md")) continue
      const text = await fs.readFile(path.join(runbookDir, entry), "utf8")
      const lines = filterLogLines(text, query)
      if (lines.length > 0) matches.push({ file: entry, lines })
    }
    return jsonResult({ query, matches })
  }
)

server.tool(
  "ops_safe_edit_config",
  "Apply exact string replacements to a sandbox config file. This tool cannot access files outside the sandbox.",
  {
    relativePath: z.string().describe("Sandbox-relative config path, for example configs/prod/api.yaml."),
    replacements: z.array(z.object({
      from: z.string().describe("Exact text to replace."),
      to: z.string().describe("Replacement text.")
    })).min(1)
  },
  async ({ relativePath, replacements }) => {
    const target = resolveSandboxPath(relativePath)
    let text = await fs.readFile(target, "utf8")
    const applied: Array<{ from: string; to: string; count: number }> = []
    for (const replacement of replacements) {
      const count = text.split(replacement.from).length - 1
      if (count === 0) {
        throw new Error(`Replacement text not found in ${relativePath}: ${replacement.from}`)
      }
      text = text.split(replacement.from).join(replacement.to)
      applied.push({ ...replacement, count })
    }
    await fs.writeFile(target, text, "utf8")
    return jsonResult({ path: relativePath, applied })
  }
)

server.tool(
  "ops_validate_fix",
  "Run the sandbox validator for an incident.",
  {
    incidentId: z.string().describe("Incident id, for example incident-001-deploy-failure.")
  },
  async ({ incidentId }) => {
    if (incidentId !== "incident-001-deploy-failure") {
      throw new Error(`Unknown validator for incident: ${incidentId}`)
    }
    return jsonResult(await validateDeployFailure())
  }
)

await server.connect(new StdioServerTransport())
