/// <reference types="vitest/globals" />

type WriteCapture = {
  writes: string[];
  res: any;
};

function createWriteCapture(): WriteCapture {
  const writes: string[] = [];
  const res = {
    write: (chunk: string) => {
      writes.push(String(chunk));
      return true;
    },
    end: vi.fn(),
  };

  return { writes, res };
}

function extractSseDeltaContent(writes: string[]): string {
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

describe("CodexMcpBridge delta coalescing", () => {
  it("coalesces duplicate/snapshot deltas into monotonic content", async () => {
    const { CodexMcpBridge } = await import("../src/codex/CodexMcpBridge");
    const bridge = new CodexMcpBridge({ rpcTimeoutMs: 5_000, streamChunkChars: 4096 });

    const { writes, res } = createWriteCapture();

    const requestId = "req-1";
    const stream = {
      res,
      streamId: "chatcmpl-1",
      created: 1,
      model: "gpt-5.2",
      closed: false,
      keepalive: setInterval(() => {}, 1_000_000),
      done: false,
      lastEventAt: Date.now(),
      emittedText: "",
      hasStreamedDelta: false,
    };

    try {
      bridge.registerStream(requestId, stream as any);

      const send = (type: string, delta: string) =>
        (bridge as any).handleCodexEvent({
          jsonrpc: "2.0",
          method: "codex/event",
          params: {
            _meta: { requestId },
            msg: { type, delta },
          },
        });

      // Duplicate delta (same text delivered via multiple event types)
      send("output_text_delta", "Expl");
      send("content_delta", "Expl");

      // Snapshot delta (full text so far)
      send("output_text_delta", "Exploring");

      // Overlap delta (starts with tail of already-emitted text)
      send("output_text_delta", "ing Terminal");

      // Terminal
      (bridge as any).handleCodexEvent({
        jsonrpc: "2.0",
        method: "codex/event",
        params: {
          _meta: { requestId },
          msg: { type: "response.completed" },
        },
      });

      const text = extractSseDeltaContent(writes);
      expect(text).toBe("Exploring Terminal");
    } finally {
      clearInterval(stream.keepalive);
    }
  });
});
