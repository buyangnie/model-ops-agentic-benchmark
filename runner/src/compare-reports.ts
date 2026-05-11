import { promises as fs } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

type TurnResult = {
  elapsedMs: number
  firstMessageMs?: number
  firstToolRequestMs?: number
  timedOut?: boolean
  events: Array<{
    type?: string
    message?: {
      content?: Array<{
        type?: string
        text?: string
        toolResult?: { status?: string }
      }>
    }
  }>
}

type RunReport = {
  plan: {
    model: string
    incident: string
  }
  events: TurnResult[]
  successChecks?: Array<{ passed: boolean }>
}

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..")
const reportsRoot = path.join(repoRoot, "reports")

function parseArgs() {
  const args = process.argv.slice(2)
  const valueAfter = (name: string, fallback?: string) => {
    const index = args.indexOf(name)
    return index >= 0 ? args[index + 1] : fallback
  }
  return {
    models: valueAfter("--models", "qwen3.5:4b-64k,qwen3.5:9b-64k")!.split(","),
    incidents: valueAfter("--incidents", "fo-ticket-intake-2round,fo-ticket-dispatch-2round,fo-ticket-followup-2round,fo-ticket-closure-2round")!.split(","),
    output: valueAfter("--output", path.join(reportsRoot, "comparison-fo-ticket.zh.md"))!
  }
}

function modelDirName(model: string) {
  return model.replace(/[:/]/g, "_")
}

async function latestRun(incident: string, model: string): Promise<RunReport | undefined> {
  const dir = path.join(reportsRoot, incident, modelDirName(model))
  try {
    const entries = (await fs.readdir(dir))
      .filter((entry) => entry.endsWith(".json"))
      .sort()
    const latest = entries.at(-1)
    if (!latest) return undefined
    return JSON.parse(await fs.readFile(path.join(dir, latest), "utf8")) as RunReport
  } catch {
    return undefined
  }
}

function collect(run: RunReport) {
  let toolResponses = 0
  let successfulToolResponses = 0
  let toolRequests = 0
  let assistantTextChars = 0
  const elapsedMs = run.events.reduce((sum, turn) => sum + normalizedElapsedMs(turn), 0)
  const timedOut = run.events.some((turn) => turn.timedOut)
  const firstMessage = run.events.map((turn) => turn.firstMessageMs).filter((item): item is number => item !== undefined)
  const firstTool = run.events.map((turn) => turn.firstToolRequestMs).filter((item): item is number => item !== undefined)

  for (const turn of run.events) {
    for (const event of turn.events) {
      for (const content of event.message?.content ?? []) {
        if (content.type === "text") assistantTextChars += content.text?.length ?? 0
        if (content.type === "toolRequest") toolRequests += 1
        if (content.type === "toolResponse") {
          toolResponses += 1
          if (content.toolResult?.status === "success") successfulToolResponses += 1
        }
      }
    }
  }

  const checks = run.successChecks ?? []
  const statePassed = checks.length > 0 && checks.every((check) => check.passed)
  const finished = run.events.length > 0 && run.events.every((turn) => turn.events.some((event) => event.type === "Finish"))
  return {
    elapsedMs,
    timedOut,
    rounds: run.events.length,
    finished,
    statePassed,
    toolRequests,
    toolResponses,
    successfulToolResponses,
    toolSuccessRate: toolResponses === 0 ? 0 : successfulToolResponses / toolResponses,
    avgFirstMessageMs: firstMessage.length === 0 ? undefined : Math.round(firstMessage.reduce((sum, item) => sum + item, 0) / firstMessage.length),
    avgFirstToolMs: firstTool.length === 0 ? undefined : Math.round(firstTool.reduce((sum, item) => sum + item, 0) / firstTool.length),
    charsPerSecond: elapsedMs <= 0 ? 0 : (assistantTextChars / elapsedMs) * 1000
  }
}

function normalizedElapsedMs(turn: TurnResult) {
  if (!turn.timedOut) return turn.elapsedMs
  return Math.min(turn.elapsedMs, 180000)
}

function percent(value: number) {
  return `${(value * 100).toFixed(1)}%`
}

function ms(value?: number) {
  return value === undefined ? "无" : `${value}ms`
}

