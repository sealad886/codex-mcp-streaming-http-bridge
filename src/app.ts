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

  const logRequests = (process.env.BRIDGE_LOG_REQUESTS ?? "0") === "1";
  const redactSecrets = (process.env.BRIDGE_LOG_REQUESTS_REDACT ?? "1") !== "0";

  const systemMessagesEnvRaw = process.env.BRIDGE_SYSTEM_MESSAGES;

  const parseSystemMessagesPolicy = (value: unknown): "none" | "first" | "last" | "all" | null => {
    const v = (value ?? "").toString().trim().toLowerCase();
    if (v === "none" || v === "first" || v === "last" || v === "all") return v;
    return null;
  };

  const systemMaxChars = Number.parseInt(process.env.BRIDGE_SYSTEM_MAX_CHARS ?? "0", 10);
  const effectiveSystemMaxChars = Number.isFinite(systemMaxChars) ? systemMaxChars : 0;

  app.use(
    express.json({
      limit: "25mb",
      verify: (req, _res, buf, encoding) => {
        // Capture the raw request payload for debugging; this is often what you
        // want when comparing what clients (e.g. Xcode) send vs. what we parse.
        (req as any).rawBody = buf.toString((encoding as BufferEncoding) ?? "utf8");
      },
    })
  );

  const sanitizeHeaders = (headers: Record<string, unknown>): Record<string, unknown> => {
    if (!redactSecrets) return headers;

    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(headers)) {
      const key = k.toLowerCase();
      if (
        key === "authorization" ||
        key === "cookie" ||
        key.includes("api-key") ||
        key.includes("apikey") ||
        key.includes("token") ||
        key.includes("secret")
      ) {
        out[k] = "[redacted]";
      } else {
        out[k] = v;
      }
    }
    return out;
  };

  const safeStringify = (value: unknown): string => {
    try {
      return JSON.stringify(value, null, 2);
    } catch {
      try {
        return String(value);
      } catch {
        return "[unstringifiable]";
      }
    }
  };

  if (logRequests) {
    app.use((req, res, next) => {
      const startedAt = Date.now();

      res.on("finish", () => {
        const ms = Date.now() - startedAt;
        log(`[http] ${req.method} ${req.originalUrl} -> ${res.statusCode} ${ms}ms`);
      });

      // Avoid logging SSE stream contents here; log the inbound request only.
      const rawBody = (req as any).rawBody;
      const payload = {
        method: req.method,
        url: req.originalUrl,
        ip: req.ip,
        headers: sanitizeHeaders(req.headers as any),
        query: req.query,
        body: req.body,
        rawBody: typeof rawBody === "string" ? rawBody : undefined,
      };

      log(`[http request] ${safeStringify(payload)}`);
      next();
    });
  }

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

    const explicitPolicy = parseSystemMessagesPolicy(systemMessagesEnvRaw);
    const userAgent = (req.headers["user-agent"] ?? "").toString();
    const defaultPolicy = userAgent.startsWith("Xcode/") ? "none" : "all";
    const systemMessagesPolicy = explicitPolicy ?? defaultPolicy;

    const prompt = flattenMessages(messages, {
      systemMessages: systemMessagesPolicy,
      systemMaxChars: effectiveSystemMaxChars,
    });
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
      emittedText: "",
      hasStreamedDelta: false,
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
