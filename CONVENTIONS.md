# Repository Standards & Conventions

## 1. Scope and Purpose

- This file captures non-obvious, repo-specific rules that matter for correctness, maintainability, and avoiding subtle regressions in the Codex MCP → OpenAI-compatible HTTP/SSE bridge.

## 2. Core Conventions

### Stdio Discipline (Codex MCP)

**Status:** REQUIRED

**Scope:** All code that spawns/communicates with the Codex MCP process

**Rule:**

- Treat the Codex process’ stdout as JSON-RPC protocol-only; log diagnostics to stderr only.

**Rationale (Why this exists):**

- Any non-JSON output on stdout corrupts the JSON-RPC framing and can break streaming.
- Keeping all logs on stderr makes protocol parsing deterministic.

**Examples:**

- Good: The bridge logs via `src/log.ts` (stderr-only).
- Bad: `console.log(...)` of raw protocol lines to stdout.

**Related Files / Modules:**

- src/log.ts
- src/codex/CodexMcpBridge.ts

### Notification-First Streaming

**Status:** REQUIRED

**Scope:** Streaming route `/v1/chat/completions` when `stream: true`

**Rule:**

- Treat `codex/event` JSON-RPC notifications as the source-of-truth for streaming; do not rely on a JSON-RPC response to end the stream.

**Rationale (Why this exists):**

- JSON-RPC notifications have no `id` and must not receive replies; upstream may stream only via notifications.
- Waiting on a `tools/call` response can hang requests even if deltas already arrived.

**Examples:**

- Good: Terminal upstream events trigger deterministic SSE completion.
- Bad: Holding the HTTP response open solely because `tools/call` hasn’t responded yet.

**Related Files / Modules:**

- src/codex/CodexMcpBridge.ts
- src/app.ts

### SSE Output Format (OpenAI Chat Completions)

**Status:** REQUIRED

**Scope:** All SSE responses from `/v1/chat/completions`

**Rule:**

- Emit OpenAI Chat Completions-style SSE payloads: `data: {"object":"chat.completion.chunk", ...}` chunks with `choices[0].delta.content`, followed by a final `data: [DONE]`.

**Rationale (Why this exists):**

- Xcode Coding Intelligence expects OpenAI-compatible streaming semantics.
- A terminal `[DONE]` prevents clients from waiting indefinitely.

**Examples:**

- Good: Stream text via `choices[0].delta.content` and finish with `[DONE]`.
- Bad: Sending arbitrary event formats or omitting the `[DONE]` sentinel.

**Related Files / Modules:**

- src/http/sse.ts
- src/codex/CodexMcpBridge.ts
- src/app.ts

### Event Type Normalization and Delta Extraction

**Status:** STRONGLY RECOMMENDED

**Scope:** Codex notification handling (`codex/event`)

**Rule:**

- Normalize upstream event `type` strings (dot/space/dash → underscore) and extract text deltas from multiple safe locations (`msg.delta`, `msg.text`, `msg.part.text`, `msg.parts[].text`).

**Rationale (Why this exists):**

- Upstream event schemas can vary (underscore-style vs dot-separated OpenAI Responses-style).
- Overly strict filtering causes silent “no deltas” failures.

**Examples:**

- Good: Accept `response.output_text.delta` and `output_text_delta` as text delta events.
- Bad: Only accepting a small hardcoded allowlist without normalization.

**Related Files / Modules:**

- src/codex/CodexMcpBridge.ts

### Server Module Boundaries

**Status:** STRONGLY RECOMMENDED

**Scope:** Project structure

**Rule:**

- Keep `src/server.ts` as composition/wiring only; place protocol, SSE, auth, and OpenAI-shaping logic in their dedicated modules.

**Rationale (Why this exists):**

- Keeps the streaming lifecycle understandable and reduces accidental behavior drift.

**Examples:**

- Good: Codex stdio + JSON-RPC parsing lives in `src/codex/CodexMcpBridge.ts`.
- Bad: Reintroducing a single-file monolith with duplicated streaming logic.

**Related Files / Modules:**

- src/app.ts
- src/server.ts
- src/codex/CodexMcpBridge.ts
- src/http/auth.ts
- src/http/sse.ts
- src/openai/chatCompletions.ts
- src/openai/embeddings.ts

## 3. Rationale and Examples

- The bridge is intentionally conservative: it favors robust streaming delivery over strict schema coupling.
- When in doubt, prefer dropping unknown events safely (stderr diagnostics) rather than throwing.

## 4. Known Exceptions

- None currently.

## 5. Change History (Human-Readable)

- 2025-12-13: Added initial conventions focused on stdio discipline, notification-first streaming, and SSE compatibility.
