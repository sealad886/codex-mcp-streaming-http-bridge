/// <reference types="vitest/globals" />

import { CodexMcpBridge, type ActiveStream } from "../src/codex/CodexMcpBridge";

function makeCapturingRes() {
  const chunks: string[] = [];
  const res = {
    write: (s: string) => {
      chunks.push(s);
      return true;
    },
    end: () => {
      chunks.push("[[end]]");
    },
  } as any;

  return { res, text: () => chunks.join("") };
}

describe("CodexMcpBridge.completeStream", () => {
  it("suppresses finalText when deltas were already streamed", () => {
    const bridge = new CodexMcpBridge({ rpcTimeoutMs: 5_000, streamChunkChars: 16, codexProfile: "" });

    const { res, text } = makeCapturingRes();

    const stream: ActiveStream = {
      res,
      streamId: "chatcmpl-test",
      created: 0,
      model: "gpt-5.2",
      closed: false,
      keepalive: setInterval(() => {}, 60_000),
      done: false,
      lastEventAt: Date.now(),
      emittedText: "",
      hasStreamedDelta: true,
    };

    bridge.registerStream("req-1", stream);
    bridge.completeStream("req-1", { finalText: "FINAL", finishReason: "stop" });

    const out = text();
    expect(out).not.toContain("FINAL");
    expect(out).toContain("data: [DONE]");
  });

  it("streams finalText when no deltas were streamed", () => {
    const bridge = new CodexMcpBridge({ rpcTimeoutMs: 5_000, streamChunkChars: 16, codexProfile: "" });

    const { res, text } = makeCapturingRes();

    const stream: ActiveStream = {
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

    bridge.registerStream("req-2", stream);
    bridge.completeStream("req-2", { finalText: "FINAL", finishReason: "stop" });

    const out = text();
    expect(out).toContain("FINAL");
    expect(out).toContain("data: [DONE]");
  });
});

