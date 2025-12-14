/// <reference types="vitest/globals" />

import type { AddressInfo } from "net";

type ServerHandle = {
  baseUrl: string;
  close: () => Promise<void>;
};

async function startServer(app: any): Promise<ServerHandle> {
  const server = app.listen(0);
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const { port } = server.address() as AddressInfo;
  const baseUrl = `http://127.0.0.1:${port}`;
  return {
    baseUrl,
    close: () => new Promise((resolve, reject) => server.close((err?: any) => (err ? reject(err) : resolve()))),
  };
}

async function makeApp(opts?: { apiKey?: string }) {
  vi.resetModules();

  // Keep tests quiet and deterministic even though we reset process.env below.
  process.env.CODEX_BRIDGE_LOG_EVENTS = "0";

  if (opts?.apiKey) process.env.API_KEY = opts.apiKey;
  else delete process.env.API_KEY;

  delete process.env.API_KEY_HEADER;
  delete process.env.REQUIRE_BEARER;

  const [{ createApp }, { CodexMcpBridge }] = await Promise.all([
    import("../src/app"),
    import("../src/codex/CodexMcpBridge"),
  ]);

  const bridge = new CodexMcpBridge({ rpcTimeoutMs: 5_000, streamChunkChars: 16 });

  const codex = {
    status: () => ({ pid: null, mocked: true }),

    rpc: vi.fn(async (_method: string, _params?: any) => ({
      content: [{ type: "text", text: "ok" }],
    })),

    toolsCallStreaming: vi.fn(async (_prompt: string, _requestId: string) => ({
      content: [{ type: "text", text: "streamed" }],
    })),

    registerStream: (requestId: string, stream: any) => bridge.registerStream(requestId, stream),
    unregisterStream: (requestId: string) => bridge.unregisterStream(requestId),
    completeStream: (requestId: string, streamOpts?: any) => bridge.completeStream(requestId, streamOpts),
  };

  const app = createApp({
    codex,
    modelId: "gpt-5.2",
    sseKeepaliveMs: 25,
    hardRequestTimeoutMs: 5_000,
  });

  return { app, codex, bridge };
}

describe("createApp", () => {
  const originalEnv = { ...process.env };
  let server: ServerHandle | null = null;

  beforeEach(() => {
    process.env = { ...originalEnv };
    process.env.CODEX_BRIDGE_LOG_EVENTS = "0";
  });

  afterEach(async () => {
    if (server) await server.close();
    server = null;
    process.env = { ...originalEnv };
    process.env.CODEX_BRIDGE_LOG_EVENTS = "0";
    vi.restoreAllMocks();
  });

  it("GET /health is unauthenticated", async () => {
    const { app } = await makeApp();
    server = await startServer(app);

    const res = await fetch(`${server.baseUrl}/health`);
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.ok).toBe(true);
    expect(json.model).toBe("gpt-5.2");
  });

  it("rejects /v1/models when API_KEY is set", async () => {
    const { app } = await makeApp({ apiKey: "sekret" });
    server = await startServer(app);

    const res = await fetch(`${server.baseUrl}/v1/models`);
    expect(res.status).toBe(401);
    const json = await res.json();
    expect(json.error?.type).toBe("auth_error");
  });

  it("allows /v1/models when Authorization matches", async () => {
    const { app } = await makeApp({ apiKey: "sekret" });
    server = await startServer(app);

    const res = await fetch(`${server.baseUrl}/v1/models`, {
      headers: { Authorization: "Bearer sekret" },
    });

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.object).toBe("list");
    expect(Array.isArray(json.data)).toBe(true);
    expect(json.data[0].id).toBe("gpt-5.2");
  });

  it("POST /v1/chat/completions (non-stream) proxies via rpc", async () => {
    const { app, codex } = await makeApp({ apiKey: "sekret" });
    server = await startServer(app);

    const res = await fetch(`${server.baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: "Bearer sekret",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "gpt-5.2",
        stream: false,
        messages: [{ role: "user", content: "hi" }],
      }),
    });

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(codex.rpc).toHaveBeenCalledOnce();
    expect(json.object).toBe("chat.completion");
    expect(json.choices?.[0]?.message?.content).toBe("ok");
  });

  it("POST /v1/chat/completions (stream, finalText-only) yields delta + [DONE]", async () => {
    const { app, codex } = await makeApp({ apiKey: "sekret" });
    server = await startServer(app);

    const res = await fetch(`${server.baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: "Bearer sekret",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "gpt-5.2",
        stream: true,
        messages: [{ role: "user", content: "hi" }],
      }),
    });

    expect(res.status).toBe(200);
    expect(codex.toolsCallStreaming).toHaveBeenCalledOnce();

    const text = await res.text();

    expect(res.headers.get("content-type")).toContain("text/event-stream");
    expect(text).toContain('"delta":{"role":"assistant"}');
    expect(text).toContain('"delta":{"content":"streamed"');
    expect(text).toContain("data: [DONE]");
  });

  it("POST /v1/chat/completions (stream, codex/event-driven) streams deltas and suppresses finalText", async () => {
    const { app, codex, bridge } = await makeApp({ apiKey: "sekret" });

    (codex as any).toolsCallStreaming = vi.fn(async (_prompt: string, requestId: string) => {
      const b = bridge as any;
      const respId = "resp-123";

      const notify = (params: any) =>
        b.handleCodexEvent({
          jsonrpc: "2.0",
          method: "codex/event",
          params,
        });

      // Like real Codex: first event includes the requestId, subsequent ones may only include response_id.
      notify({ _meta: { requestId }, id: respId, msg: { type: "output_text_delta", delta: "hello ", response_id: respId } });
      notify({ response_id: respId, msg: { type: "output_text_delta", text: "world" } });
      notify({ response_id: respId, msg: { type: "response.completed" } });

      // Real tools/call usually returns a final snapshot too; it must NOT be appended once deltas streamed.
      return { content: [{ type: "text", text: "SHOULD_NOT_APPEAR" }] };
    });

    server = await startServer(app);

    const res = await fetch(`${server.baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: "Bearer sekret",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "gpt-5.2",
        stream: true,
        messages: [{ role: "user", content: "hi" }],
      }),
    });

    expect(res.status).toBe(200);
    expect((codex as any).toolsCallStreaming).toHaveBeenCalledOnce();

    const text = await res.text();

    expect(res.headers.get("content-type")).toContain("text/event-stream");
    expect(text).toContain('"delta":{"role":"assistant"}');
    expect(text).toContain('"delta":{"content":"hello "');
    expect(text).toContain('"delta":{"content":"world"');
    expect(text).toContain("data: [DONE]");
    expect(text).not.toContain("SHOULD_NOT_APPEAR");
  });
});
