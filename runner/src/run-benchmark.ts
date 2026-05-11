import { promises as fs } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import YAML from "yaml"

type Incident = {
  id: string
  name: string
  rounds: string[]
}

type RunnerOptions = {
  model: string
  incident: string
  goosedUrl: string
  secretKey: string
  dryRun: boolean
  turnTimeoutMs: number
  maxTokens: number
  temperature: number
  contextLimit: number
  maxRounds?: number
}

type MessageContent = {
  type?: string
  text?: string
  toolCall?: {
    name?: string
    value?: {
      name?: string
    }
  }
  toolResult?: {
    status?: string
  }
}

type MessageEvent = {
  type?: string
  message?: {
    content?: MessageContent[]
  }
}

type TurnResult = {
  round: number
  user: string
  elapsedMs: number
  pingCount: number
  events: MessageEvent[]
  timedOut?: boolean
  error?: string
}

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..")
const workDir = path.join(repoRoot, "sandbox", "work")

function parseArgs(): RunnerOptions {
  const args = process.argv.slice(2)
  const valueAfter = (name: string, fallback?: string) => {
    const index = args.indexOf(name)
    return index >= 0 ? args[index + 1] : fallback
  }

  const maxRounds = valueAfter("--max-rounds")
  return {
    model: valueAfter("--model", "qwen3.5:4b")!,
    incident: valueAfter("--incident", "incident-001-deploy-failure")!,
    goosedUrl: valueAfter("--goosed-url", "http://127.0.0.1:3000")!,
    secretKey: valueAfter("--secret-key", process.env.GOOSE_SERVER__SECRET_KEY ?? "model-ops-benchmark")!,
    dryRun: args.includes("--dry-run"),
    turnTimeoutMs: Number(valueAfter("--turn-timeout-ms", "180000")),
    maxTokens: Number(valueAfter("--max-tokens", "1024")),
    temperature: Number(valueAfter("--temperature", "0.1")),
    contextLimit: Number(valueAfter("--context-limit", "65536")),
    maxRounds: maxRounds ? Number(maxRounds) : undefined
  }
}

async function copyDir(source: string, target: string) {
  await fs.rm(target, { recursive: true, force: true })
  await fs.mkdir(target, { recursive: true })
  await fs.cp(source, target, { recursive: true })
}

async function loadIncident(incidentId: string): Promise<Incident> {
  const file = path.join(repoRoot, "incidents", `${incidentId}.yaml`)
  const text = await fs.readFile(file, "utf8")
  return YAML.parse(text) as Incident
}

function extensionOverride() {
  return {
    type: "stdio",
    name: "ops-benchmark-tools",
    cmd: "node",
    args: [path.join(repoRoot, "dist", "mcp", "ops-tools", "src", "server.js")],
    envs: {
      BENCHMARK_SANDBOX: workDir
    },
    timeout: 60,
    bundled: false,
    description: "Controlled operations benchmark tools for local incident sandboxes"
  }
}

function userMessage(text: string) {
  return {
    role: "user",
    created: Math.floor(Date.now() / 1000),
    content: [
      {
        type: "text",
        text
      }
    ],
    metadata: {
      userVisible: true,
      agentVisible: true
    }
  }
}

