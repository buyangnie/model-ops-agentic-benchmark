import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import { z } from "zod"
import { promises as fs } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

type TicketStatus =
  | "new"
  | "queued"
  | "in_progress"
  | "waiting_user"
  | "pending_validation"
  | "resolved"
  | "closed"

type Ticket = {
  id: string
  title: string
  service: string
  priority: "P1" | "P2" | "P3"
  status: TicketStatus
  assigneeId?: string
  requesterId?: string
  ageHours: number
  summary: string
  recommendedAssigneeId?: string
  nextAction: "dispatch" | "ask_user" | "remind_assignee" | "validate" | "close_with_knowledge" | "no_action"
  knowledgeCreated?: boolean
}

type IncomingRequest = {
  id: string
  title: string
  service: string
  priority: "P1" | "P2" | "P3"
  requesterId: string
  summary: string
  recommendedAssigneeId: string
}

type Person = {
  id: string
  name: string
  team: string
  services: string[]
  onCall: boolean
}

type BenchmarkState = {
  incomingRequests: IncomingRequest[]
  tickets: Ticket[]
  people: Person[]
  comments: Array<{ ticketId: string; commentType: string; text: string }>
  outbox: Array<{ ticketId: string; messageType: string; text: string }>
  todos: Array<{ ticketId: string; reasonCode: string; owner: string }>
  knowledge: Array<{ id: string; service: string; title: string; ticketId?: string }>
}

const fallbackRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../../sandbox/work")
const sandboxRoot = path.resolve(process.env.BENCHMARK_SANDBOX ?? fallbackRoot)
const statePath = path.join(sandboxRoot, "ticket-state.json")

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

async function readState(): Promise<BenchmarkState> {
  try {
    return JSON.parse(await fs.readFile(statePath, "utf8")) as BenchmarkState
  } catch (error) {
    throw new Error(`无法读取工单测试状态 ticket-state.json：${(error as Error).message}`)
  }
}

