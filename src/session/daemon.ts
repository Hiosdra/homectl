import { chmod, lstat, mkdir, unlink } from "node:fs/promises";
import { createServer } from "node:net";
import { cleanEnv } from "../credentials";

// This process holds no database password. Only OpenSSH holds loaded keys.
const config = JSON.parse(await Bun.stdin.text()) as {
  directory: string;
  socket: string;
  control: string;
  ttl: number | null;
};
await mkdir(config.directory, { recursive: true, mode: 0o700 });
const directory = await lstat(config.directory);
if (!directory.isDirectory() || directory.uid !== process.getuid?.())
  process.exit(5);
await chmod(config.directory, 0o700);
const startedAt = Date.now();
const expiresAt = config.ttl === null ? null : startedAt + config.ttl * 1000;
const agent = Bun.spawn(["ssh-agent", "-D", "-a", config.socket], {
  env: cleanEnv(),
  stdin: "ignore",
  stdout: "ignore",
  stderr: "ignore",
});
let stopping = false;
let expiry: ReturnType<typeof setTimeout> | undefined;
const server = createServer((connection) => {
  connection.setTimeout(2000, () => connection.destroy());
  let input = "";
  connection.on("data", (data) => {
    input += data.toString();
    if (input.length > 64) return connection.destroy();
    if (!input.includes("\n")) return;
    if (input.trim() === "status") {
      connection.end(
        `${JSON.stringify({ unlocked: !stopping, startedAt, expiresAt })}\n`,
      );
    } else if (input.trim() === "lock") {
      connection.end('{"unlocked":false}\n');
      void stop();
    } else connection.destroy();
  });
});
async function stop() {
  if (stopping) return;
  stopping = true;
  clearTimeout(expiry);
  server.close();
  agent.kill("SIGTERM");
  await agent.exited;
  for (const path of [config.socket, config.control]) {
    try {
      await unlink(path);
    } catch {}
  }
  process.exit(0);
}
process.on("SIGTERM", () => void stop());
process.on("SIGINT", () => void stop());
for (let attempt = 0; attempt < 100; attempt++) {
  if (agent.exitCode !== null) process.exit(5);
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
void agent.exited.then(() => stop());
