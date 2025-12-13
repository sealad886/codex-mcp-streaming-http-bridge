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
export function flattenMessages(messages: any[]): string {
  if (!Array.isArray(messages)) return "";

  return messages
    .map((m) => {
      const role = (m?.role ?? "user").toString().toUpperCase();

      let content = "";
      if (typeof m?.content === "string") {
        content = m.content;
      } else if (Array.isArray(m?.content)) {
        // Handle "rich" parts; keep text-ish data.
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
