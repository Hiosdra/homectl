import { chmod, lstat, mkdir, unlink } from "node:fs/promises";
import { createConnection } from "node:net";
import { resolve } from "node:path";
import { cleanEnv } from "../credentials";
import { HomectlError, type Inventory } from "../types";
import { sessionConfig, sessionPaths, ttlSeconds } from "./config";

export { sessionConfig, sessionPaths, ttlSeconds } from "./config";
export type SessionStatus = {
  unlocked: boolean;
  startedAt?: number;
  expiresAt?: number | null;
};

export async function sessionStatus(
  inventoryPath: string,
): Promise<SessionStatus> {
  const state = await control(inventoryPath, "status");
  if (state.expiresAt && state.expiresAt <= Date.now()) {
    await lockSession(inventoryPath);
    return { unlocked: false };
  }
  return state;
}
async function control(
  inventoryPath: string,
  command: string,
): Promise<SessionStatus> {
  return new Promise((resolve) => {
    const client = createConnection(sessionPaths(inventoryPath).control);
    let data = "";
    client.setTimeout(2000, () => client.destroy());
    client.on("connect", () => client.write(`${command}\n`));
    client.on("data", (chunk) => {
      data += chunk.toString();
      if (data.length > 1024) client.destroy();
    });
    client.on("error", () => resolve({ unlocked: false }));
    client.on("close", () => {
      try {
        resolve(JSON.parse(data));
      } catch {
        resolve({ unlocked: false });
      }
    });
  });
}

export async function lockSession(inventoryPath: string) {
  const p = sessionPaths(inventoryPath);
  // Clear even an orphaned agent; never touch the user's personal agent.
  try {
    await privateCommand(["ssh-add", "-D"], undefined, {
      SSH_AUTH_SOCK: p.socket,
    });
  } catch {}
  await control(inventoryPath, "lock");
  for (let n = 0; n < 100; n++) {
    try {
      await lstat(p.control);
    } catch {
      break;
    }
    await Bun.sleep(20);
  }
  return { unlocked: false };
}

export async function startSession(
  inv: Inventory,
  inventoryPath: string,
): Promise<SessionStatus> {
  const current = await sessionStatus(inventoryPath);
  if (current.unlocked) return current; // Never extend an existing session.
  if (!Bun.which("ssh-agent") || !Bun.which("ssh-add"))
    throw new HomectlError(5, "Install OpenSSH on the agent host");
  const p = sessionPaths(inventoryPath);
  await mkdir(p.directory, { recursive: true, mode: 0o700 });
  const directory = await lstat(p.directory);
  if (!directory.isDirectory() || directory.uid !== process.getuid?.())
    throw new HomectlError(
      3,
      "Session directory must belong to the current user and must not be a symlink",
    );
  await chmod(p.directory, 0o700);
  await lockSession(inventoryPath);
  for (const path of [p.socket, p.control]) {
    try {
      const stat = await lstat(path);
      if (!stat.isSocket())
        throw new HomectlError(
          3,
          "Session socket path conflicts with an existing file",
        );
      await unlink(path);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    }
  }
  const daemon = Bun.spawn(
    [process.execPath, resolve(import.meta.dir, "daemon.ts")],
    {
      env: cleanEnv(),
      stdin: new Blob([
        JSON.stringify({
          ...p,
          ttl: ttlSeconds(sessionConfig(inv, inventoryPath).ttl),
        }),
      ]),
      stdout: "pipe",
      stderr: "ignore",
    },
  );
  const reader = daemon.stdout.getReader();
  const timer = setTimeout(() => daemon.kill(), 5000);
  try {
    const { value } = await reader.read();
    if (!value) throw new Error();
    return JSON.parse(new TextDecoder().decode(value));
  } catch {
    daemon.kill();
    throw new HomectlError(5, "Dedicated SSH agent could not start");
  } finally {
    clearTimeout(timer);
    await reader.cancel();
    reader.releaseLock();
    daemon.unref();
  }
}

