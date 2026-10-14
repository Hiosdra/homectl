import { spawn } from "node:child_process";
import { createPrivateKey } from "node:crypto";
import { lstat, unlink } from "node:fs/promises";
import { createConnection } from "node:net";
import { resolve } from "node:path";
import { cleanEnv } from "../credentials";
import { available, executable, privateDirectory, windows } from "../platform";
import { HomectlError, type Inventory } from "../types";
import { addKey } from "./agent";
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
    if (!windows)
      await privateCommand(["ssh-add", "-D"], undefined, {
        SSH_AUTH_SOCK: p.socket,
      });
  } catch {}
  await control(inventoryPath, "lock");
  for (let n = 0; !windows && n < 100; n++) {
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
  if ((!windows && !available("ssh-agent")) || !available("ssh-add"))
    throw new HomectlError(5, "Install OpenSSH on the agent host");
  const p = sessionPaths(inventoryPath);
  await privateDirectory(p.directory);
  await lockSession(inventoryPath);
  for (const path of windows ? [] : [p.socket, p.control]) {
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
  if (windows) {
    const daemon = spawn(
      process.execPath,
      [resolve(import.meta.dir, "daemon.ts")],
      {
        detached: true,
        windowsHide: true,
        env: cleanEnv(),
        stdio: ["pipe", "ignore", "ignore"],
      },
    );
    let failed = false;
    daemon.on("error", () => {
      failed = true;
    });
    daemon.stdin?.on("error", () => {
      failed = true;
    });
    daemon.stdin?.end(
      JSON.stringify({
        ...p,
        ttl: ttlSeconds(sessionConfig(inv, inventoryPath).ttl),
      }),
    );
    daemon.unref();
    for (let attempt = 0; attempt < 100; attempt++) {
      if (failed || daemon.exitCode !== null) break;
      const ready = await sessionStatus(inventoryPath);
      if (ready.unlocked) return ready;
      await Bun.sleep(50);
    }
    daemon.kill();
    throw new HomectlError(5, "Detached Windows SSH session could not start");
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
      return Bun.spawn([executable(argv[0] ?? ""), ...argv.slice(1)], {
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
    windows
      ? [
          "powershell.exe",
          "-NoProfile",
          "-Command",
          "$p=Read-Host -Prompt $env:HOMECTL_PROMPT -AsSecureString; $b=[Runtime.InteropServices.Marshal]::SecureStringToBSTR($p); try {[Console]::Out.Write([Runtime.InteropServices.Marshal]::PtrToStringBSTR($b))} finally {[Runtime.InteropServices.Marshal]::ZeroFreeBSTR($b)}",
        ]
      : [
          "bash",
          "-c",
          'IFS= read -r -s -p "$1" password </dev/tty || exit 1; printf "\\n" >/dev/tty; printf "%s" "$password"',
          "homectl-password",
          prompt,
        ],
    {
      env: { ...cleanEnv(), HOMECTL_PROMPT: prompt },
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
  entryPassword?: string,
) {
  return privateCommand(
    [
      "keepassxc-cli",
      args[0] ?? "db-info",
      "--quiet",
      database,
      ...args.slice(1),
    ],
    `${password}\n${entryPassword === undefined ? "" : `${entryPassword}\n`}`,
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
  await addKey(
    sessionPaths(inventoryPath).socket,
    key,
    windows || remaining === null ? undefined : remaining,
  );
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
  if (!available("keepassxc-cli"))
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
      const key = await readStoredKey(
        config.database,
        password,
        m.auth.entry ?? "",
      );
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

export async function readStoredKey(
  database: string,
  password: string,
  entry: string,
) {
  const bytes = await databaseCommand(database, password, [
    "attachment-export",
    "--stdout",
    entry,
    "id_ed25519",
  ]);
  if (!bytes.toString().includes("BEGIN ENCRYPTED PRIVATE KEY")) return bytes;
  const passphrase = await databaseCommand(database, password, [
    "show",
    "--show-protected",
    "--attributes",
    "Password",
    entry,
  ]);
  try {
    return Buffer.from(
      createPrivateKey({
        key: bytes,
        passphrase: passphrase.toString().trimEnd(),
      }).export({ type: "pkcs8", format: "pem" }),
    );
  } finally {
    bytes.fill(0);
    passphrase.fill(0);
  }
}
