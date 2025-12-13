import express, { Request, Response } from "express";
import { spawn, ChildProcessWithoutNullStreams } from "child_process";
import crypto from "crypto";

type JsonRpcRequest = {
  jsonrpc: "2.0";
  id: string;
  method: string;
  params?: any;
};

type JsonRpcResponse = {
  jsonrpc: "2.0";
  id: string;
  result?: any;
  error?: any;
};

type JsonRpcNotification = {
  jsonrpc: "2.0";
  method: string;
  params?: any;
};

type PendingRpc = {
  resolve: (v: any) => void;
  reject: (e: any) => void;
  timeout: NodeJS.Timeout;
};

type ActiveStream = {
  res: Response;
  streamId: string;        // OpenAI chatcmpl id
  created: number;         // epoch seconds
  model: string;
  closed: boolean;
  keepalive: NodeJS.Timeout;
  done: boolean;
  // last-seen timestamp (optional diagnostics)
  lastEventAt: number;
};

const PORT = Number(process.env.PORT ?? "3333");

// Optional auth (Xcode can set arbitrary header name/value)
const API_KEY = process.env.API_KEY ?? "";
const API_KEY_HEADER = (process.env.API_KEY_HEADER ?? "authorization").toLowerCase();
const REQUIRE_BEARER = (process.env.REQUIRE_BEARER ?? "0") === "1";

// Codex
const CODEX_BIN = process.env.CODEX_BIN ?? "codex";
const CODEX_PROFILE = process.env.CODEX_PROFILE ?? "clean"; // optional
const MODEL_ID = process.env.MODEL_ID ?? "gpt-5.2";

// Timeouts / streaming behavior
const RPC_TIMEOUT_MS = Number(process.env.RPC_TIMEOUT_MS ?? "120000");
const SSE_KEEPALIVE_MS = Number(process.env.SSE_KEEPALIVE_MS ?? "15000");
const STREAM_CHUNK_CHARS = Number(process.env.STREAM_CHUNK_CHARS ?? "64");
const HARD_REQUEST_TIMEOUT_MS = Number(process.env.HARD_REQUEST_TIMEOUT_MS ?? "300000"); // 5 min

function nowSec(): number {
  return Math.floor(Date.now() / 1000);
}

function mkId(prefix: string): string {
  return `${prefix}-${crypto.randomUUID().replace(/-/g, "")}`;
}

function log(...args: any[]) {
  // logs to stderr only
  process.stderr.write(`${new Date().toISOString()} ${args.join(" ")}\n`);
}

function getAuthValue(req: Request): string {
  const v = req.headers[API_KEY_HEADER];
  if (!v) return "";
  if (Array.isArray(v)) return v[0] ?? "";
  return String(v);
}

function checkAuth(req: Request): boolean {
  if (!API_KEY) return true;

  const raw = getAuthValue(req).trim();
  if (!raw) return false;

  if (API_KEY_HEADER === "authorization") {
    const m = /^Bearer\s+(.+)$/.exec(raw);
    if (m) return m[1] === API_KEY;
    return REQUIRE_BEARER ? false : raw === API_KEY;
  }

  return raw === API_KEY;
}

function unauthorized(res: Response) {
  res.status(401).json({ error: { message: "Unauthorized", type: "auth_error" } });
}

// --- SSE helpers (OpenAI-style) ---
function sseHeaders(res: Response) {
  res.status(200);
  res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");

  // Ensure headers flush quickly (Express doesn't always expose flushHeaders typing)
  (res as any).flushHeaders?.();

  // Force an initial write so clients don't sit there waiting for the first byte.
  res.write(`: connected ${Date.now()}\n\n`);
}

function sseSend(res: Response, obj: any) {
  res.write(`data: ${JSON.stringify(obj)}\n\n`);
}

function sseDone(res: Response) {
  res.write("data: [DONE]\n\n");
  res.end();
}

function chunkString(text: string, chunkSize: number): string[] {
  if (chunkSize <= 0) return [text];
  const out: string[] = [];
  for (let i = 0; i < text.length; i += chunkSize) {
    out.push(text.slice(i, i + chunkSize));
  }
  return out;
}

