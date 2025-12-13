import type { Request, Response } from "express";

const API_KEY = process.env.API_KEY ?? "";
const API_KEY_HEADER = (process.env.API_KEY_HEADER ?? "authorization").toLowerCase();
const REQUIRE_BEARER = (process.env.REQUIRE_BEARER ?? "0") === "1";

function getAuthValue(req: Request): string {
  const v = req.headers[API_KEY_HEADER];
  if (!v) return "";
  if (Array.isArray(v)) return v[0] ?? "";
  return String(v);
}

export function checkAuth(req: Request): boolean {
  if (!API_KEY) return true;

  const raw = getAuthValue(req).trim();
  if (!raw) return false;

  if (API_KEY_HEADER === "authorization") {
    const m = /^Bearer\s+(.+)$/.exec(raw);
    if (m) return m[1] === API_KEY;
    return REQUIRE_BEARER ? false : raw === API_KEY;
  }

  return raw === API_KEY;
}

export function unauthorized(res: Response) {
  res.status(401).json({ error: { message: "Unauthorized", type: "auth_error" } });
}

export function authStatusForLogs(): string {
  return API_KEY ? `enabled (${API_KEY_HEADER})` : "disabled";
}
