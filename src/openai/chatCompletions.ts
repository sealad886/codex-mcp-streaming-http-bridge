export function nowSec(): number {
  return Math.floor(Date.now() / 1000);
}

export function chunkString(text: string, chunkSize: number): string[] {
  if (chunkSize <= 0) return [text];
  const out: string[] = [];
  for (let i = 0; i < text.length; i += chunkSize) {
    out.push(text.slice(i, i + chunkSize));
  }
  return out;
}

// Convert OpenAI messages[] to a single prompt.
export type SystemMessagePolicy = "all" | "none" | "first" | "last";

export type FlattenMessagesOptions = {
  systemMessages?: SystemMessagePolicy;
  systemMaxChars?: number;
};

function normalizeRole(role: unknown): string {
  return (role ?? "user").toString().trim().toLowerCase();
}

function extractMessageContent(message: any): string {
  if (typeof message?.content === "string") return message.content;

  if (Array.isArray(message?.content)) {
    return message.content
      .map((p: any) => {
        if (typeof p === "string") return p;
        if (typeof p?.text === "string") return p.text;
        if (typeof p?.content === "string") return p.content;
        return "";
      })
      .join("");
  }

  return (message?.content ?? "").toString();
}

function capString(s: string, maxChars: number): string {
  if (!Number.isFinite(maxChars) || maxChars <= 0) return s;
  if (s.length <= maxChars) return s;
  return s.slice(0, maxChars);
}

export function flattenMessages(messages: any[], opts: FlattenMessagesOptions = {}): string {
  if (!Array.isArray(messages)) return "";

  const systemMessagesPolicy: SystemMessagePolicy = opts.systemMessages ?? "all";
  const systemMaxChars = opts.systemMaxChars ?? 0;

  const systemIndexes: number[] = [];
  for (let i = 0; i < messages.length; i += 1) {
    if (normalizeRole(messages[i]?.role) === "system") systemIndexes.push(i);
  }

  let keepSystemIndex: number | null = null;
  if (systemMessagesPolicy === "first") keepSystemIndex = systemIndexes[0] ?? null;
  if (systemMessagesPolicy === "last") keepSystemIndex = systemIndexes.length ? systemIndexes[systemIndexes.length - 1] : null;

  return messages
    .filter((m, idx) => {
      const role = normalizeRole(m?.role);
      if (role !== "system") return true;

      if (systemMessagesPolicy === "none") return false;
      if (systemMessagesPolicy === "all") return true;
      return keepSystemIndex === idx;
    })
    .map((m) => {
      const role = normalizeRole(m?.role).toUpperCase();

      let content = extractMessageContent(m);
      if (normalizeRole(m?.role) === "system") {
        content = capString(content, systemMaxChars);
      }

      return `${role}:\n${content}`;
    })
    .join("\n\n");
}

// Extract text from Codex MCP tool result (best-effort).
export function extractTextFromToolResult(result: any): string {
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