async function writeState(state: BenchmarkState) {
  await fs.writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`, "utf8")
}

function findTicket(state: BenchmarkState, ticketId: string): Ticket {
  const ticket = state.tickets.find((item) => item.id === ticketId)
  if (!ticket) {
    throw new Error(`找不到工单 ${ticketId}。请先调用 ticket_list_watch 或 ticket_get 获取有效 ticketId。`)
  }
  return ticket
}

function summarizeTicket(ticket: Ticket) {
  return {
    id: ticket.id,
    title: ticket.title,
    service: ticket.service,
    priority: ticket.priority,
    status: ticket.status,
    assigneeId: ticket.assigneeId ?? null,
    ageHours: ticket.ageHours,
    nextAction: ticket.nextAction,
    summary: ticket.summary
  }
}

function ticketComment(ticket: Ticket, commentType: string): string {
  const templates: Record<string, string> = {
    triage_summary: `已完成初步分诊：${ticket.service}，优先级 ${ticket.priority}，建议动作 ${ticket.nextAction}。`,
    assignment_note: `已派给 ${ticket.assigneeId ?? ticket.recommendedAssigneeId ?? "待定处理人"}，请继续处理。`,
    followup_note: `已根据当前状态执行跟进动作：${ticket.nextAction}。`,
    closure_summary: `已完成关闭检查并沉淀知识：${ticket.title}。`
  }
  return templates[commentType] ?? `已记录 ${commentType}。`
}

const server = new McpServer({
  name: "ops-benchmark-ticket-tools",
  version: "0.2.0"
})

server.tool(
  "ticket_list_watch",
  "列出当前需要 FO Copilot 关注的工单。无需入参。",
  {},
  async () => {
    const state = await readState()
    return jsonResult({
      tickets: state.tickets
        .filter((ticket) => ticket.nextAction !== "no_action")
        .map(summarizeTicket)
    })
  }
)

server.tool(
  "ticket_get",
  "读取一个工单的摘要、状态和建议动作。",
  { ticketId: z.string().describe("工单号，例如 INC-1001。") },
  async ({ ticketId }) => {
    const state = await readState()
    return jsonResult({ ticket: summarizeTicket(findTicket(state, ticketId)) })
  }
)

server.tool(
  "ticket_get_timeline",
  "读取工单时间线摘要，用于判断是否可关闭或是否需要跟进。",
  { ticketId: z.string().describe("工单号，例如 INC-1005。") },
  async ({ ticketId }) => {
    const state = await readState()
    const ticket = findTicket(state, ticketId)
    return jsonResult({
      ticketId,
      timeline: [
        `${ticket.ageHours}h ago: 工单创建，服务=${ticket.service}，优先级=${ticket.priority}`,
        ticket.assigneeId ? `已分派给 ${ticket.assigneeId}` : "尚未分派",
        `当前状态=${ticket.status}，建议动作=${ticket.nextAction}`
      ]
    })
  }
)

server.tool(
  "ticket_create_from_request",
  "从预置的客户请求创建工单。入参只需要 requestId。",
  { requestId: z.string().describe("请求号，例如 REQ-2001。") },
  async ({ requestId }) => {
    const state = await readState()
    const request = state.incomingRequests.find((item) => item.id === requestId)
    if (!request) {
      throw new Error(`找不到请求 ${requestId}。可用请求：${state.incomingRequests.map((item) => item.id).join(", ")}`)
    }
    const existing = state.tickets.find((ticket) => ticket.requesterId === request.requesterId && ticket.title === request.title)
    if (existing) return jsonResult({ ticket: summarizeTicket(existing), created: false })

    const ticket: Ticket = {
      id: `INC-${1000 + state.tickets.length + 1}`,
      title: request.title,
      service: request.service,
      priority: request.priority,
      status: "new",
      requesterId: request.requesterId,
      ageHours: 0,
      summary: request.summary,
      recommendedAssigneeId: request.recommendedAssigneeId,
      nextAction: "dispatch"
    }
    state.tickets.push(ticket)
    await writeState(state)
    return jsonResult({ ticket: summarizeTicket(ticket), created: true })
  }
)

server.tool(
  "ticket_enrich",
  "自动补充工单上下文。入参只需要 ticketId。",
  { ticketId: z.string().describe("工单号。") },
  async ({ ticketId }) => {
    const state = await readState()
    const ticket = findTicket(state, ticketId)
    return jsonResult({
      ticketId,
      enrichment: {
        serviceOwnerTeam: `${ticket.service}-ops`,
        suggestedPriority: ticket.priority,
        recommendedAssigneeId: ticket.recommendedAssigneeId ?? null,
        nextAction: ticket.nextAction
      }
    })
  }
)

server.tool(
  "people_list_candidates",
  "列出某工单的候选处理人。",
  { ticketId: z.string().describe("工单号。") },
  async ({ ticketId }) => {
    const state = await readState()
    const ticket = findTicket(state, ticketId)
    return jsonResult({
      ticketId,
      candidates: state.people
        .filter((person) => person.services.includes(ticket.service))
        .map((person) => ({
          id: person.id,
          name: person.name,
          team: person.team,
          onCall: person.onCall,
          recommended: person.id === ticket.recommendedAssigneeId
        }))
    })
  }
)

server.tool(
  "ticket_assign",
  "给工单分派处理人。只需要 ticketId 和 assigneeId。",
  {
    ticketId: z.string().describe("工单号。"),
    assigneeId: z.string().describe("候选处理人 ID，例如 u-network。")
  },
  async ({ ticketId, assigneeId }) => {
    const state = await readState()
    const ticket = findTicket(state, ticketId)
    const person = state.people.find((item) => item.id === assigneeId)
    if (!person) throw new Error(`找不到处理人 ${assigneeId}。请先调用 people_list_candidates。`)
    ticket.assigneeId = assigneeId
    ticket.status = "queued"
    ticket.nextAction = "no_action"
    await writeState(state)
    return jsonResult({ ticket: summarizeTicket(ticket), assignedTo: person.name })
  }
)

server.tool(
  "ticket_next_action",
  "判断工单下一步动作，返回固定动作码。",
  { ticketId: z.string().describe("工单号。") },
  async ({ ticketId }) => {
    const state = await readState()
    const ticket = findTicket(state, ticketId)
    return jsonResult({
      ticketId,
      action: ticket.nextAction,
      reason:
        ticket.nextAction === "no_action"
          ? "工单还没有达到主动跟进条件。"
          : `当前状态 ${ticket.status} 需要执行 ${ticket.nextAction}。`
    })
  }
)

server.tool(
  "outbox_prepare_message",
  "生成一条待发送消息。messageType 只能用固定枚举。",
  {
    ticketId: z.string().describe("工单号。"),
    messageType: z.enum(["ask_user", "remind_assignee", "validation_request", "closure_notice"])
  },
  async ({ ticketId, messageType }) => {
    const state = await readState()
    const ticket = findTicket(state, ticketId)
    const textByType: Record<string, string> = {
      ask_user: `请补充 ${ticket.title} 的影响范围和复现时间。`,
      remind_assignee: `请处理 ${ticket.title}，当前已等待 ${ticket.ageHours} 小时。`,
      validation_request: `请验证 ${ticket.title} 是否已恢复。`,
      closure_notice: `${ticket.title} 已完成处理，准备关闭。`
    }
    const message = { ticketId, messageType, text: textByType[messageType] }
    state.outbox.push(message)
    await writeState(state)
    return jsonResult({ message })
  }
)

server.tool(
  "ticket_add_comment",
  "写入标准工单备注。commentType 使用固定枚举，避免自由文本。",
  {
    ticketId: z.string().describe("工单号。"),
    commentType: z.enum(["triage_summary", "assignment_note", "followup_note", "closure_summary"])
  },
  async ({ ticketId, commentType }) => {
    const state = await readState()
    const ticket = findTicket(state, ticketId)
    const comment = { ticketId, commentType, text: ticketComment(ticket, commentType) }
    state.comments.push(comment)
    await writeState(state)
    return jsonResult({ comment })
  }
)

server.tool(
  "ticket_update_status",
  "更新工单状态。status 使用固定状态枚举。",
  {
    ticketId: z.string().describe("工单号。"),
    status: z.enum(["new", "queued", "in_progress", "waiting_user", "pending_validation", "resolved", "closed"])
  },
  async ({ ticketId, status }) => {
    const state = await readState()
    const ticket = findTicket(state, ticketId)
    ticket.status = status
    if (status === "waiting_user") ticket.nextAction = "no_action"
    if (status === "pending_validation") ticket.nextAction = "validate"
    if (status === "closed") ticket.nextAction = "no_action"
    await writeState(state)
    return jsonResult({ ticket: summarizeTicket(ticket) })
  }
)

server.tool(
  "todo_create_followup",
  "创建后续跟进任务。reasonCode 使用固定枚举。",
  {
    ticketId: z.string().describe("工单号。"),
    reasonCode: z.enum(["await_user", "await_assignee", "validate_later", "close_later"])
  },
  async ({ ticketId, reasonCode }) => {
    const state = await readState()
    const ticket = findTicket(state, ticketId)
    const todo = { ticketId, reasonCode, owner: ticket.assigneeId ?? ticket.recommendedAssigneeId ?? "fo-copilot" }
    state.todos.push(todo)
    await writeState(state)
    return jsonResult({ todo })
  }
)

server.tool(
  "knowledge_search_similar",
  "按工单服务搜索相似知识条目。",
  { ticketId: z.string().describe("工单号。") },
  async ({ ticketId }) => {
    const state = await readState()
    const ticket = findTicket(state, ticketId)
    return jsonResult({
      ticketId,
      matches: state.knowledge.filter((item) => item.service === ticket.service)
    })
  }
)

server.tool(
  "knowledge_create_case",
  "为已解决工单创建知识条目。",
  { ticketId: z.string().describe("工单号。") },
  async ({ ticketId }) => {
    const state = await readState()
    const ticket = findTicket(state, ticketId)
    const existing = state.knowledge.find((item) => item.ticketId === ticketId)
    if (existing) return jsonResult({ case: existing, created: false })
    const entry = {
      id: `KB-${3000 + state.knowledge.length + 1}`,
      service: ticket.service,
      title: `处理复盘：${ticket.title}`,
      ticketId
    }
    state.knowledge.push(entry)
    ticket.knowledgeCreated = true
    await writeState(state)
    return jsonResult({ case: entry, created: true })
  }
)

server.tool(
  "ticket_close",
  "关闭已解决工单。",
  { ticketId: z.string().describe("工单号。") },
  async ({ ticketId }) => {
    const state = await readState()
    const ticket = findTicket(state, ticketId)
    if (ticket.status !== "resolved" && ticket.status !== "pending_validation") {
      throw new Error(`工单 ${ticketId} 当前状态 ${ticket.status} 不适合关闭。请先确认状态。`)
    }
    ticket.status = "closed"
    ticket.nextAction = "no_action"
    await writeState(state)
    return jsonResult({ ticket: summarizeTicket(ticket) })
  }
)

server.tool(
  "ticket_validate_state",
  "校验一个工单是否达到预期状态，用于测试收尾。",
  {
    ticketId: z.string().describe("工单号。"),
    expectedState: z.enum(["queued", "waiting_user", "pending_validation", "closed", "no_action"])
  },
  async ({ ticketId, expectedState }) => {
    const state = await readState()
    const ticket = findTicket(state, ticketId)
    const passed = expectedState === "no_action" ? ticket.nextAction === "no_action" : ticket.status === expectedState
    return jsonResult({
      ticketId,
      expectedState,
      passed,
      observed: {
        status: ticket.status,
        nextAction: ticket.nextAction,
        assigneeId: ticket.assigneeId ?? null,
        knowledgeCreated: ticket.knowledgeCreated ?? false
      }
    })
  }
)

await server.connect(new StdioServerTransport())
