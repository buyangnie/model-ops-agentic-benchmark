# Model Ops Agentic Benchmark

Benchmark workspace for comparing local Ollama models in operational, multi-turn agentic scenarios through `goosed agent`.

Initial target models:

- `qwen3.5:4b-64k`
- `qwen3.5:9b-64k`

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

## Current MVP

The first milestone contains:

- a local stdio MCP server in `mcp/ops-tools`
- a deploy-failure incident in `incidents/incident-001-deploy-failure.yaml`
- sandbox fixtures under `sandbox/fixtures/incident-001-deploy-failure`
- a runner in `runner/src/run-benchmark.ts`
- integration notes in `docs/goosed-integration-notes.md`

Install dependencies and build:

```bash
npm install
npm run build
```

Create 64K-capped local Ollama tags:

```bash
ollama create qwen3.5:4b-64k -f agents/ollama/qwen3.5-4b-64k.Modelfile
ollama create qwen3.5:9b-64k -f agents/ollama/qwen3.5-9b-64k.Modelfile
```

Validate the runner without calling goosed:

```bash
npm run runner -- --dry-run --model qwen3.5:4b --incident incident-001-deploy-failure
```

To run through goosed, start `goosed agent` separately with a fixed secret:

```bash
export GOOSE_SERVER__SECRET_KEY=model-ops-benchmark
export GOOSE_TLS=false
export GOOSE_INPUT_LIMIT=65536
export OLLAMA_HOST=http://127.0.0.1:11434
goosed agent
```

Then run one model:

```bash
npm run runner -- --model qwen3.5:4b-64k --incident incident-001-deploy-failure
npm run runner -- --model qwen3.5:9b-64k --incident incident-001-deploy-failure
```

For a quick smoke test, limit the run to one round:

```bash
npm run runner -- --model qwen3.5:4b-64k --incident incident-001-deploy-failure --max-rounds 1 --context-limit 65536 --max-tokens 512 --turn-timeout-ms 120000
```

## Scoring Dimensions

- Root cause identification
- Tool-use quality
- Multi-turn context retention
- Safety constraint compliance
- Fix validation
- Incident handoff quality
- Runtime performance on the local machine
