import { CodexMcpBridge } from "./codex/CodexMcpBridge";
import { authStatusForLogs } from "./http/auth";
import { log } from "./log";
import { createApp } from "./app";

const PORT = Number(process.env.PORT ?? "3333");
const MODEL_ID = process.env.MODEL_ID ?? "gpt-5.2";

// Timeouts / streaming behavior
const RPC_TIMEOUT_MS = Number(process.env.RPC_TIMEOUT_MS ?? "1200000");
const SSE_KEEPALIVE_MS = Number(process.env.SSE_KEEPALIVE_MS ?? "15000");
const STREAM_CHUNK_CHARS = Number(process.env.STREAM_CHUNK_CHARS ?? "64");
const HARD_REQUEST_TIMEOUT_MS = Number(process.env.HARD_REQUEST_TIMEOUT_MS ?? "300000"); // 5 min

const codex = new CodexMcpBridge({
  rpcTimeoutMs: RPC_TIMEOUT_MS,
  streamChunkChars: STREAM_CHUNK_CHARS,
});
codex.start();

const app = createApp({
  codex,
  modelId: MODEL_ID,
  sseKeepaliveMs: SSE_KEEPALIVE_MS,
  hardRequestTimeoutMs: HARD_REQUEST_TIMEOUT_MS,
});

app.listen(PORT, () => {
  log(`Bridge listening: http://localhost:${PORT}`);
  log(`Models: GET  /v1/models`);
  log(`Chat:   POST /v1/chat/completions`);
  log(`Embed:  POST /v1/embeddings`);
  log(`Auth: ${authStatusForLogs()}`);
});
