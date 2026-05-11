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
  maxRounds?: number
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
    context_limit: 8192,
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
  const events: unknown[] = []
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
        error: `turn timed out after ${options.turnTimeoutMs}ms`
      }
    }
    throw error
  } finally {
    clearTimeout(timeout)
  }

  return { elapsedMs: Date.now() - startedAt, pingCount, events }
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
    extensionOverride: extensionOverride()
  }

  if (options.dryRun) {
    console.log(JSON.stringify(plan, null, 2))
    return
  }

  const session = await createSession(options)
  await updateProvider(options, session.id)

  const events = []
  for (const [index, round] of incident.rounds.slice(0, options.maxRounds).entries()) {
    console.error(`running round ${index + 1}/${options.maxRounds ?? incident.rounds.length}`)
    const result = await sendTurn(options, session.id, round)
    events.push({ round: index + 1, user: round, ...result })
    if ("timedOut" in result && result.timedOut) break
  }

  const reportDir = path.join(repoRoot, "reports", incident.id, options.model.replace(/[:/]/g, "_"))
  await fs.mkdir(reportDir, { recursive: true })
  await fs.writeFile(
    path.join(reportDir, `run-${Date.now()}.json`),
    JSON.stringify({ plan, sessionId: session.id, events }, null, 2),
    "utf8"
  )
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