async function main() {
  const options = parseArgs()
  const rows: string[] = []
  const summaries: Record<string, ReturnType<typeof collect>[]> = {}

  for (const incident of options.incidents) {
    for (const model of options.models) {
      const run = await latestRun(incident, model)
      if (!run) {
        rows.push(`| ${incident} | ${model} | 未运行 | - | - | - | - | - | - | - |`)
        continue
      }
      const stats = collect(run)
      summaries[model] = summaries[model] ?? []
      summaries[model].push(stats)
      rows.push(`| ${incident} | ${model} | ${stats.finished && stats.statePassed && !stats.timedOut ? "通过" : "未通过"} | ${stats.rounds} | ${stats.elapsedMs}ms | ${ms(stats.avgFirstMessageMs)} | ${ms(stats.avgFirstToolMs)} | ${stats.toolRequests}/${stats.toolResponses} | ${percent(stats.toolSuccessRate)} | ${stats.charsPerSecond.toFixed(1)} 字符/秒 |`)
    }
  }

  const modelLines = options.models.map((model) => {
    const items = summaries[model] ?? []
    const passed = items.filter((item) => item.finished && item.statePassed && !item.timedOut).length
    const toolResponses = items.reduce((sum, item) => sum + item.toolResponses, 0)
    const toolSuccess = items.reduce((sum, item) => sum + item.successfulToolResponses, 0)
    const elapsed = items.reduce((sum, item) => sum + item.elapsedMs, 0)
    const cps = items.length === 0 ? 0 : items.reduce((sum, item) => sum + item.charsPerSecond, 0) / items.length
    const avgFirstToolValues = items.map((item) => item.avgFirstToolMs).filter((item): item is number => item !== undefined)
    const avgFirstTool = avgFirstToolValues.length === 0
      ? undefined
      : Math.round(avgFirstToolValues.reduce((sum, item) => sum + item, 0) / avgFirstToolValues.length)
    return `| ${model} | ${passed}/${items.length} | ${percent(toolResponses === 0 ? 0 : toolSuccess / toolResponses)} | ${elapsed}ms | ${ms(avgFirstTool)} | ${cps.toFixed(1)} 字符/秒 |`
  })
  const allSummaries = Object.values(summaries).flat()
  const passedCount = allSummaries.filter((item) => item.finished && item.statePassed && !item.timedOut).length
  const conclusion = passedCount === 0
    ? "本轮 16K/32K 单轮测试没有任何模型通过最低可用线；qwen3.5:4b 和 qwen3.5:9b 在当前本机 goosed 工单 agentic 场景下均不可用。"
    : "本轮存在模型通过最低可用线，优先比较通过场景数、工具成功率和首工具延迟。"

  const report = `# FO Copilot 工单 Agentic 模型对比报告

## 测试目标

本报告用于选择适合 goosed agentic 场景的最小本地模型。测试目标不是压倒模型，而是验证模型在可 harness 的工单工具链中是否达到可用底线，并观察 4B 与 9B 在成功率、工具成功率和性能上的取舍。

## Harness 约束

- 所有场景通过 goosed agent 跑通，不直接调用模型接口。
- 模型逐个测试，不并行运行。
- 本轮测试使用 16K 和 32K 两档上下文；8K 不作为选型依据。
- 每个场景 1 轮，每轮最多 5 次工具调用。
- MCP 工具覆盖 intake、派单、跟进、no-action、关闭、知识沉淀，但入参只使用 ticketId、固定枚举和简单 ID。
- 提示词使用短指令、明确工具序列和固定枚举，降低 tiny LLM 在复杂规划和复杂 schema 上的消耗。
- 单轮 180 秒内没有完成并产生最终状态校验，即判定该场景失败。

## 模型汇总

${conclusion}

| 模型 | 通过场景 | 工具成功率 | 总耗时 | 平均首工具延迟 | 近似文本吞吐 |
| --- | ---: | ---: | ---: | ---: | ---: |
${modelLines.join("\n")}

## 场景明细

| 场景 | 模型 | 结果 | 轮次 | 耗时 | 首 Message 延迟 | 首工具延迟 | 工具请求/响应 | 工具成功率 | 近似文本吞吐 |
| --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
${rows.join("\n")}

## 选型判断口径

- 若 4B 通过大多数场景，且工具成功率接近 9B，可优先选 4B，并继续用短提示词、枚举入参、两步任务拆分来 harness。
- 若 4B 在最终状态校验上频繁失败，而 9B 稳定通过，则 9B 是 goosed 工单 agentic 场景的最小可用模型。
- 若 16K 和 32K 下都不能完成单轮最多 5 次工具调用，则该模型在当前本机 goosed 工单 agentic 场景下不可用。
`

  await fs.mkdir(path.dirname(options.output), { recursive: true })
  await fs.writeFile(options.output, report, "utf8")
  console.log(options.output)
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
