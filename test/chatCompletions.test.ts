import { describe, expect, test } from "vitest";

import { flattenMessages } from "../src/openai/chatCompletions";

describe("flattenMessages", () => {
  test("includes system by default", () => {
    const prompt = flattenMessages([
      { role: "system", content: "SYS" },
      { role: "user", content: "U" },
    ]);

    expect(prompt).toContain("SYSTEM:\nSYS");
    expect(prompt).toContain("USER:\nU");
  });

  test("can drop system messages", () => {
    const prompt = flattenMessages(
      [
        { role: "system", content: "SYS" },
        { role: "user", content: "U" },
      ],
      { systemMessages: "none" }
    );

    expect(prompt).not.toContain("SYSTEM:\nSYS");
    expect(prompt).toContain("USER:\nU");
  });

  test("can cap system message length", () => {
    const prompt = flattenMessages(
      [
        { role: "system", content: "1234567890ABC" },
        { role: "user", content: "U" },
      ],
      { systemMessages: "all", systemMaxChars: 10 }
    );

    expect(prompt).toContain("SYSTEM:\n1234567890");
    expect(prompt).not.toContain("SYSTEM:\n1234567890A");
  });
});
