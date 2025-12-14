/// <reference types="vitest/globals" />

import fs from "fs";
import path from "path";

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

describe("CodexMcpBridge codex/event fixture replay", () => {
  it("replays realistic event shapes and produces correct SSE deltas", async () => {
    const { CodexMcpBridge } = await import("../src/codex/CodexMcpBridge");
    const bridge = new CodexMcpBridge({ rpcTimeoutMs: 5_000, streamChunkChars: 4096, codexProfile: "" });

    const { res, writes } = makeCapturingRes();

    const requestId = "req-1";
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

      const fixturePath = path.join(__dirname, "fixtures", "codex-event-replay.jsonl");
      const raw = fs.readFileSync(fixturePath, "utf8");
      const lines = raw
        .split("\n")
        .map((l) => l.trim())
        .filter(Boolean);

      for (const line of lines) {
        const notif = JSON.parse(line);
        (bridge as any).handleCodexEvent(notif);
      }

      const text = extractSseDeltaContent(writes);
      expect(text).toBe("Hello world! More text");
      expect(writes.join("")).toContain("data: [DONE]");
    } finally {
      clearInterval(stream.keepalive);
    }
  });
});
