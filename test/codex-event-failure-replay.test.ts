/// <reference types="vitest/globals" />

function makeCapturingRes() {
  const writes: string[] = [];
  const res = {
    write: (s: string) => {
      writes.push(String(s));
      return true;
    },
    end: vi.fn(),
  } as any;

  return { res, writes };
}

function extractAllSseDeltaContent(writes: string[]): string {
  const joined = writes.join("");
  const lines = joined.split("\n");
  let out = "";

  for (const line of lines) {
    if (!line.startsWith("data: ")) continue;
    const payload = line.slice("data: ".length);
    if (payload === "[DONE]") break;
    try {
      const obj = JSON.parse(payload);
      const content = obj?.choices?.[0]?.delta?.content;
      if (typeof content === "string") out += content;
    } catch {
      // ignore
    }
  }

  return out;
}

describe("CodexMcpBridge codex/event failure replay", () => {
  it("emits a bridged error once on response.failed and terminates", async () => {
    const { CodexMcpBridge } = await import("../src/codex/CodexMcpBridge");
    const bridge = new CodexMcpBridge({ rpcTimeoutMs: 5_000, streamChunkChars: 4096, codexProfile: "" });

    const { res, writes } = makeCapturingRes();

    const requestId = "req-fail-1";
    const stream = {
      res,
      streamId: "chatcmpl-test",
      created: 0,
      model: "gpt-5.2",
      closed: false,
      keepalive: setInterval(() => {}, 60_000),
      done: false,
      lastEventAt: Date.now(),
      emittedText: "",
      hasStreamedDelta: false,
    };

    try {
      bridge.registerStream(requestId, stream as any);

      const b = bridge as any;
      const respId = "resp-fail-1";

      b.handleCodexEvent({
        jsonrpc: "2.0",
        method: "codex/event",
        params: { _meta: { requestId }, id: respId, msg: { type: "output_text_delta", delta: "partial " } },
      });
      b.handleCodexEvent({
        jsonrpc: "2.0",
        method: "codex/event",
        params: { response_id: respId, msg: { type: "response.failed", message: "rate limited" } },
      });

      const allText = extractAllSseDeltaContent(writes);
      expect(allText).toContain("partial ");
      expect(allText).toContain("[bridge error] rate limited");

      const joined = writes.join("");
      expect(joined.match(/\[bridge error\]/g)?.length ?? 0).toBe(1);
      expect(joined).toContain("data: [DONE]");
    } finally {
      clearInterval(stream.keepalive);
    }
  });

  it("emits a generic bridged error on response.incomplete without message and terminates", async () => {
    const { CodexMcpBridge } = await import("../src/codex/CodexMcpBridge");
    const bridge = new CodexMcpBridge({ rpcTimeoutMs: 5_000, streamChunkChars: 4096, codexProfile: "" });

    const { res, writes } = makeCapturingRes();

    const requestId = "req-incomplete-1";
    const stream = {
      res,
      streamId: "chatcmpl-test",
      created: 0,
      model: "gpt-5.2",
      closed: false,
      keepalive: setInterval(() => {}, 60_000),
      done: false,
      lastEventAt: Date.now(),
      emittedText: "",
      hasStreamedDelta: false,
    };

    try {
      bridge.registerStream(requestId, stream as any);

      const b = bridge as any;
      b.handleCodexEvent({
        jsonrpc: "2.0",
        method: "codex/event",
        params: { _meta: { requestId }, msg: { type: "response.incomplete" } },
      });

      const allText = extractAllSseDeltaContent(writes);
      expect(allText).toContain("[bridge error] upstream response incomplete");
      expect(writes.join("")).toContain("data: [DONE]");
    } finally {
      clearInterval(stream.keepalive);
    }
  });
});
