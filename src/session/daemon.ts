import { lstat, unlink } from "node:fs/promises";
import { createServer } from "node:net";
import { cleanEnv } from "../credentials";
import { privateDirectory, windows } from "../platform";
import { createDedicatedAgent } from "./agent";

// This process holds no database password. Only OpenSSH holds loaded keys.
const config = JSON.parse(await Bun.stdin.text()) as {
  directory: string;
  socket: string;
  control: string;
  ttl: number | null;
};
await privateDirectory(config.directory);
const startedAt = Date.now();
const expiresAt = config.ttl === null ? null : startedAt + config.ttl * 1000;
const native = windows
  ? createDedicatedAgent(config.socket, expiresAt)
  : undefined;
if (native) await native.listen();
const agent = windows
  ? undefined
  : Bun.spawn(["ssh-agent", "-D", "-a", config.socket], {
      env: cleanEnv(),
      stdin: "ignore",
      stdout: "ignore",
      stderr: "ignore",
      windowsHide: true,
    });
let stopping = false;
let expiry: ReturnType<typeof setTimeout> | undefined;
// Named secrets (the Proxmox API token header). Held in memory only, and cleared
// when the session locks, expires or stops. Never written to disk.
const secrets = new Map<string, string>();
const SECRET_NAME = /^[a-z][a-z0-9-]{0,62}$/;
const SECRET_LINE_MAX = 8192;
const server = createServer((connection) => {
  connection.setTimeout(2000, () => connection.destroy());
  let input = "";
  connection.on("data", (data) => {
    input += data.toString();
    const putting = input.startsWith("put ");
    if (input.length > (putting ? SECRET_LINE_MAX : 64))
      return connection.destroy();
    if (!input.includes("\n")) return;
    const line = input.trim();
    if (line === "status") {
      connection.end(
        `${JSON.stringify({ unlocked: !stopping, startedAt, expiresAt })}\n`,
      );
    } else if (line === "lock") {
      connection.end('{"unlocked":false}\n');
      void stop();
    } else if (putting) {
      // put <name> <base64 value>
      const [, name, encoded] = line.split(" ");
      if (stopping) return connection.end('{"error":"locked"}\n');
      if (!name || !SECRET_NAME.test(name) || !encoded)
        return connection.destroy();
      secrets.set(name, Buffer.from(encoded, "base64").toString("utf8"));
      connection.end('{"ok":true}\n');
    } else if (line.startsWith("get ")) {
      const name = line.slice(4);
      if (stopping) return connection.end('{"error":"locked"}\n');
      const value = SECRET_NAME.test(name) ? secrets.get(name) : undefined;
      connection.end(
        value === undefined
          ? '{"error":"absent"}\n'
          : `${JSON.stringify({ value })}\n`,
      );
    } else connection.destroy();
  });
});
async function stop() {
  if (stopping) return;
  stopping = true;
  secrets.clear();
  clearTimeout(expiry);
  server.close();
  native?.close();
  agent?.kill("SIGTERM");
  if (agent) await agent.exited;
  for (const path of windows ? [] : [config.socket, config.control]) {
    try {
      await unlink(path);
    } catch {}
  }
  process.exit(0);
}
process.on("SIGTERM", () => void stop());
process.on("SIGINT", () => void stop());
for (let attempt = 0; !windows && attempt < 100; attempt++) {
  if (agent?.exitCode !== null) process.exit(5);
  try {
    if ((await lstat(config.socket)).isSocket()) break;
  } catch {}
  if (attempt === 99) {
    await stop();
    process.exit(5);
  }
  await Bun.sleep(20);
}
server.listen(config.control, () => {
  const scheduleExpiry = () => {
    if (expiresAt === null) return;
    const remaining = expiresAt - Date.now();
    if (remaining <= 0) {
      void stop();
      return;
    }
    expiry = setTimeout(scheduleExpiry, Math.min(remaining, 2_147_483_647));
  };
  scheduleExpiry();
  console.log(JSON.stringify({ unlocked: true, startedAt, expiresAt }));
});
server.on("error", () => void stop());
void agent?.exited.then(() => stop());