// Sensitive subprocess output stays inside the private user-invoked CLI.
// Never return this output in CLI JSON, errors or logs; no argv/env secrets.
export async function privateCommand(
  argv: string[],
  stdin?: string | Uint8Array,
  env?: Record<string, string>,
): Promise<Buffer> {
  const child = (() => {
    try {
      return Bun.spawn(argv, {
        env: { ...cleanEnv(), ...env },
        stdin:
          stdin === undefined
            ? "ignore"
            : new Blob([
                typeof stdin === "string" ? stdin : new Uint8Array(stdin),
              ]),
        stdout: "pipe",
        stderr: "ignore",
      });
    } catch {
      throw new HomectlError(
        5,
        "Credential tool unavailable; install KeePassXC and OpenSSH",
      );
    }
  })();
  const timeout = setTimeout(() => child.kill(), 30_000);
  try {
    const [output, code] = await Promise.all([
      new Response(child.stdout).arrayBuffer(),
      child.exited,
    ]);
    const bytes = Buffer.from(output);
    if (code !== 0) {
      bytes.fill(0);
      throw new HomectlError(
        5,
        "Private credential operation failed; check database password, entry or tool installation. Output suppressed.",
      );
    }
    return bytes;
  } finally {
    clearTimeout(timeout);
  }
}

export async function readPassword(
  prompt = "KeePassXC database password: ",
): Promise<string> {
  if (!process.stdin.isTTY)
    throw new HomectlError(
      5,
      "Run this command yourself in a private interactive terminal; never send the database password to the agent",
    );
  const child = Bun.spawn(
    [
      "bash",
      "-c",
      'IFS= read -r -s -p "$1" password </dev/tty || exit 1; printf "\\n" >/dev/tty; printf "%s" "$password"',
      "homectl-password",
      prompt,
    ],
    {
      env: cleanEnv(),
      stdin: "inherit",
      stdout: "pipe",
      stderr: "inherit",
    },
  );
  const result = await new Response(child.stdout).text();
  if (
    (await child.exited) ||
    !result ||
    result.includes("\n") ||
    result.includes("\r")
  )
    throw new HomectlError(
      2,
      "Password entry cancelled or unsupported newline",
    );
  return result;
}

export async function databaseCommand(
  database: string,
  password: string,
  args: string[],
) {
  return privateCommand(
    [
      "keepassxc-cli",
      args[0] ?? "db-info",
      "--quiet",
      database,
      ...args.slice(1),
    ],
    `${password}\n`,
  );
}
export async function loadKey(
  key: Uint8Array,
  inventoryPath: string,
  state: SessionStatus,
) {
  const remaining =
    state.expiresAt === null
      ? null
      : Math.floor(((state.expiresAt ?? 0) - Date.now()) / 1000);
  if (remaining !== null && remaining < 1)
    throw new HomectlError(5, "Session TTL expired; unlock again");
  const args = [
    "ssh-add",
    ...(remaining === null ? [] : ["-t", String(remaining)]),
    "-",
  ];
  await privateCommand(args, key, {
    SSH_AUTH_SOCK: sessionPaths(inventoryPath).socket,
  });
}

export async function unlockSession(
  inv: Inventory,
  inventoryPath: string,
  passwordPrompt: () => Promise<string> = readPassword,
) {
  const current = await sessionStatus(inventoryPath);
  if (current.unlocked)
    return {
      ...current,
      note: "Existing expiry retained; lock first to begin a new session",
    };
  const hosts = Object.values(inv.machines).filter(
    (m) => m.auth?.type === "keepassxc",
  );
  if (!Bun.which("keepassxc-cli"))
    throw new HomectlError(5, "Install KeePassXC on the agent host first");
  if (!hosts.length)
    throw new HomectlError(
      2,
      "No SSH hosts enrolled; create a key and enroll a host first",
    );
  const config = sessionConfig(inv, inventoryPath);
  if (!(await Bun.file(config.database).exists()))
    throw new HomectlError(
      5,
      "Database not found; initialize or configure the homelab database privately",
    );
  const password = await passwordPrompt();
  const state = await startSession(inv, inventoryPath);
  try {
    for (const m of hosts) {
      if (m.auth?.socket !== sessionPaths(inventoryPath).socket)
        throw new HomectlError(
          2,
          "KeePassXC host socket does not match this inventory's managed session",
        );
      const key = await databaseCommand(config.database, password, [
        "attachment-export",
        "--stdout",
        m.auth.entry ?? "",
        "id_ed25519",
      ]);
      try {
        await loadKey(key, inventoryPath, state);
      } finally {
        key.fill(0);
      }
    }
  } catch (e) {
    await lockSession(inventoryPath);
    throw e;
  }
  return { ...state, keysLoaded: hosts.length };
}