// --- Convert OpenAI messages[] to a single prompt ---
function flattenMessages(messages: any[]): string {
  if (!Array.isArray(messages)) return "";

  return messages
    .map((m) => {
      const role = (m?.role ?? "user").toString().toUpperCase();

      let content = "";
      if (typeof m?.content === "string") {
        content = m.content;
      } else if (Array.isArray(m?.content)) {
        // handle "rich" parts; keep text-ish data
        content = m.content
          .map((p: any) => {
            if (typeof p === "string") return p;
            if (typeof p?.text === "string") return p.text;
            if (typeof p?.content === "string") return p.content;
            return "";
          })
          .join("");
      } else {
        content = (m?.content ?? "").toString();
      }

      return `${role}:\n${content}`;
    })
    .join("\n\n");
}

// --- Extract text from Codex MCP tool result (best-effort) ---
function extractTextFromToolResult(result: any): string {
  const parts = result?.content;
  if (Array.isArray(parts)) {
    const texts = parts
      .filter((p: any) => p?.type === "text" && typeof p?.text === "string")
      .map((p: any) => p.text);
    if (texts.length) return texts.join("");
  }
  if (typeof result === "string") return result;
  return JSON.stringify(result);
}

// --- Codex MCP process + parser ---
class CodexMcpBridge {
  private proc: ChildProcessWithoutNullStreams | null = null;
  private buffer = "";
  private pending = new Map<string, PendingRpc>();
  private activeStreams = new Map<string, ActiveStream>(); // key: requestId (Codex _meta.requestId)
  private restarts = 0;
  private startedAt = Date.now();

  start() {
    const args: string[] = [];

    // Critical: run Codex in server-only mode for our purposes
    args.push("--disable", "rmcp_client");

    if (CODEX_PROFILE) {
      args.push("--profile", CODEX_PROFILE);
    }

    args.push("mcp-server");

    log(`[codex] spawn: ${CODEX_BIN} ${args.join(" ")}`);

    this.proc = spawn(CODEX_BIN, args, { stdio: ["pipe", "pipe", "pipe"] });

    this.proc.stderr.on("data", (d) => {
      const s = d.toString("utf8").trimEnd();
      if (s) log(`[codex stderr] ${s}`);
    });

    this.proc.stdout.on("data", (d) => this.onStdout(d.toString("utf8")));

    this.proc.on("exit", (code, signal) => {
      log(`[codex] exited code=${code} signal=${signal}`);
      this.failAllPending({ message: `codex exited code=${code} signal=${signal}` });
      this.failAllStreams(`codex exited code=${code} signal=${signal}`);
      this.proc = null;

      this.restarts += 1;
      const backoff = Math.min(1000 * this.restarts, 8000);
      setTimeout(() => this.start(), backoff);
    });

    this.proc.on("error", (err) => {
      log(`[codex] spawn error: ${err.message}`);
      this.failAllPending({ message: `codex spawn error: ${err.message}` });
      this.failAllStreams(`codex spawn error: ${err.message}`);
    });
  }

  status() {
    return {
      pid: this.proc?.pid ?? null,
      restarts: this.restarts,
      uptime_s: Math.floor((Date.now() - this.startedAt) / 1000),
      pending_rpc: this.pending.size,
      active_streams: this.activeStreams.size,
    };
  }

  private ensureRunning() {
    if (!this.proc || !this.proc.stdin.writable) {
      throw new Error("codex mcp-server not running");
    }
  }

