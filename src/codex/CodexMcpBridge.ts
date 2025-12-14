import type { Response } from "express";
import { spawn, type ChildProcessWithoutNullStreams } from "child_process";
import crypto from "crypto";

import { log } from "../log";
import { sseDone, sseSend } from "../http/sse";
import { chunkString } from "../openai/chatCompletions";

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

export type ActiveStream = {
  res: Response;
  streamId: string; // OpenAI chatcmpl id
  created: number; // epoch seconds
  model: string;
  closed: boolean;
  keepalive: NodeJS.Timeout;
  hardTimeout?: NodeJS.Timeout;
  done: boolean;
  lastEventAt: number;

  // Tracks what we've already emitted as `choices[0].delta.content` for this stream.
  // Codex notifications sometimes contain snapshots and/or duplicated deltas.
  // Clients like Xcode will naively append, so we must convert to monotonic deltas.
  emittedText: string;

  // IMPORTANT: if we stream any delta events, we must NOT re-stream the full final result.
  // Otherwise some clients (notably Xcode) will append duplicated snapshots and you get
  // "ExplExploringoring..." garbage.
  hasStreamedDelta: boolean;
};

type CodexBridgeOptions = {
  rpcTimeoutMs: number;
  streamChunkChars: number;
  codexBin?: string;
  codexProfile?: string;
};

export class CodexMcpBridge {
  private proc: ChildProcessWithoutNullStreams | null = null;
  private buffer = "";
  private pending = new Map<string, PendingRpc>();
  private activeStreams = new Map<string, ActiveStream>(); // key: requestId (Codex _meta.requestId)
  private streamAliases = new Map<string, string>(); // aliasId -> requestId
  private restarts = 0;
  private startedAt = Date.now();

  private readonly logEvents: boolean;

  private readonly rpcTimeoutMs: number;
  private readonly streamChunkChars: number;
  private readonly codexBin: string;
  private readonly codexProfile: string;

  private readonly streamableTextDeltaTypes = new Set([
    "content_delta",
    "output_text_delta",
    "assistant_content_delta",
    "final_content_delta",
    "reasoning_content_delta",
    "agent_reasoning_delta",
    "text_delta",

    "response_output_text_delta",
    "response_reasoning_text_delta",
  ]);

  private readonly terminalTypes = new Set([
    "response_completed",
    "response_incomplete",
    "response_failed",
  ]);

  constructor(opts: CodexBridgeOptions) {
    this.rpcTimeoutMs = opts.rpcTimeoutMs;
    this.streamChunkChars = opts.streamChunkChars;

    this.codexBin = opts.codexBin ?? (process.env.CODEX_BIN ?? "codex");
    this.codexProfile = opts.codexProfile ?? (process.env.CODEX_PROFILE ?? "clean");

    this.logEvents = (process.env.CODEX_BRIDGE_LOG_EVENTS ?? "1") !== "0";
  }

