import type { Response } from "express";

export function sseHeaders(res: Response) {
  res.status(200);
  res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");

  // Ensure headers flush quickly (Express doesn't always expose flushHeaders typing)
  (res as any).flushHeaders?.();

  // Force an initial write so clients don't sit there waiting for the first byte.
  res.write(`: connected ${Date.now()}\n\n`);
}

export function sseSend(res: Response, obj: any) {
  res.write(`data: ${JSON.stringify(obj)}\n\n`);
}

export function sseDone(res: Response) {
  res.write("data: [DONE]\n\n");
  res.end();
}
