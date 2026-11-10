import { expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { available, windows } from "../src/platform";
import { lockSession, sessionStatus } from "../src/session";

test("managed session survives exit of its unlocking CLI process", async () => {
  if (!available("ssh-add") || (!windows && !available("ssh-agent"))) return;
  const dir = await mkdtemp(join(tmpdir(), "homectl-lifetime-"));
  const inventory = join(dir, "inventory.yaml");
  try {
    const module = resolve(import.meta.dir, "../src/session/index.ts");
    const script = `const {startSession,loadKey}=await import(${JSON.stringify(module)});const {generateKeyPairSync}=await import('node:crypto');const path=process.argv.at(-1);const state=await startSession({version:1,machines:{}},path);const key=generateKeyPairSync('ed25519').privateKey.export({format:'pem',type:'pkcs8'});await loadKey(Buffer.from(key),path,state);process.exit(0);`;
    const child = Bun.spawn([process.execPath, "-e", script, inventory], {
      stdin: "ignore",
      stdout: "ignore",
      stderr: "ignore",
      windowsHide: true,
    });
    expect(await child.exited).toBe(0);
    await Bun.sleep(500);
    const first = await sessionStatus(inventory);
    expect(first.unlocked).toBe(true);
    await Bun.sleep(500);
    expect((await sessionStatus(inventory)).startedAt).toBe(first.startedAt);
  } finally {
    await lockSession(inventory);
    await rm(dir, { recursive: true, force: true });
  }
}, 15000);

test("managed session survives a hangup of the process group that unlocked it", async () => {
  if (windows || !available("ssh-add") || !available("ssh-agent")) return;
  const dir = await mkdtemp(join(tmpdir(), "homectl-hangup-"));
  const inventory = join(dir, "inventory.yaml");
  try {
    const module = resolve(import.meta.dir, "../src/session/index.ts");
    const script = `const {startSession,loadKey}=await import(${JSON.stringify(module)});const {generateKeyPairSync}=await import('node:crypto');const path=process.argv.at(-1);const state=await startSession({version:1,machines:{}},path);const key=generateKeyPairSync('ed25519').privateKey.export({format:'pem',type:'pkcs8'});await loadKey(Buffer.from(key),path,state);process.exit(0);`;
    // The unlocking command leads its own process group, as a terminal job does.
    const starter = spawn(process.execPath, ["-e", script, inventory], {
      detached: true,
      stdio: "ignore",
    });
    const code = await new Promise<number | null>((done) =>
      starter.once("exit", (exitCode) => done(exitCode)),
    );
    expect(code).toBe(0);
    // A closed terminal hangs up that group. The group may already be empty.
    try {
      process.kill(-(starter.pid ?? 0), "SIGHUP");
    } catch {}
    await Bun.sleep(500);
    expect((await sessionStatus(inventory)).unlocked).toBe(true);
  } finally {
    await lockSession(inventory);
    await rm(dir, { recursive: true, force: true });
  }
}, 15000);
