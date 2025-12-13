export function log(...args: any[]) {
  // stderr-only logging so stdout stays reserved for MCP JSON-RPC.
  process.stderr.write(`${new Date().toISOString()} ${args.join(" ")}\n`);
}
