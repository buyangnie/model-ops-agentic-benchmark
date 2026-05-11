# goosed Integration Notes

This benchmark treats `goosed` as an external runtime. Do not modify the `goose` repository for benchmark logic.

## Runtime APIs

The runner uses the desktop/backend HTTP APIs exposed by `goosed agent`:

- `POST /agent/start` to create a session.
- `PUT /sessions/{id}/name` to prevent automatic title generation from consuming the tested model.
- `POST /agent/update_provider` to set the provider and model for the session.
- `GET /sessions/{id}/events` to subscribe to assistant, tool, and finish events.
- `POST /sessions/{id}/reply` to trigger a user turn.
- `POST /sessions/{id}/cancel` as best-effort cleanup on timeout.

The older `/reply` streaming endpoint is not used for benchmark output collection because the session event stream is the reliable event source for this goosed flow.

## Provider Configuration

Use a custom OpenAI-compatible provider for local Ollama:

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

The runner calls `POST /agent/update_provider` with:

```json
{
  "provider": "custom_ollama_local",
  "model": "qwen3.5:9b-32k-harness",
  "session_id": "<session-id>",
  "context_limit": 32768,
  "request_params": {
    "max_tokens": 1024,
    "temperature": 0
  }
}
```

## MCP Extension

Each run injects the benchmark MCP server through `extension_overrides`:

```json
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
```

## Runner Contract

The runner owns orchestration:

- reset `sandbox/work` from the selected fixture;
- create a fresh goosed session;
- set a session name before the first user turn;
- update the provider and model;
- subscribe to `/sessions/{id}/events`;
- trigger `/sessions/{id}/reply`;
- persist raw events, timing, token state, final sandbox state, and Chinese reports.

The model must perform the scenario through goosed-visible MCP tools. The runner does not help the model by inspecting incident internals during a run.
