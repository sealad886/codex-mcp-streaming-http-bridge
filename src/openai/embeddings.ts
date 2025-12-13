import type { Request, Response } from "express";
import crypto from "crypto";

export function handleEmbeddings(req: Request, res: Response, defaultModelId: string) {
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
    model: req.body?.model ?? defaultModelId,
    usage: { prompt_tokens: 0, total_tokens: 0 },
  });
}