  start() {
    const args: string[] = [];

    // Critical: run Codex in server-only mode for our purposes
    args.push("--disable", "rmcp_client");

    if (this.codexProfile) {
      args.push("--profile", this.codexProfile);
    }

    args.push("mcp-server");

    log(`[codex] spawn: ${this.codexBin} ${args.join(" ")}`);

    this.proc = spawn(this.codexBin, args, { stdio: ["pipe", "pipe", "pipe"] });

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
      }, this.rpcTimeoutMs);

      this.pending.set(id, { resolve, reject, timeout });

      this.proc!.stdin.write(JSON.stringify(payload) + "\n");
    });
  }

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
      }, this.rpcTimeoutMs);

      this.pending.set(id, { resolve, reject, timeout });

      this.proc!.stdin.write(JSON.stringify(payload) + "\n");
    });
  }

  registerStream(requestId: string, stream: ActiveStream) {
    this.activeStreams.set(requestId, stream);
  }

  unregisterStream(requestId: string) {
    this.activeStreams.delete(requestId);

    for (const [alias, target] of this.streamAliases) {
      if (target === requestId) this.streamAliases.delete(alias);
    }
  }

  completeStream(requestId: string, opts?: { finalText?: string; errorText?: string; finishReason?: string }) {
    const stream = this.activeStreams.get(requestId);
    if (!stream || stream.closed || stream.done) return;

    const created = stream.created;
    const streamId = stream.streamId;
    const model = stream.model;

    const sendContent = (content: string) => {
      for (const chunk of chunkString(content, this.streamChunkChars)) {
        if (!chunk) continue;
        if (stream.closed || stream.done) return;
        sseSend(stream.res, {
          id: streamId,
          object: "chat.completion.chunk",
          created,
          model,
          choices: [{ index: 0, delta: { content: chunk }, finish_reason: null }],
        });
      }
    };

    if (opts?.errorText) {
      sendContent(`\n[bridge error] ${opts.errorText}\n`);
    }

    if (opts?.finalText) {
      if (!stream.hasStreamedDelta) {
        sendContent(opts.finalText);
      }
    }

    stream.done = true;
    clearInterval(stream.keepalive);
    if (stream.hardTimeout) clearTimeout(stream.hardTimeout);
    this.activeStreams.delete(requestId);

    for (const [alias, target] of this.streamAliases) {
      if (target === requestId) this.streamAliases.delete(alias);
    }

    sseSend(stream.res, {
      id: streamId,
      object: "chat.completion.chunk",
      created,
      model,
      choices: [{ index: 0, delta: {}, finish_reason: opts?.finishReason ?? "stop" }],
    });
    sseDone(stream.res);
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
      if (s.hardTimeout) clearTimeout(s.hardTimeout);
      s.closed = true;
      s.done = true;
      this.activeStreams.delete(requestId);
    }

    this.streamAliases.clear();
  }

  private onStdout(chunk: string) {
    this.buffer += chunk;

    while (true) {
      const idx = this.buffer.indexOf("\n");
      if (idx === -1) break;

      let line = this.buffer.slice(0, idx);
      this.buffer = this.buffer.slice(idx + 1);

      if (line.endsWith("\r")) line = line.slice(0, -1);
      if (!line) continue;

      let msg: any;
      try {
        msg = JSON.parse(line);
      } catch {
        log(`[codex stdout] non-JSON line (first 120 chars): ${JSON.stringify(line.slice(0, 120))}`);
        continue;
      }

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

      const notif = msg as JsonRpcNotification;
      if (notif?.method === "codex/event") {
        this.handleCodexEvent(notif);
      }
    }
  }

  private addStreamAlias(requestId: string, candidate: unknown) {
    if (typeof candidate !== "string") return;
    const alias = candidate.trim();
    if (!alias) return;
    if (alias === requestId) return;

    const existing = this.streamAliases.get(alias);
    if (!existing) {
      this.streamAliases.set(alias, requestId);
      return;
    }

    // If an alias collides, keep the first mapping to avoid churn.
  }

  private extractCandidateIds(params: any): string[] {
    const msg = params?.msg ?? {};
    const candidates = [
      params?._meta?.requestId,
      params?._meta?.id,
      params?.requestId,
      params?.id,
      params?.responseId,
      params?.response_id,
      msg?.requestId,
      msg?.id,
      msg?.responseId,
      msg?.response_id,
    ];

    const out: string[] = [];
    const seen = new Set<string>();
    for (const c of candidates) {
      if (typeof c !== "string") continue;
      const v = c.trim();
      if (!v) continue;
      if (seen.has(v)) continue;
      seen.add(v);
      out.push(v);

      const aliased = this.streamAliases.get(v);
      if (aliased && !seen.has(aliased)) {
        seen.add(aliased);
        out.push(aliased);
      }
    }

    return out;
  }

  private resolveStreamForEvent(params: any): { requestId: string; stream: ActiveStream; usedFallback: boolean } | null {
    for (const candidate of this.extractCandidateIds(params)) {
      const stream = this.activeStreams.get(candidate);
      if (stream) return { requestId: candidate, stream, usedFallback: false };
    }

    if (this.activeStreams.size === 1) {
      const [requestId, stream] = Array.from(this.activeStreams.entries())[0];
      return { requestId, stream, usedFallback: true };
    }

    return null;
  }

  private canonicalizeEventType(type: unknown): { raw: string; canon: string } {
    const raw = typeof type === "string" ? type : String(type ?? "");
    const canon = raw
      .trim()
      .toLowerCase()
      .replace(/[.\s-]+/g, "_")
      .replace(/_+/g, "_");
    return { raw, canon };
  }

  private extractDeltaText(msg: any): string {
    if (typeof msg?.delta === "string") return msg.delta;
    if (typeof msg?.text === "string") return msg.text;
    if (typeof msg?.part?.text === "string") return msg.part.text;

    const parts = msg?.parts;
    if (Array.isArray(parts)) {
      const texts = parts
        .map((p: any) => (typeof p?.text === "string" ? p.text : ""))
        .filter((t: string) => t.length > 0);
      if (texts.length) return texts.join("");
    }

    return "";
  }

  private coalesceTextDelta(stream: ActiveStream, incomingText: string): string {
    if (!incomingText) return "";

    const emitted = stream.emittedText ?? "";

    // Exact duplicates (common when multiple event types carry the same chunk).
    if (emitted.endsWith(incomingText)) return "";

    // Snapshot-to-delta conversion: incoming is the full text so far.
    if (incomingText.startsWith(emitted)) {
      return incomingText.slice(emitted.length);
    }

    // Overlap case: incoming begins with the tail of what we've already emitted.
    const max = Math.min(emitted.length, incomingText.length);
    for (let k = max; k > 0; k -= 1) {
      if (emitted.slice(-k) === incomingText.slice(0, k)) {
        return incomingText.slice(k);
      }
    }

    return incomingText;
  }

  private appendEmittedText(stream: ActiveStream, appended: string) {
    if (!appended) return;
    const next = (stream.emittedText ?? "") + appended;

    // Guard memory: we only need enough history to coalesce overlaps/snapshots.
    const maxChars = 256_000;
    stream.emittedText = next.length > maxChars ? next.slice(next.length - maxChars) : next;
  }

  private looksLikeTextDeltaType(canonType: string): boolean {
    if (!canonType.endsWith("_delta")) return false;
    return /(^|_)(text|content)(_|$)/.test(canonType);
  }

  private isTerminalType(canonType: string): boolean {
    if (this.terminalTypes.has(canonType)) return true;
    if (!canonType.startsWith("response_")) return false;
    return (
      canonType.endsWith("_completed") ||
      canonType.endsWith("_incomplete") ||
      canonType.endsWith("_failed")
    );
  }

  private extractErrorTextFromMsg(canonType: string, msg: any): string {
    const explicit =
      (typeof msg?.error?.message === "string" && msg.error.message) ||
      (typeof msg?.error === "string" && msg.error);

    if (explicit) return explicit;

    // Some terminal failure/incomplete events carry a message field.
    if (canonType.endsWith("_failed") || canonType.endsWith("_incomplete")) {
      if (typeof msg?.message === "string" && msg.message.trim()) return msg.message;
      if (canonType.endsWith("_failed")) return "upstream response failed";
      return "upstream response incomplete";
    }

    return "";
  }

  private normalizeCodexEvent(
    params: any
  ): Array<
    | { kind: "text-delta"; text: string; rawType: string; canonType: string }
    | { kind: "done"; rawType: string; canonType: string }
    | { kind: "error"; message: string; rawType: string; canonType: string }
  > {
    const msg = params?.msg ?? {};
    const { raw: rawType, canon: canonType } = this.canonicalizeEventType(msg?.type);

    const events: Array<
      | { kind: "text-delta"; text: string; rawType: string; canonType: string }
      | { kind: "done"; rawType: string; canonType: string }
      | { kind: "error"; message: string; rawType: string; canonType: string }
    > = [];

    const deltaText = this.extractDeltaText(msg);
    if (deltaText) {
      if (this.streamableTextDeltaTypes.has(canonType) || this.looksLikeTextDeltaType(canonType)) {
        events.push({ kind: "text-delta", text: deltaText, rawType, canonType });
      }
    }

    const errorText = this.extractErrorTextFromMsg(canonType, msg);
    if (errorText) {
      events.push({ kind: "error", message: errorText, rawType, canonType });
    }

    if (this.isTerminalType(canonType)) {
      events.push({ kind: "done", rawType, canonType });
    }

    return events;
  }

  private handleCodexEvent(notif: JsonRpcNotification) {
    const params = notif.params ?? {};
    const resolved = this.resolveStreamForEvent(params);
    if (!resolved) return;

    const { requestId, stream, usedFallback } = resolved;
    if (usedFallback && this.logEvents) {
      log(`[event] correlation fallback to sole active stream requestId=${requestId}`);
    }

    if (stream.closed || stream.done) return;

    stream.lastEventAt = Date.now();

    const m = params?.msg ?? {};
    const { raw: rawType, canon: canonType } = this.canonicalizeEventType(m?.type);
    const extractedDelta = this.extractDeltaText(m);

    // If Codex emits alternative IDs (e.g. cpl-/resp-), record them as aliases.
    this.addStreamAlias(requestId, params?.id);
    this.addStreamAlias(requestId, params?.requestId);
    this.addStreamAlias(requestId, params?._meta?.requestId);
    this.addStreamAlias(requestId, params?._meta?.id);
    this.addStreamAlias(requestId, params?.responseId);
    this.addStreamAlias(requestId, params?.response_id);
    this.addStreamAlias(requestId, m?.id);
    this.addStreamAlias(requestId, m?.requestId);
    this.addStreamAlias(requestId, m?.responseId);
    this.addStreamAlias(requestId, m?.response_id);

    if (this.logEvents) {
      log(
        `[event] meta.requestId=${params?._meta?.requestId ?? ""} ` +
          `id=${params?.id ?? ""} type=${rawType} canon=${canonType} ` +
          `deltaLen=${extractedDelta ? extractedDelta.length : 0}`
      );
    }

    const normalized = this.normalizeCodexEvent(params);
    if (!normalized.length) return;

    for (const ev of normalized) {
      if (stream.closed || stream.done) return;

      if (ev.kind === "text-delta") {
        const toEmit = this.coalesceTextDelta(stream, ev.text);
        if (!toEmit) continue;

        stream.hasStreamedDelta = true;
        this.appendEmittedText(stream, toEmit);

        for (const chunk of chunkString(toEmit, this.streamChunkChars)) {
          if (!chunk) continue;
          if (stream.closed || stream.done) return;
          sseSend(stream.res, {
            id: stream.streamId,
            object: "chat.completion.chunk",
            created: stream.created,
            model: stream.model,
            choices: [{ index: 0, delta: { content: chunk }, finish_reason: null }],
          });
        }
        continue;
      }

      if (ev.kind === "error") {
        this.completeStream(String(requestId), { errorText: ev.message, finishReason: "stop" });
        return;
      }

      if (ev.kind === "done") {
        this.completeStream(String(requestId), { finishReason: "stop" });
        return;
      }
    }
  }
}
