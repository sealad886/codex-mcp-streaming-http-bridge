# Codex MCP HTTP Bridge

A small Node/Express bridge that exposes OpenAI-compatible HTTP endpoints and streams responses to clients (including Xcode Coding Intelligence) while talking to Codex via MCP (JSON-RPC over stdio).

## Endpoints

- `GET /health`
- `GET /v1/models`
- `POST /v1/chat/completions`
- `POST /v1/embeddings`

## Configuration

- `PORT` (default `3333`)
- `MODEL_ID` (default `gpt-5.2`)
- `CODEX_BIN` (default `codex`)
- `CODEX_PROFILE` (default `clean`)
- `API_KEY` (optional)
- `API_KEY_HEADER` (default `authorization`)
- `REQUIRE_BEARER` (`1` to require `Authorization: Bearer ...`)

## Verification

### Build

- `npm run build`

### Run

- `npm start`

### Streaming smoke test (SSE)

This should print multiple `data: {...}` lines containing `choices[0].delta.content`, and end with `data: [DONE]`.

```bash
curl -N http://localhost:3333/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -d '{"model":"gpt-5.2","stream":true,"messages":[{"role":"user","content":"Write 2 short sentences about TypeScript."}]}'
```

If you enabled auth, add your configured header, e.g.:

```bash
curl -N http://localhost:3333/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -H 'Authorization: Bearer YOUR_KEY' \
  -d '{"model":"gpt-5.2","stream":true,"messages":[{"role":"user","content":"Say hello."}]}'
```
