const express = require("express");
const bodyParser = require("body-parser");
const { spawn } = require("child_process");

const app = express();
app.use(bodyParser.json({ limit: "10mb" }));

// Spawn Codex MCP server (stdio transport)
const codex = spawn("codex", ["mcp-server"], {
  stdio: ["pipe", "pipe", "inherit"],
});

let buf = "";
const pending = [];
// pending = [{ startedAt, res, timeoutAt }]

codex.stdout.on("data", (data) => {
  buf += data.toString("utf8");

  // MCP messages are line-delimited JSON
  let idx;
  while ((idx = buf.indexOf("\n")) !== -1) {
    const line = buf.slice(0, idx).trim();
    buf = buf.slice(idx + 1);

    if (!line) continue;

    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      continue;
    }

    // Naive: fulfill the oldest pending HTTP request with the next JSON message.
    const next = pending.shift();
    if (next) next.res.json(msg);
  }
});

codex.on("exit", (code, signal) => {
  console.error(`codex mcp-server exited (code=${code}, signal=${signal})`);
  // Fail any pending requests
  while (pending.length) {
    const p = pending.shift();
    p.res.status(502).json({ error: "codex mcp-server exited" });
  }
});

app.post("/mcp", (req, res) => {
  const payload = JSON.stringify(req.body);

  // Write request to Codex
  codex.stdin.write(payload + "\n");

  // Wait for next response line (2s timeout)
  const timeoutAt = Date.now() + 2000;
  pending.push({ res, timeoutAt });

  const t = setInterval(() => {
    const i = pending.findIndex((p) => p.res === res);
    if (i === -1) {
      clearInterval(t);
      return;
    }
    if (Date.now() > pending[i].timeoutAt) {
      pending.splice(i, 1);
      clearInterval(t);
      res.status(504).json({ error: "timeout waiting for codex response" });
    }
  }, 25);
});

app.get("/health", (_req, res) => {
  res.json({ ok: true, pid: codex.pid });
});

app.listen(3333, () => {
  console.log("MCP HTTP bridge running at http://localhost:3333");
});