async function goosedFetch(options: RunnerOptions, endpoint: string, body: unknown) {
  const response = await fetch(`${options.goosedUrl}${endpoint}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Secret-Key": options.secretKey
    },
    body: JSON.stringify(body)
  })
  if (!response.ok) {
    throw new Error(`${endpoint} failed: ${response.status} ${await response.text()}`)
  }
  return response
}

async function createSession(options: RunnerOptions) {
  const response = await goosedFetch(options, "/agent/start", {
    working_dir: workDir,
    extension_overrides: [extensionOverride()]
  })
  return await response.json() as { id: string }
}

async function updateProvider(options: RunnerOptions, sessionId: string) {
  await goosedFetch(options, "/agent/update_provider", {
    provider: "ollama",
    model: options.model,
    session_id: sessionId,
    context_limit: options.contextLimit,
    request_params: {
      max_tokens: options.maxTokens,
      temperature: options.temperature
    }
  })
}

async function sendTurn(options: RunnerOptions, sessionId: string, text: string) {
  const startedAt = Date.now()
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), options.turnTimeoutMs)
  const response = await fetch(`${options.goosedUrl}/reply`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Secret-Key": options.secretKey
    },
    body: JSON.stringify({
    session_id: sessionId,
    user_message: userMessage(text),
    recipe_name: null,
    recipe_version: null
    }),
    signal: controller.signal
  })
  if (!response.ok) {
    clearTimeout(timeout)
    throw new Error(`/reply failed: ${response.status} ${await response.text()}`)
  }
  if (!response.body) {
    clearTimeout(timeout)
    throw new Error("/reply did not return a response body")
  }

  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  const events: MessageEvent[] = []
  let pingCount = 0
  let buffer = ""

  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })

      let separator = buffer.indexOf("\n\n")
      while (separator >= 0) {
        const rawEvent = buffer.slice(0, separator)
        buffer = buffer.slice(separator + 2)
        for (const line of rawEvent.split(/\r?\n/)) {
          if (!line.startsWith("data:")) continue
          const payload = line.slice("data:".length).trim()
          if (!payload) continue
          const event = JSON.parse(payload) as { type?: string }
          if (event.type === "Ping") {
            pingCount += 1
            continue
          }
          events.push(event)
          if (event.type === "Finish" || event.type === "Error") {
            await reader.cancel()
            clearTimeout(timeout)
            return { elapsedMs: Date.now() - startedAt, pingCount, events }
          }
        }
        separator = buffer.indexOf("\n\n")
      }
    }
  } catch (error) {
    if ((error as Error).name === "AbortError") {
      return {
        elapsedMs: Date.now() - startedAt,
        timedOut: true,
        pingCount,
        events,
        error: `本轮超过 ${options.turnTimeoutMs}ms 后超时`
      }
    }
    throw error
  } finally {
    clearTimeout(timeout)
  }

  return { elapsedMs: Date.now() - startedAt, pingCount, events }
}

function collectTurnStats(turns: TurnResult[]) {
  let messageEvents = 0
  let finishEvents = 0
  let errorEvents = 0
  let toolRequests = 0
  let toolResponses = 0
  let successfulToolResponses = 0
  let assistantTextChars = 0
  const tools = new Set<string>()

  for (const turn of turns) {
    for (const event of turn.events) {
      if (event.type === "Message") messageEvents += 1
      if (event.type === "Finish") finishEvents += 1
      if (event.type === "Error") errorEvents += 1

      for (const content of event.message?.content ?? []) {
        if (content.type === "text") {
          assistantTextChars += content.text?.length ?? 0
        }
        if (content.type === "toolRequest") {
          toolRequests += 1
          const toolName = content.toolCall?.value?.name ?? content.toolCall?.name
          if (toolName) tools.add(toolName)
        }
        if (content.type === "toolResponse") {
          toolResponses += 1
          if (content.toolResult?.status === "success") {
            successfulToolResponses += 1
          }
        }
      }
    }
  }

  return {
    messageEvents,
    finishEvents,
    errorEvents,
    toolRequests,
    toolResponses,
    successfulToolResponses,
    assistantTextChars,
    uniqueTools: [...tools]
  }
}

function formatPercent(numerator: number, denominator: number) {
  if (denominator === 0) return "无工具调用"
  return `${((numerator / denominator) * 100).toFixed(1)}%`
}

function buildChineseReport(params: {
  incident: Incident
  options: RunnerOptions
  sessionId: string
  turns: TurnResult[]
}) {
  const { incident, options, sessionId, turns } = params
  const stats = collectTurnStats(turns)
  const elapsedMs = turns.reduce((sum, turn) => sum + turn.elapsedMs, 0)
  const timedOut = turns.some((turn) => turn.timedOut)
  const completed = stats.finishEvents > 0 && !timedOut
  const toolSuccessRate = formatPercent(stats.successfulToolResponses, stats.toolResponses)

  return `# 模型运维 Agentic 测试报告

## 基本信息

- 测试场景：${incident.id}（${incident.name}）
- 模型：${options.model}
- goosed 地址：${options.goosedUrl}
- 会话 ID：${sessionId}
- 计划轮次：${options.maxRounds ?? incident.rounds.length}
- 实际轮次：${turns.length}
- 上下文上限：${options.contextLimit}
- 最大输出 tokens：${options.maxTokens}
- 温度：${options.temperature}
- 单轮超时：${options.turnTimeoutMs}ms

## 运行结论

- 是否完成：${completed ? "是" : "否"}
- 是否超时：${timedOut ? "是" : "否"}
- 总耗时：${elapsedMs}ms
- Message 事件数：${stats.messageEvents}
- Finish 事件数：${stats.finishEvents}
- Error 事件数：${stats.errorEvents}
- 工具请求数：${stats.toolRequests}
- 工具响应数：${stats.toolResponses}
- 工具成功响应数：${stats.successfulToolResponses}
- 工具成功率：${toolSuccessRate}
- 使用过的工具：${stats.uniqueTools.length > 0 ? stats.uniqueTools.join(", ") : "无"}
- 助手文本字符数：${stats.assistantTextChars}

## 各轮明细

${turns.map((turn) => `### 第 ${turn.round} 轮

- 用户输入：${turn.user}
- 耗时：${turn.elapsedMs}ms
- 心跳数：${turn.pingCount}
- 非心跳事件数：${turn.events.length}
- 是否超时：${turn.timedOut ? "是" : "否"}
- 错误：${turn.error ?? "无"}
`).join("\n")}
`
}

async function main() {
  const options = parseArgs()
  const incident = await loadIncident(options.incident)
  const fixtureDir = path.join(repoRoot, "sandbox", "fixtures", incident.id)
  await copyDir(fixtureDir, workDir)

  const plan = {
    model: options.model,
    incident: incident.id,
    goosedUrl: options.goosedUrl,
    workDir,
    rounds: options.maxRounds ?? incident.rounds.length,
    maxTokens: options.maxTokens,
    temperature: options.temperature,
    contextLimit: options.contextLimit,
    extensionOverride: extensionOverride()
  }

  if (options.dryRun) {
    console.log(JSON.stringify(plan, null, 2))
    return
  }

  const session = await createSession(options)
  await updateProvider(options, session.id)

  const events: TurnResult[] = []
  for (const [index, round] of incident.rounds.slice(0, options.maxRounds).entries()) {
    console.error(`正在运行第 ${index + 1}/${options.maxRounds ?? incident.rounds.length} 轮`)
    const result = await sendTurn(options, session.id, round)
    events.push({ round: index + 1, user: round, ...result })
    if ("timedOut" in result && result.timedOut) break
  }

  const reportDir = path.join(repoRoot, "reports", incident.id, options.model.replace(/[:/]/g, "_"))
  await fs.mkdir(reportDir, { recursive: true })
  const reportName = `run-${Date.now()}`
  await fs.writeFile(
    path.join(reportDir, `${reportName}.json`),
    JSON.stringify({ plan, sessionId: session.id, events }, null, 2),
    "utf8"
  )
  await fs.writeFile(
    path.join(reportDir, `${reportName}.zh.md`),
    buildChineseReport({ incident, options, sessionId: session.id, turns: events }),
    "utf8"
  )
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
