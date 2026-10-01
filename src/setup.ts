import {
  access,
  lstat,
  mkdir,
  readFile,
  symlink,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { probeFailureMessage } from "./diagnostics";
import { saveInventory } from "./inventory";
import { writeSSHConfig } from "./operations";
import { run } from "./process";
import { sessionConfig } from "./session/config";
import {
  HomectlError,
  type Inventory,
  type ProcessResult,
  type Runner,
} from "./types";
export const repoRoot = resolve(import.meta.dir, "..");
export function paths(home = homedir()) {
  const base = join(home, ".config", "homectl");
  return {
    home,
    base,
    inventory: join(base, "inventory.yaml"),
    ssh: join(base, "ssh_config"),
    state: join(base, "state"),
    bin: join(home, ".local", "bin"),
  };
}
export async function exists(path: string) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}
async function link(source: string, target: string) {
  try {
    const stat = await lstat(target);
    if (
      stat.isSymbolicLink() &&
      (await Bun.file(join(target, "SKILL.md")).exists()) &&
      (await Bun.file(join(source, "SKILL.md")).text()) ===
        (await Bun.file(join(target, "SKILL.md")).text())
    )
      return;
    throw new HomectlError(
      3,
      `Existing path conflicts: ${target}; replacement requires separate explicit approval`,
    );
  } catch (e) {
    if (e instanceof HomectlError) throw e;
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
  }
  await symlink(source, target);
}
export async function setup(home = homedir(), dryRun = false) {
  const p = paths(home);
  const initial: Inventory = {
    version: 1,
    session: sessionConfig({ version: 1, machines: {} }, p.inventory),
    machines: {
      "agent-host": {
        description: "Machine running the current coding agent",
        transport: "local",
        access: process.getuid?.() === 0 ? "full" : "user",
        enforcement: "advisory",
        caution:
          process.getuid?.() === 0
            ? [
                "Current Unix account is root; choose a non-root user for limited local access",
              ]
            : [],
      },
    },
  };
  const actions = [
    `Create inventory if missing: ${p.inventory}`,
    `Generate SSH config: ${p.ssh}`,
    `Add Include to ${join(home, ".ssh", "config")}`,
    `Link CLI in ${p.bin}`,
    `Link 3 skills in ~/.agents/skills and ~/.claude/skills`,
  ];
  if (dryRun) return { actions };
  if (!(await exists(p.inventory))) await saveInventory(p.inventory, initial);
  const inventory = await (await import("./inventory")).loadInventory(
    p.inventory,
  );
  await writeSSHConfig(p.ssh, inventory.machines);
  for (const platform of [".agents", ".claude"]) {
    const dest = join(home, platform, "skills");
    await mkdir(dest, { recursive: true, mode: 0o700 });
    for (const skill of ["homelab", "homelab-setup", "homelab-enroll"])
      await link(join(repoRoot, "skills", skill), join(dest, skill));
  }
  await mkdir(p.bin, { recursive: true, mode: 0o700 });
  const cli = join(p.bin, "homectl");
  const script = `#!/bin/sh\nexec '${process.execPath.replaceAll("'", "'\\''")}' '${join(repoRoot, "src", "cli", "main.ts").replaceAll("'", "'\\''")}' "$@"\n`;
  if ((await exists(cli)) && (await readFile(cli, "utf8")) !== script)
    throw new HomectlError(
      3,
      "Existing homectl launcher differs; refuse to overwrite",
    );
  await writeFile(cli, script, { mode: 0o755 });
  const sshMain = join(home, ".ssh", "config");
  await mkdir(dirname(sshMain), { recursive: true, mode: 0o700 });
  const include = `Include "${p.ssh.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
  const old = (await exists(sshMain)) ? await readFile(sshMain, "utf8") : "";
  if (!old.split("\n").includes(include))
    await writeFile(sshMain, `${include}\n${old}`, { mode: 0o600 });
  return {
    actions,
    inventory: p.inventory,
    next: "Run homectl doctor; ensure ~/.local/bin is on PATH. Keep this checkout in a stable location.",
  };
}
export async function doctor(
  inventory: Inventory,
  configPath: string,
  host?: string,
  runner: Runner = run,
) {
  const checks: { name: string; ok: boolean; remediation?: string }[] = [];
  const selected = host
    ? [inventory.machines[host]]
    : Object.values(inventory.machines);
  const usesKeepass = selected.some((m) => m?.auth?.type === "keepassxc");
  const required = new Set([
    "ssh",
    "bun",
    ...(usesKeepass ? ["ssh-agent", "ssh-add", "keepassxc-cli"] : []),
  ]);
  for (const tool of required) {
    if (["ssh-agent", "ssh-add", "keepassxc-cli"].includes(tool)) {
      const available = Boolean(Bun.which(tool));
      checks.push({
        name: tool,
        ok: available,
        remediation: available
          ? undefined
          : tool === "keepassxc-cli"
            ? "Install KeePassXC on the agent host"
            : "Install OpenSSH",
      });
      continue;
    }
    try {
      const r = await runner({
        argv: [tool, tool === "ssh" ? "-V" : "--version"],
        timeoutMs: 10_000,
      });
      checks.push({
        name: tool,
        ok: r.exitCode === 0,
        remediation: r.exitCode
          ? `Install ${tool} on the agent host`
          : undefined,
      });
    } catch {
      checks.push({
        name: tool,
        ok: false,
        remediation: `Install ${tool} on the agent host`,
      });
    }
  }
  if (host) {
    const m = inventory.machines[host];
    if (!m) throw new HomectlError(2, "Unknown host");
    const { credentialSpec } = await import("./credentials");
    const { transportSpec } = await import("./transports");
    const { workerPath } = await import("./operations");
    let result: ProcessResult;
    try {
      result = await runner(
        credentialSpec(
          m.auth,
          transportSpec(m, ["uname", "-s"], configPath),
          workerPath,
        ),
      );
    } catch {
      checks.push({
        name: `${host}:connectivity`,
        ok: false,
        remediation: probeFailureMessage(),
      });
      return {
        checks,
        ok: checks
          .filter((c) => required.has(c.name) || c.name.includes(":"))
          .every((c) => c.ok),
        note: "Tool checks do not open the database. Host probes use only the managed SSH agent; run session unlock privately when needed.",
      };
    }
    checks.push({
      name: `${host}:connectivity`,
      ok: result.exitCode === 0,
      remediation:
        result.exitCode === 0 ? undefined : probeFailureMessage(result),
    });
    if (result.exitCode === 0 && m.access === "full" && m.user !== "root") {
      const args = ["sudo", "-n", "true"]; // Never execute an allowlisted mutation as a diagnostic.
      const r = await runner(
        credentialSpec(m.auth, transportSpec(m, args, configPath), workerPath),
      );
      checks.push({
        name: `${host}:sudo-n`,
        ok: r.exitCode === 0,
        remediation:
          "Configure NOPASSWD for the existing user via initial interactive access",
      });
    }
  }
  return {
    checks,
    ok: checks
      .filter((c) => required.has(c.name) || c.name.includes(":"))
      .every((c) => c.ok),
    note: "Tool checks do not open the database. Host probes use only the managed SSH agent; run session unlock privately when needed.",
  };
}