  rpc(method: string, params?: any): Promise<any> {
    this.ensureRunning();

    const id = crypto.randomUUID();
    const payload: JsonRpcRequest = { jsonrpc: "2.0", id, method, params };

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject({ message: `RPC timeout for ${method}` });
      }, RPC_TIMEOUT_MS);

      this.pending.set(id, { resolve, reject, timeout });

      this.proc!.stdin.write(JSON.stringify(payload) + "\n");
    });
  }

  /**
   * For streaming: we want Codex events to be correlated to the request.
   * Codex emits notifications like:
   *   {"jsonrpc":"2.0","method":"codex/event","params":{"_meta":{"requestId":"..."},"msg":{...}}}
   *
   * The trick: use a requestId we control and pass it via params._meta.requestId
   * (Codex already uses _meta.requestId heavily; this aligns with its event format).
   */
  toolsCallStreaming(prompt: string, requestId: string): Promise<any> {
    this.ensureRunning();

    const id = requestId; // use requestId as JSON-RPC id too, helpful fallback correlation

    const params = {
      name: "codex",
      arguments: { prompt },
      _meta: { requestId },
    };

    const payload: JsonRpcRequest = { jsonrpc: "2.0", id, method: "tools/call", params };

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject({ message: `RPC timeout for tools/call (requestId=${requestId})` });
      }, RPC_TIMEOUT_MS);

      this.pending.set(id, { resolve, reject, timeout });

      this.proc!.stdin.write(JSON.stringify(payload) + "\n");
    });
  }

  registerStream(requestId: string, stream: ActiveStream) {
    this.activeStreams.set(requestId, stream);
  }

  unregisterStream(requestId: string) {
    this.activeStreams.delete(requestId);
  }

  private failAllPending(err: any) {
    for (const [, p] of this.pending) {
      clearTimeout(p.timeout);
      p.reject(err);
    }
    this.pending.clear();
  }

  private failAllStreams(reason: string) {
    for (const [requestId, s] of this.activeStreams) {
      if (s.done || s.closed) continue;
      try {
        sseSend(s.res, {
          id: s.streamId,
          object: "chat.completion.chunk",
          created: s.created,
          model: s.model,
          choices: [
            {
              index: 0,
              delta: { content: `\n[bridge error] ${reason}\n` },
              finish_reason: "stop",
            },
          ],
        });
        sseDone(s.res);
      } catch {
        // ignore
      }
      clearInterval(s.keepalive);
      s.closed = true;
      s.done = true;
      this.activeStreams.delete(requestId);
    }
  }

  private onStdout(chunk: string) {
    // Handle both \n and \r\n:
    // We split on \n, and strip a trailing \r from each line.
    this.buffer += chunk;

    while (true) {
      const idx = this.buffer.indexOf("\n");
      if (idx === -1) break;

      let line = this.buffer.slice(0, idx);
      this.buffer = this.buffer.slice(idx + 1);

      // Strip a single trailing \r if present
      if (line.endsWith("\r")) line = line.slice(0, -1);

      if (!line) continue;

      let msg: any;
      try {
        msg = JSON.parse(line);
      } catch {
        // Non-JSON on stdout means something is violating MCP stdio expectations.
        // Log minimal info to stderr; do NOT spam.
        log(`[codex stdout] non-JSON line (first 120 chars): ${JSON.stringify(line.slice(0, 120))}`);
        continue;
      }

      // JSON-RPC response?
      if (msg && Object.prototype.hasOwnProperty.call(msg, "id")) {
        const id = String(msg.id);
        const pending = this.pending.get(id);
        if (pending) {
          clearTimeout(pending.timeout);
          this.pending.delete(id);

          const resp = msg as JsonRpcResponse;
          if (resp.error) pending.reject(resp.error);
          else pending.resolve(resp.result);
        }
        continue;
      }

      // JSON-RPC notification? (Codex events are notifications)
      const notif = msg as JsonRpcNotification;
      if (notif?.method === "codex/event") {
        this.handleCodexEvent(notif);
      }
    }
  }

  private handleCodexEvent(notif: JsonRpcNotification) {
    const params = notif.params ?? {};
    const metaReqId: string | undefined = params?._meta?.requestId;
    const altReqId: string | undefined =
      params?.id || params?.requestId || params?._meta?.id; // defensive fallbacks

    const requestId = metaReqId || altReqId;
    if (!requestId) return;

    let stream = this.activeStreams.get(String(requestId));

    if (!stream && this.activeStreams.size === 1) {
      // Codex sometimes chooses its own requestId (e.g. cpl-...) in events.
      // If there's only one active stream, route events to it.
      stream = Array.from(this.activeStreams.values())[0];
    }

    if (!stream || stream.closed || stream.done) return;

    // const stream = this.activeStreams.get(String(requestId));
    if (!stream || stream.closed || stream.done) return;

    stream.lastEventAt = Date.now();

    // Event payloads look like:
    // params.msg = { type: "..._delta", delta: "..." , ... }
    const m = params?.msg ?? {};
    const type = String(m?.type ?? "");
    const delta = typeof m?.delta === "string" ? m.delta : "";

    log(
      `[event] meta.requestId=${params?._meta?.requestId ?? ""} ` +
      `id=${params?.id ?? ""} type=${String(m?.type ?? "")} ` +
      `deltaLen=${typeof m?.delta === "string" ? m.delta.length : 0}`
    );

    // Decide what to stream to Xcode.
    // (You can refine these; this is a robust baseline.)
    const streamableTypes = new Set([
      "content_delta",
      "output_text_delta",
      "assistant_content_delta",
      "final_content_delta",
      "reasoning_content_delta",
      "agent_reasoning_delta",
      "text_delta",
    ]);

    if (!delta) return;
    if (!streamableTypes.has(type)) return;

    // Stream as OpenAI delta.content
    sseSend(stream.res, {
      id: stream.streamId,
      object: "chat.completion.chunk",
      created: stream.created,
      model: stream.model,
      choices: [
        {
          index: 0,
          delta: { content: delta },
          finish_reason: null,
        },
      ],
    });
  }
}

