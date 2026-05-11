# Model Ops Agentic Benchmark

Benchmark workspace for comparing local Ollama models in operational, multi-turn agentic scenarios through `goosed agent`.

Initial target models:

- `qwen3.5:4b`
- `qwen3.5:9b`

## Goal

This repository is intended to measure model behavior inside the real `goosed` agent runtime, not through direct Ollama chat calls.

The benchmark focuses on operations scenarios that require:

- multi-turn incident handling
- tool use through local MCP servers
- evidence-based troubleshooting
- safe configuration edits
- validation and rollback planning
- handoff summaries

## Planned Layout

```text
agents/      goosed agent configuration variants for each model
mcp/         local MCP servers that expose controlled operations tools
incidents/   multi-turn benchmark case definitions
sandbox/     isolated logs, configs, metrics, runbooks, and validators
runner/      benchmark runner that drives goosed sessions
reports/     generated transcripts, metrics, and comparison summaries
```

## Benchmark Shape

Each incident should run as a 10-20 round conversation against the same `goosed` session. The runner sends user messages, records assistant replies, captures tool activity, and checks final state with validators.

The Ollama model is only the model provider. Session management, context handling, and tool orchestration should go through `goosed agent`.

## Scoring Dimensions

- Root cause identification
- Tool-use quality
- Multi-turn context retention
- Safety constraint compliance
- Fix validation
- Incident handoff quality
- Runtime performance on the local machine

