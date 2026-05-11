# goosed Integration Notes

This benchmark treats `goosed` as an external runtime. Do not modify the `goose` repository for benchmark logic.

## Verified Runtime Shape

The current local `goose` checkout exposes:

- `goosed agent` as the agent HTTP server command.
- `GOOSE_SERVER__SECRET_KEY` as the server secret override.
- `X-Secret-Key` as the request authentication header for protected routes.
- `POST /agent/start` to create a user session.
- `POST /agent/update_provider` to set provider/model for a session.
- `POST /reply` as the SSE chat endpoint.
- `extension_overrides` on `/agent/start` for per-session MCP extension injection.

The benchmark should use these APIs rather than calling Ollama directly for model responses.

## Model Configuration

Each benchmark run should create a fresh goosed session and then call:

```json
{
  "provider": "ollama",
  "model": "qwen3.5:4b-64k",
  "session_id": "<session-id>",
  "context_limit": 65536
}
```

The same flow is used for `qwen3.5:9b`.

Useful environment defaults:

```bash
export GOOSE_PROVIDER=ollama
export GOOSE_MODEL=qwen3.5:4b-64k
export OLLAMA_HOST=http://127.0.0.1:11434
export GOOSE_SERVER__SECRET_KEY=model-ops-benchmark
export GOOSE_TLS=false
export GOOSE_INPUT_LIMIT=65536
```

`goosed agent` defaults to TLS in the inspected checkout. The benchmark runner currently assumes local HTTP, so use `GOOSE_TLS=false` for local runs unless the runner is extended to trust the generated self-signed certificate.

Use the derived `qwen3.5:4b-64k` and `qwen3.5:9b-64k` tags for benchmark runs. They are created from the base local models with `PARAMETER num_ctx 65536`. This is more reliable than relying only on goosed request parameters because the inspected base Qwen 3.5 tags can otherwise load with a 128K context.

## Per-Session MCP Extension

The runner injects the benchmark MCP server when creating a session:

```json
{
  "working_dir": "/absolute/path/to/model-ops-agentic-benchmark/sandbox/work",
  "extension_overrides": [
    {
      "type": "stdio",
      "name": "ops-benchmark-tools",
      "cmd": "node",
      "args": [
        "/absolute/path/to/model-ops-agentic-benchmark/dist/mcp/ops-tools/src/server.js"
      ],
      "envs": {
        "BENCHMARK_SANDBOX": "/absolute/path/to/model-ops-agentic-benchmark/sandbox/work"
      },
      "timeout": 60,
      "bundled": false,
      "description": "Controlled operations benchmark tools for local incident sandboxes"
    }
  ]
}
```

## Runner Contract

The runner owns orchestration only:

- reset `sandbox/work` from fixtures
- start or connect to `goosed agent`
- create a session
- update the session provider/model
- send 10-20 user turns to `/reply`
- persist SSE events, transcript, timing, token state, and final validation output

The runner must not inspect incident internals to help the model during a run. The model should discover evidence only through goosed-visible MCP tools and its conversation context.
