# Model Ops Agentic Benchmark

Benchmark workspace for comparing local Ollama models in operational agentic scenarios through `goosed agent`.

## Goal

This repository measures whether a local model is usable in a real `goosed` agentic workflow. The target is not best possible accuracy; the target is the smallest local model that can reliably finish practical FO Copilot-style operations work with MCP tools.

Current benchmark scope:

- `goosed agent` runtime, not direct model calls.
- Local Ollama through an OpenAI-compatible custom provider.
- 32K context.
- Normal thinking mode.
- Single-round FO ticket scenarios with at most five tool calls.
- Chinese reports.

## Layout

```text
agents/      Ollama Modelfiles for benchmark model tags
mcp/         local MCP server exposing controlled FO ticket tools
incidents/   benchmark case definitions
sandbox/     fixture state and isolated work directory
runner/      goosed benchmark runner and report comparison script
reports/     committed final 32K comparison report and supporting run outputs
```

## Models

Create the 32K local Ollama tags:

```bash
ollama create qwen3.5:4b-32k-harness -f agents/ollama/qwen3.5-4b-32k-harness.Modelfile
ollama create qwen3.5:9b-32k-harness -f agents/ollama/qwen3.5-9b-32k-harness.Modelfile
```

## Build

```bash
npm install
npm run build
```

## goosed Setup

Register a local OpenAI-compatible custom provider in the active `GOOSE_PATH_ROOT`:

```json
{
  "name": "custom_ollama_local",
  "engine": "openai",
  "display_name": "Local Ollama OpenAI Compatible",
  "api_key_env": "",
  "base_url": "http://127.0.0.1:11434/v1/chat/completions",
  "models": [
    { "name": "qwen3.5:4b-32k-harness", "context_limit": 32768 },
    { "name": "qwen3.5:9b-32k-harness", "context_limit": 32768 }
  ],
  "supports_streaming": true,
  "requires_auth": false
}
```

Start `goosed`:

```bash
export GOOSE_PATH_ROOT=/tmp/model-ops-goosed-32k-root
export GOOSE_SERVER__SECRET_KEY=model-ops-benchmark
export GOOSE_TLS=false
export GOOSE_DISABLE_KEYRING=1
export GOOSE_TELEMETRY_ENABLED=false
export GOOSE_CONTEXT_LIMIT=32768
export GOOSE_MAX_TOKENS=1024
export GOOSE_TEMPERATURE=0
goosed agent
```

## Run

Run a single scenario:

```bash
npm run runner -- \
  --model qwen3.5:9b-32k-harness \
  --provider custom_ollama_local \
  --incident fo-ticket-dispatch-single \
  --context-limit 32768 \
  --max-tokens 1024 \
  --temperature 0 \
  --turn-timeout-ms 240000 \
  --extension-mode ticket
```

Run all current FO ticket scenarios serially:

```bash
for incident in \
  fo-ticket-intake-single \
  fo-ticket-dispatch-single \
  fo-ticket-followup-single \
  fo-ticket-noaction-single \
  fo-ticket-closure-single; do
  npm run runner -- \
    --model qwen3.5:9b-32k-harness \
    --provider custom_ollama_local \
    --incident "$incident" \
    --context-limit 32768 \
    --max-tokens 1024 \
    --temperature 0 \
    --turn-timeout-ms 240000 \
    --extension-mode ticket
done
```

## Reports

The current final report is:

```text
reports/comparison-qwen35-4b-9b-32k.zh.md
```

It includes the 32K 4B vs 9B selection judgment and points to the supporting per-scenario run outputs under `reports/fo-ticket-*-single/`.
