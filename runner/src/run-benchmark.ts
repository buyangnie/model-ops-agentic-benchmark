import { promises as fs } from "node:fs"
import crypto from "node:crypto"
import path from "node:path"
import { fileURLToPath } from "node:url"
import YAML from "yaml"

type Incident = {
  id: string
  name: string
  fixture?: string
  rounds: string[]
  success?: SuccessSpec
}

type SuccessSpec = {
  expectedTickets?: Array<{
    ticketId: string
    status?: string
    nextAction?: string
    assigneeId?: string
    knowledgeCreated?: boolean
  }>
  expectedComments?: Array<{ ticketId: string; commentType: string }>
  expectedOutbox?: Array<{ ticketId: string; messageType: string }>
  expectedTodos?: Array<{ ticketId: string; reasonCode: string }>
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
  extensionMode: "ticket" | "none"
  ollamaStreamUsage?: boolean
  provider: string
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
  chat_request_id?: string
  request_id?: string
}

type TurnResult = {
  round: number
  user: string
  elapsedMs: number
  firstEventMs?: number
  firstMessageMs?: number
  firstToolRequestMs?: number
  firstToolResponseMs?: number
  pingCount: number
  events: MessageEvent[]
  timedOut?: boolean
  error?: string
}

type SuccessCheck = {
  name: string
  passed: boolean
  expected: unknown
  observed: unknown
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
  const streamUsage = valueAfter("--ollama-stream-usage")
  return {
    model: valueAfter("--model", "qwen3.5:9b-32k-harness")!,
    incident: valueAfter("--incident", "fo-ticket-dispatch-single")!,
    goosedUrl: valueAfter("--goosed-url", "http://127.0.0.1:3000")!,
    secretKey: valueAfter("--secret-key", process.env.GOOSE_SERVER__SECRET_KEY ?? "model-ops-benchmark")!,
    dryRun: args.includes("--dry-run"),
    turnTimeoutMs: Number(valueAfter("--turn-timeout-ms", "240000")),
    maxTokens: Number(valueAfter("--max-tokens", "1024")),
    temperature: Number(valueAfter("--temperature", "0")),
    contextLimit: Number(valueAfter("--context-limit", "32768")),
    extensionMode: valueAfter("--extension-mode", "ticket") as RunnerOptions["extensionMode"],
    ollamaStreamUsage: streamUsage === undefined ? undefined : streamUsage === "true",
    provider: valueAfter("--provider", "custom_ollama_local")!,
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

function extensionOverride(options: RunnerOptions) {
  if (options.extensionMode === "none") return []
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

async function goosedFetch(options: RunnerOptions, endpoint: string, body: unknown, method = "POST") {
  const response = await fetch(`${options.goosedUrl}${endpoint}`, {
    method,
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
    extension_overrides: options.extensionMode === "ticket" ? [extensionOverride(options)] : extensionOverride(options)
  })
  const session = await response.json() as { id: string }
  await goosedFetch(options, `/sessions/${session.id}/name`, {
    name: `benchmark ${options.incident} ${options.model}`
  }, "PUT")
  return session
}

async function updateProvider(options: RunnerOptions, sessionId: string) {
  const requestParams: Record<string, unknown> = {
    max_tokens: options.maxTokens,
    temperature: options.temperature
  }
  if (options.ollamaStreamUsage === false) {
    requestParams.stream_options = null
  }
  await goosedFetch(options, "/agent/update_provider", {
    provider: options.provider,
    model: options.model,
    session_id: sessionId,
    context_limit: options.contextLimit,
    request_params: requestParams
  })
}

async function cancelTurn(options: RunnerOptions, sessionId: string, requestId: string) {
  try {
    await goosedFetch(options, `/sessions/${sessionId}/cancel`, { request_id: requestId })
  } catch {
    // Best-effort cleanup. The timeout result remains the source of truth.
  }
}

async function sendTurn(options: RunnerOptions, sessionId: string, text: string) {
  const startedAt = Date.now()
  const eventsResponse = await fetch(`${options.goosedUrl}/sessions/${sessionId}/events`, {
    headers: {
      "X-Secret-Key": options.secretKey
    }
  })
  if (!eventsResponse.ok) {
    throw new Error(`/sessions/${sessionId}/events failed: ${eventsResponse.status} ${await eventsResponse.text()}`)
  }
  if (!eventsResponse.body) {
    throw new Error("/events did not return a response body")
  }

  const requestId = crypto.randomUUID()
  const response = await fetch(`${options.goosedUrl}/sessions/${sessionId}/reply`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Secret-Key": options.secretKey
    },
    body: JSON.stringify({
      request_id: requestId,
      user_message: userMessage(text)
    })
  })
  if (!response.ok) {
    await eventsResponse.body.cancel()
    throw new Error(`/sessions/${sessionId}/reply failed: ${response.status} ${await response.text()}`)
  }

  const reader = eventsResponse.body.getReader()
  const decoder = new TextDecoder()
  const events: MessageEvent[] = []
  let pingCount = 0
  let buffer = ""
  let firstEventMs: number | undefined
  let firstMessageMs: number | undefined
  let firstToolRequestMs: number | undefined
  let firstToolResponseMs: number | undefined

  const markContentLatency = (event: MessageEvent) => {
    const elapsed = Date.now() - startedAt
    if (event.type === "Message" && firstMessageMs === undefined) firstMessageMs = elapsed
    for (const content of event.message?.content ?? []) {
      if (content.type === "toolRequest" && firstToolRequestMs === undefined) firstToolRequestMs = elapsed
      if (content.type === "toolResponse" && firstToolResponseMs === undefined) firstToolResponseMs = elapsed
    }
  }

  const buildResult = (extra?: Partial<TurnResult>) => ({
    elapsedMs: Date.now() - startedAt,
    firstEventMs,
    firstMessageMs,
    firstToolRequestMs,
    firstToolResponseMs,
    pingCount,
    events,
    ...extra
  })

  try {
    while (true) {
      const remainingMs = options.turnTimeoutMs - (Date.now() - startedAt)
      if (remainingMs <= 0) {
        await reader.cancel()
        await cancelTurn(options, sessionId, requestId)
        return buildResult({
          timedOut: true,
          elapsedMs: options.turnTimeoutMs,
          error: `本轮超过 ${options.turnTimeoutMs}ms 后超时`
        })
      }
      const readResult = await Promise.race([
        reader.read(),
        new Promise<{ timeout: true }>((resolve) => setTimeout(() => resolve({ timeout: true }), remainingMs))
      ])
      if ("timeout" in readResult) {
        await reader.cancel()
        await cancelTurn(options, sessionId, requestId)
        return buildResult({
          timedOut: true,
          elapsedMs: options.turnTimeoutMs,
          error: `本轮超过 ${options.turnTimeoutMs}ms 后超时`
        })
      }
      const { done, value } = readResult
      if (done) break
      buffer += decoder.decode(value, { stream: true })

      let separator = buffer.indexOf("\n\n")
      while (separator >= 0) {
        const rawEvent = buffer.slice(0, separator)
        buffer = buffer.slice(separator + 2)
        if (rawEvent.startsWith(":")) {
          pingCount += 1
          separator = buffer.indexOf("\n\n")
          continue
        }
        for (const line of rawEvent.split(/\r?\n/)) {
          if (!line.startsWith("data:")) continue
          const payload = line.slice("data:".length).trim()
          if (!payload) continue
          const event = JSON.parse(payload) as { type?: string }
          if (event.type === "Ping") {
            pingCount += 1
            continue
          }
          const messageEvent = event as MessageEvent
          if (messageEvent.chat_request_id && messageEvent.chat_request_id !== requestId) {
            continue
          }
          if (firstEventMs === undefined) firstEventMs = Date.now() - startedAt
          events.push(event)
          markContentLatency(messageEvent)
          if (event.type === "Finish" || event.type === "Error") {
            await reader.cancel()
            return buildResult()
          }
        }
        separator = buffer.indexOf("\n\n")
      }
    }
  } catch (error) {
    if ((error as Error).name === "AbortError") {
      await cancelTurn(options, sessionId, requestId)
      return buildResult({
        timedOut: true,
        error: `本轮超过 ${options.turnTimeoutMs}ms 后超时`
      })
    }
    throw error
  }

  return buildResult()
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

function collectSingleTurnStats(turn: TurnResult) {
  return collectTurnStats([turn])
}

function formatPercent(numerator: number, denominator: number) {
  if (denominator === 0) return "无工具调用"
  return `${((numerator / denominator) * 100).toFixed(1)}%`
}

function formatMs(value?: number) {
  return value === undefined ? "无" : `${value}ms`
}

function estimateCharsPerSecond(chars: number, elapsedMs: number) {
  if (elapsedMs <= 0) return "无"
  return `${((chars / elapsedMs) * 1000).toFixed(1)} 字符/秒`
}

async function readFinalState(): Promise<Record<string, unknown> | undefined> {
  try {
    return JSON.parse(await fs.readFile(path.join(workDir, "ticket-state.json"), "utf8")) as Record<string, unknown>
  } catch {
    return undefined
  }
}

function includesObject(items: unknown, expected: Record<string, unknown>) {
  if (!Array.isArray(items)) return undefined
  return items.find((item) => {
    if (!item || typeof item !== "object") return false
    const record = item as Record<string, unknown>
    return Object.entries(expected).every(([key, value]) => record[key] === value)
  })
}

function evaluateSuccess(incident: Incident, state?: Record<string, unknown>): SuccessCheck[] {
  if (!incident.success || !state) return []
  const checks: SuccessCheck[] = []
  const tickets = Array.isArray(state.tickets) ? state.tickets as Array<Record<string, unknown>> : []

  for (const expected of incident.success.expectedTickets ?? []) {
    const ticket = tickets.find((item) => item.id === expected.ticketId)
    const observed = ticket
      ? Object.fromEntries(Object.keys(expected).map((key) => [key, ticket[key]]))
      : undefined
    const passed = ticket !== undefined
      && (expected.status === undefined || ticket.status === expected.status)
      && (expected.nextAction === undefined || ticket.nextAction === expected.nextAction)
      && (expected.assigneeId === undefined || ticket.assigneeId === expected.assigneeId)
      && (expected.knowledgeCreated === undefined || ticket.knowledgeCreated === expected.knowledgeCreated)
    checks.push({ name: `工单状态 ${expected.ticketId}`, passed, expected, observed })
  }

  for (const expected of incident.success.expectedComments ?? []) {
    const observed = includesObject(state.comments, expected)
    checks.push({ name: `工单备注 ${expected.ticketId}/${expected.commentType}`, passed: Boolean(observed), expected, observed })
  }

  for (const expected of incident.success.expectedOutbox ?? []) {
    const observed = includesObject(state.outbox, expected)
    checks.push({ name: `待发送消息 ${expected.ticketId}/${expected.messageType}`, passed: Boolean(observed), expected, observed })
  }

  for (const expected of incident.success.expectedTodos ?? []) {
    const observed = includesObject(state.todos, expected)
    checks.push({ name: `跟进任务 ${expected.ticketId}/${expected.reasonCode}`, passed: Boolean(observed), expected, observed })
  }

  return checks
}

function buildChineseReport(params: {
  incident: Incident
  options: RunnerOptions
  sessionId: string
  turns: TurnResult[]
  successChecks: SuccessCheck[]
}) {
  const { incident, options, sessionId, turns, successChecks } = params
  const stats = collectTurnStats(turns)
  const elapsedMs = turns.reduce((sum, turn) => sum + turn.elapsedMs, 0)
  const timedOut = turns.some((turn) => turn.timedOut)
  const successPassed = successChecks.length > 0 && successChecks.every((check) => check.passed)
  const completed = stats.finishEvents >= turns.length && !timedOut && (successChecks.length === 0 || successPassed)
  const toolSuccessRate = formatPercent(stats.successfulToolResponses, stats.toolResponses)
  const firstMessageValues = turns.map((turn) => turn.firstMessageMs).filter((value): value is number => value !== undefined)
  const firstToolValues = turns.map((turn) => turn.firstToolRequestMs).filter((value): value is number => value !== undefined)
  const avgFirstMessage = firstMessageValues.length > 0
    ? Math.round(firstMessageValues.reduce((sum, value) => sum + value, 0) / firstMessageValues.length)
    : undefined
  const avgFirstTool = firstToolValues.length > 0
    ? Math.round(firstToolValues.reduce((sum, value) => sum + value, 0) / firstToolValues.length)
    : undefined

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
- 最终状态校验：${successChecks.length === 0 ? "无校验项" : successPassed ? "通过" : "未通过"}
- 是否超时：${timedOut ? "是" : "否"}
- 总耗时：${elapsedMs}ms
- 首个 Message 平均延迟：${formatMs(avgFirstMessage)}
- 首个工具调用平均延迟：${formatMs(avgFirstTool)}
- 近似文本吞吐：${estimateCharsPerSecond(stats.assistantTextChars, elapsedMs)}
- Message 事件数：${stats.messageEvents}
- Finish 事件数：${stats.finishEvents}
- Error 事件数：${stats.errorEvents}
- 工具请求数：${stats.toolRequests}
- 工具响应数：${stats.toolResponses}
- 工具成功响应数：${stats.successfulToolResponses}
- 工具成功率：${toolSuccessRate}
- 使用过的工具：${stats.uniqueTools.length > 0 ? stats.uniqueTools.join(", ") : "无"}
- 助手文本字符数：${stats.assistantTextChars}

## 最终状态校验

${successChecks.length === 0 ? "无。": successChecks.map((check) => `- ${check.passed ? "通过" : "失败"}：${check.name}`).join("\n")}

## 各轮明细

${turns.map((turn) => `### 第 ${turn.round} 轮

- 用户输入：${turn.user}
- 耗时：${turn.elapsedMs}ms
- 首个 Message 延迟：${formatMs(turn.firstMessageMs)}
- 首个工具调用延迟：${formatMs(turn.firstToolRequestMs)}
- 首个工具响应延迟：${formatMs(turn.firstToolResponseMs)}
- 心跳数：${turn.pingCount}
- 非心跳事件数：${turn.events.length}
- 工具请求数：${collectSingleTurnStats(turn).toolRequests}
- 工具响应数：${collectSingleTurnStats(turn).toolResponses}
- 是否超过 5 次工具调用：${collectSingleTurnStats(turn).toolRequests > 5 ? "是" : "否"}
- 是否超时：${turn.timedOut ? "是" : "否"}
- 错误：${turn.error ?? "无"}
`).join("\n")}
`
}

async function main() {
  const options = parseArgs()
  const incident = await loadIncident(options.incident)
  const fixtureDir = path.join(repoRoot, "sandbox", "fixtures", incident.fixture ?? incident.id)
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
    extensionMode: options.extensionMode,
    extensionOverride: options.extensionMode === "ticket" ? [extensionOverride(options)] : extensionOverride(options)
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
  const finalState = await readFinalState()
  const successChecks = evaluateSuccess(incident, finalState)
  await fs.writeFile(
    path.join(reportDir, `${reportName}.json`),
    JSON.stringify({ plan, sessionId: session.id, events, finalState, successChecks }, null, 2),
    "utf8"
  )
  await fs.writeFile(
    path.join(reportDir, `${reportName}.zh.md`),
    buildChineseReport({ incident, options, sessionId: session.id, turns: events, successChecks }),
    "utf8"
  )
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
