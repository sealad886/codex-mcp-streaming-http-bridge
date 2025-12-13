import express, { type Request, type Response } from "express";
import crypto from "crypto";

import type { ActiveStream } from "./codex/CodexMcpBridge";
import { checkAuth, unauthorized } from "./http/auth";
import { sseHeaders, sseSend } from "./http/sse";
import { nowSec, flattenMessages, extractTextFromToolResult } from "./openai/chatCompletions";
import { handleEmbeddings } from "./openai/embeddings";
import { log } from "./log";

export type CodexLike = {
  status: () => any;
  rpc: (method: string, params?: any) => Promise<any>;
  toolsCallStreaming: (prompt: string, requestId: string) => Promise<any>;
  registerStream: (requestId: string, stream: ActiveStream) => void;
  unregisterStream: (requestId: string) => void;
  completeStream: (
    requestId: string,
    opts?: { finalText?: string; errorText?: string; finishReason?: string }
  ) => void;
};

export type CreateAppOptions = {
  codex: CodexLike;
  modelId: string;
  sseKeepaliveMs: number;
  hardRequestTimeoutMs: number;
};

function mkId(prefix: string): string {
  return `${prefix}-${crypto.randomUUID().replace(/-/g, "")}`;
}

export function createApp(opts: CreateAppOptions) {
  const { codex, modelId, sseKeepaliveMs, hardRequestTimeoutMs } = opts;

  const app = express();
  app.use(express.json({ limit: "25mb" }));

  app.get("/health", (_req, res) => {
    res.json({ ok: true, model: modelId, codex: codex.status() });
  });

  app.get("/v1/models", (req, res) => {
    if (!checkAuth(req)) return unauthorized(res);

    res.json({
      object: "list",
      data: [{ id: modelId, object: "model", created: 0, owned_by: "local" }],
    });
  });

  app.post("/v1/embeddings", (req, res) => {
    if (!checkAuth(req)) return unauthorized(res);
    return handleEmbeddings(req, res, modelId);
  });

  app.post("/v1/chat/completions", async (req: Request, res: Response) => {
    if (!checkAuth(req)) return unauthorized(res);

    const body = req.body ?? {};
    const model = String(body.model ?? modelId);
    if (model !== modelId) {
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
          model: modelId,
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
      model: modelId,
      closed: false,
      keepalive: setInterval(() => {
        res.write(`: keepalive ${Date.now()}\n\n`);
      }, sseKeepaliveMs),
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
      model: modelId,
      choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }],
    });

    codex.registerStream(requestId, streamState);

    const hardTimeout = setTimeout(() => {
      if (streamState.done || streamState.closed) return;
      codex.completeStream(requestId, {
        errorText: `hard timeout after ${hardRequestTimeoutMs}ms`,
        finishReason: "stop",
      });
    }, hardRequestTimeoutMs);
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

  return app;
}
