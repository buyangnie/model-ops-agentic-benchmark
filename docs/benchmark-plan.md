# Benchmark Plan

## Purpose

Compare local Qwen 3.5 models in `goosed` agentic operations workflows and identify the smallest model that is practically usable on the local machine.

The benchmark intentionally uses `goosed agent` plus MCP tools. Direct Ollama calls are only used for low-level connectivity diagnostics, not for model selection.

## Current Test Scope

- Context limit: 32K.
- Thinking mode: normal model behavior.
- Conversation shape: one user round per scenario.
- Tool budget: at most five MCP tool calls per scenario.
- Runtime: `goosed agent`.
- Provider shape: OpenAI-compatible custom provider pointing at local Ollama.
- Report language: Chinese.

## Scenarios

Current FO ticket scenarios:

- `fo-ticket-intake-single`
- `fo-ticket-dispatch-single`
- `fo-ticket-followup-single`
- `fo-ticket-noaction-single`
- `fo-ticket-closure-single`

The scenarios cover ticket intake, dispatch, follow-up, no-action judgment, closure, and knowledge capture. Inputs are intentionally simple: ticket IDs, request IDs, fixed enum values, and assignee IDs.

## Minimum Usability Bar

A model is considered usable only if it can:

- complete the scenario through `goosed`;
- call the requested MCP tools successfully;
- produce a `Finish` event;
- satisfy the final state checks;
- stay within the configured scenario timeout.

Partial tool execution without `Finish` is not considered usable, because an agentic host would need external timeout cancellation to recover.

## Known Harness Risk

The current file-backed MCP state can expose write races when a model emits several tool calls in parallel. This is useful for surfacing agentic behavior, but it can also make final state checks fail even when all requested tools were called. Future revisions should either serialize state writes or make each tool update merge against the latest state.
