// MCP over stdio: newline-delimited JSON-RPC 2.0. stdout carries protocol
// messages only; diagnostics go to stderr. Requests are answered as they
// finish, so a long wait cannot block a ping or another call.
import { createInterface } from "node:readline";
import { type BrokerPortOptions, brokerPort } from "./broker-port";
import { handleMessage, rpcError } from "./rpc";
import type { AgentPort } from "./tools";

export interface StdioIO {
  lines: AsyncIterable<string>;
  write(message: unknown): void;
}

export function processIO(): StdioIO {
  const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
  return {
    lines,
    write: (message) => {
      process.stdout.write(`${JSON.stringify(message)}\n`);
    },
  };
}

async function respond(line: string, port: AgentPort, io: StdioIO) {
  let message: unknown;
  try {
    message = JSON.parse(line);
  } catch {
    io.write(rpcError(null, -32700, "Parse error"));
    return;
  }
  try {
    const reply = await handleMessage(message, port);
    if (reply !== undefined) io.write(reply);
  } catch {
    process.stderr.write("homectl mcp: internal error handling a message\n");
    io.write(rpcError(null, -32603, "Internal error"));
  }
}

export async function serveStdio(
  port: AgentPort,
  io: StdioIO = processIO(),
): Promise<void> {
  const pending = new Set<Promise<void>>();
  for await (const raw of io.lines) {
    const line = raw.trim();
    if (!line) continue;
    const work = respond(line, port, io);
    pending.add(work);
    void work.finally(() => pending.delete(work));
  }
  await Promise.all(pending);
}

// `home-ctl mcp`: the MCP server for a locally connected agent.
export function runMcpStdio(options: BrokerPortOptions = {}) {
  return serveStdio(brokerPort(options));
}
