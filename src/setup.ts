import { createHash } from "node:crypto";
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
export async function installAAC(
  version: string,
  digest: string,
  home = homedir(),
) {
  if (
    !/^v?\d+\.\d+\.\d+(?:[-.][A-Za-z0-9.-]+)?$/.test(version) ||
    !/^[a-f0-9]{64}$/.test(digest)
  )
    throw new HomectlError(
      2,
      "Supply a pinned release version and independently verified archive SHA256",
    );
  const platform =
    process.platform === "darwin"
      ? "macos"
      : process.platform === "linux"
        ? "linux"
        : "";
  const arch =
    process.arch === "arm64"
      ? "aarch64"
      : process.arch === "x64"
        ? "x86_64"
        : "";
  if (!platform || !arch || (platform === "linux" && arch !== "x86_64"))
    throw new HomectlError(
      2,
      "No researched official AAC release for this platform; install supported client manually",
    );
  const p = paths(home);
  const target = join(p.bin, "aac");
  if (await exists(target))
    throw new HomectlError(
      3,
      "aac already exists; replacement is a separate operation",
    );
  const response = await fetch(
    `https://github.com/bitwarden/agent-access/releases/download/${version}/aac-${platform}-${arch}.tar.gz`,
    { signal: AbortSignal.timeout(60_000) },
  );
  if (!response.ok) throw new HomectlError(5, "AAC release download failed");
  const data = new Uint8Array(await response.arrayBuffer());
  if (createHash("sha256").update(data).digest("hex") !== digest)
    throw new HomectlError(5, "AAC checksum mismatch");
  const temp = join(p.base, `aac-install-${crypto.randomUUID()}`);
  await mkdir(temp, { recursive: true, mode: 0o700 });
  const archive = join(temp, "release.tar.gz");
  await writeFile(archive, data, { mode: 0o600 });
  const list = await run({ argv: ["tar", "-tzf", archive] });
  if (list.exitCode !== 0 || list.stdout.trim() !== "aac")
    throw new HomectlError(5, "Unexpected AAC archive contents");
  const extract = await run({
    argv: ["tar", "-xzf", archive, "-C", temp, "aac"],
  });
  if (extract.exitCode !== 0)
    throw new HomectlError(5, "AAC extraction failed");
  await mkdir(p.bin, { recursive: true, mode: 0o700 });
  await writeFile(
    target,
    new Uint8Array(await Bun.file(join(temp, "aac")).arrayBuffer()),
    { mode: 0o755, flag: "wx" },
  );
  return {
    installed: target,
    note: `Verified installation files retained in ${temp}; no automatic deletions`,
  };
}
export async function doctor(
  inventory: Inventory,
  configPath: string,
  host?: string,
  runner: Runner = run,
) {
  const checks: { name: string; ok: boolean; remediation?: string }[] = [];
  for (const tool of ["ssh", "bun", "aac", "bw"]) {
    if (tool === "bw") {
      const available = Boolean(Bun.which("bw"));
      checks.push({
        name: tool,
        ok: available,
        remediation: available
          ? undefined
          : "Install @bitwarden/cli when using AAC Bitwarden provider",
      });
      continue;
    }
    const argv =
      tool === "aac"
        ? ["aac", "run", "--help"]
        : [tool, tool === "ssh" ? "-V" : "--version"];
    try {
      const r = await runner({ argv, timeoutMs: 10_000 });
      checks.push({
        name: tool,
        ok: r.exitCode === 0 && (tool !== "aac" || r.stdout.includes("--env")),
        remediation:
          tool === "aac"
            ? "Install a supported pinned Agent Access release; pair via aac listen/connect in a private terminal"
            : "Install tool on the agent host",
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
          .filter(
            (c) => ["ssh", "bun"].includes(c.name) || c.name.includes(":"),
          )
          .every((c) => c.ok),
        note: "AAC/bw are optional for key-only hosts; availability is not proof of provider pairing. No credentials are fetched for tool checks.",
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
      .filter((c) => ["ssh", "bun"].includes(c.name) || c.name.includes(":"))
      .every((c) => c.ok),
    note: "AAC/bw are optional for key-only hosts; availability is not proof of provider pairing. No credentials are fetched for tool checks.",
  };
}
