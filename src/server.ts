import express, { type Request, type Response } from "express";
import crypto from "crypto";

import { CodexMcpBridge, type ActiveStream } from "./codex/CodexMcpBridge";
import { checkAuth, unauthorized, authStatusForLogs } from "./http/auth";
import { sseHeaders, sseSend } from "./http/sse";
import { nowSec, flattenMessages, extractTextFromToolResult } from "./openai/chatCompletions";
import { handleEmbeddings } from "./openai/embeddings";
import { log } from "./log";

const PORT = Number(process.env.PORT ?? "3333");
const MODEL_ID = process.env.MODEL_ID ?? "gpt-5.2";

// Timeouts / streaming behavior
const RPC_TIMEOUT_MS = Number(process.env.RPC_TIMEOUT_MS ?? "120000");
const SSE_KEEPALIVE_MS = Number(process.env.SSE_KEEPALIVE_MS ?? "15000");
const STREAM_CHUNK_CHARS = Number(process.env.STREAM_CHUNK_CHARS ?? "64");
const HARD_REQUEST_TIMEOUT_MS = Number(process.env.HARD_REQUEST_TIMEOUT_MS ?? "300000"); // 5 min

function mkId(prefix: string): string {
  return `${prefix}-${crypto.randomUUID().replace(/-/g, "")}`;
}

const codex = new CodexMcpBridge({
  rpcTimeoutMs: RPC_TIMEOUT_MS,
  streamChunkChars: STREAM_CHUNK_CHARS,
});
codex.start();

const app = express();
app.use(express.json({ limit: "25mb" }));

app.get("/health", (_req, res) => {
  res.json({ ok: true, model: MODEL_ID, codex: codex.status() });
});

app.get("/v1/models", (req, res) => {
  if (!checkAuth(req)) return unauthorized(res);

  res.json({
    object: "list",
    data: [{ id: MODEL_ID, object: "model", created: 0, owned_by: "local" }],
  });
});

app.post("/v1/embeddings", (req, res) => {
  if (!checkAuth(req)) return unauthorized(res);
  return handleEmbeddings(req, res, MODEL_ID);
});

app.post("/v1/chat/completions", async (req: Request, res: Response) => {
  if (!checkAuth(req)) return unauthorized(res);

  const body = req.body ?? {};
  const model = String(body.model ?? MODEL_ID);
  if (model !== MODEL_ID) {
    return res.status(400).json({
      error: { message: `Unknown model: ${model}`, type: "invalid_request_error" },
    });
  }

  const messages = body.messages ?? [];
  const prompt = flattenMessages(messages);
  const stream = !!body.stream;

  if (!stream) {
    try {
      const result = await codex.rpc("tools/call", {
        name: "codex",
        arguments: { prompt },
      });
      const text = extractTextFromToolResult(result);

      return res.json({
        id: mkId("chatcmpl"),
        object: "chat.completion",
        created: nowSec(),
        model: MODEL_ID,
        choices: [
          {
            index: 0,
            message: { role: "assistant", content: text },
            finish_reason: "stop",
          },
        ],
        usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
      });
    } catch (e: any) {
      return res.status(502).json({
        error: { message: e?.message ?? String(e), type: "server_error" },
      });
    }
  }

  // Streaming path (SSE)
  sseHeaders(res);

  const requestId = crypto.randomUUID();
  const streamId = mkId("chatcmpl");
  const created = nowSec();

  const streamState: ActiveStream = {
    res,
    streamId,
    created,
    model: MODEL_ID,
    closed: false,
    keepalive: setInterval(() => {
      res.write(`: keepalive ${Date.now()}\n\n`);
    }, SSE_KEEPALIVE_MS),
    done: false,
    lastEventAt: Date.now(),
  };

  res.on("close", () => {
    streamState.closed = true;
    clearInterval(streamState.keepalive);
    if (streamState.hardTimeout) clearTimeout(streamState.hardTimeout);
    codex.unregisterStream(requestId);
  });

  // Initial role chunk helps some clients
  sseSend(res, {
    id: streamId,
    object: "chat.completion.chunk",
    created,
    model: MODEL_ID,
    choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }],
  });

  codex.registerStream(requestId, streamState);

  // Hard timeout: don’t leave clients hanging forever
  const hardTimeout = setTimeout(() => {
    if (streamState.done || streamState.closed) return;
    codex.completeStream(requestId, {
      errorText: `hard timeout after ${HARD_REQUEST_TIMEOUT_MS}ms`,
      finishReason: "stop",
    });
  }, HARD_REQUEST_TIMEOUT_MS);
  streamState.hardTimeout = hardTimeout;

  try {
    log(`[tools/call] start requestId=${requestId}`);
    const p = codex.toolsCallStreaming(prompt, requestId);

    void p
      .then((result) => {
        log(`[tools/call] done requestId=${requestId}`);
        if (streamState.closed || streamState.done) return;
        const finalText = extractTextFromToolResult(result);
        codex.completeStream(requestId, { finalText, finishReason: "stop" });
      })
      .catch((e: any) => {
        if (streamState.closed || streamState.done) return;
        codex.completeStream(requestId, { errorText: e?.message ?? String(e), finishReason: "stop" });
      });
  } catch (e: any) {
    if (!streamState.closed && !streamState.done) {
      codex.completeStream(requestId, { errorText: e?.message ?? String(e), finishReason: "stop" });
    }
  }

  return;
});

app.listen(PORT, () => {
  log(`Bridge listening: http://localhost:${PORT}`);
  log(`Models: GET  /v1/models`);
  log(`Chat:   POST /v1/chat/completions`);
  log(`Embed:  POST /v1/embeddings`);
  log(`Auth: ${authStatusForLogs()}`);
});