const codex = new CodexMcpBridge();
codex.start();

// --- Express app ---
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

  // Deterministic dummy embedding (keeps clients happy when probed).
  const input = req.body?.input;
  const inputs = Array.isArray(input) ? input : [input ?? ""];
  const dim = 16;

  const embedOne = (text: string) => {
    const h = crypto.createHash("sha256").update(text).digest();
    const out: number[] = [];
    for (let i = 0; i < dim; i++) out.push(((h[i] / 255) * 2) - 1);
    return out;
  };

  res.json({
    object: "list",
    data: inputs.map((t, i) => ({
      object: "embedding",
      index: i,
      embedding: embedOne(String(t)),
    })),
    model: req.body?.model ?? MODEL_ID,
    usage: { prompt_tokens: 0, total_tokens: 0 },
  });
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

  // Non-streaming path
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
      // SSE comment ping
      res.write(`: keepalive ${Date.now()}\n\n`);
    }, SSE_KEEPALIVE_MS),
    done: false,
    lastEventAt: Date.now(),
  };

  // Ensure cleanup on disconnect
  req.on("close", () => {
    streamState.closed = true;
    clearInterval(streamState.keepalive);
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

  // Hard timeout: don’t leave Xcode hanging forever
  const hardTimeout = setTimeout(() => {
    if (streamState.done || streamState.closed) return;
    streamState.done = true;
    clearInterval(streamState.keepalive);
    codex.unregisterStream(requestId);

    sseSend(res, {
      id: streamId,
      object: "chat.completion.chunk",
      created,
      model: MODEL_ID,
      choices: [
        {
          index: 0,
          delta: { content: `\n[bridge error] hard timeout after ${HARD_REQUEST_TIMEOUT_MS}ms\n` },
          finish_reason: "stop",
        },
      ],
    });
    sseDone(res);
  }, HARD_REQUEST_TIMEOUT_MS);

  try {
    // This call will resolve when codex emits a JSON-RPC response.
    // Meanwhile, events are streaming through handleCodexEvent().
    log(`[tools/call] start requestId=${requestId}`);
    const result = await codex.toolsCallStreaming(prompt, requestId);
    log(`[tools/call] done requestId=${requestId}`);

    if (streamState.closed || streamState.done) return;

    // If Codex did not stream usable deltas, we still want to deliver final output.
    const finalText = extractTextFromToolResult(result);
    if (finalText) {
      for (const chunk of chunkString(finalText, STREAM_CHUNK_CHARS)) {
        if (streamState.closed || streamState.done) return;
        sseSend(res, {
          id: streamId,
          object: "chat.completion.chunk",
          created,
          model: MODEL_ID,
          choices: [{ index: 0, delta: { content: chunk }, finish_reason: null }],
        });
      }
    }

    // Finish
    streamState.done = true;
    clearTimeout(hardTimeout);
    clearInterval(streamState.keepalive);
    codex.unregisterStream(requestId);

    sseSend(res, {
      id: streamId,
      object: "chat.completion.chunk",
      created,
      model: MODEL_ID,
      choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
    });
    sseDone(res);
  } catch (e: any) {
    if (streamState.closed || streamState.done) return;

    streamState.done = true;
    clearTimeout(hardTimeout);
    clearInterval(streamState.keepalive);
    codex.unregisterStream(requestId);

    sseSend(res, {
      id: streamId,
      object: "chat.completion.chunk",
      created,
      model: MODEL_ID,
      choices: [
        {
          index: 0,
          delta: { content: `\n[bridge error] ${e?.message ?? String(e)}\n` },
          finish_reason: "stop",
        },
      ],
    });
    sseDone(res);
  }
});

app.listen(PORT, () => {
  log(`Bridge listening: http://localhost:${PORT}`);
  log(`Models: GET  /v1/models`);
  log(`Chat:   POST /v1/chat/completions`);
  log(`Embed:  POST /v1/embeddings`);
  log(`Auth: ${API_KEY ? `enabled (${API_KEY_HEADER})` : "disabled"}`);
});
