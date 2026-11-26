// Canary scan after a full provide -> use flow (homelab #21 §10: "canary absent
// from agent transcript, logs, persisted data, output, args, sync, backup").
// Every file under the workspace (state, saved commands, history, events,
// backup sources), the output the process wrote, and the workspace sync traffic
// are checked for the canary in raw, base64, base64url, hex and URL-encoded
// form. A control test proves the same scan finds each form when it is present.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { callBroker } from "../src/broker/client";
import { startDaemon } from "../src/broker/daemon";
import type { FileVerifier } from "../src/broker/owner";
import { compatPaths } from "../src/broker/paths";
import { canaryLeaks } from "../src/secrets";
import {
  flushLocalCommandHistory,
  recordLocalCommand,
} from "../src/command-history";
import { SavedCommandStore } from "../src/saved-commands";
import { backupFiles } from "../src/workspace/wiring";
import { fixture, type Harness, link } from "./workspace-helpers";

// Canary only. Never a real credential.
const CANARY = "CANARY-scan-3e7a-do-not-leak!";
const PASSWORD = "owner scan pass";
const destination = {
  kind: "ssh-stdin",
  host: "pc",
  argv: ["docker", "login", "--password-stdin"],
};

type Daemon = Awaited<ReturnType<typeof startDaemon>>;
let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "homectl-canary-scan-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function filesUnder(root: string): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) out.push(...(await filesUnder(path)));
    else if (entry.isFile()) out.push(path);
  }
  return out;
}

// Reads every file as raw bytes (latin1 keeps each byte), then looks for the
// canary in every encoded form. Reports leaks by file name.
async function scanTree(
  root: string,
): Promise<{ files: string[]; leaks: string[] }> {
  const files = await filesUnder(root);
  const texts = await Promise.all(
    files.map(async (file) => (await readFile(file)).toString("latin1")),
  );
  return { files, leaks: namedLeaks(texts, files) };
}

function namedLeaks(texts: string[], names: string[]): string[] {
  return canaryLeaks(texts, [CANARY]).map((leak) => {
    const index = Number(/texts\[(\d+)\]/.exec(leak)?.[1]);
    return `${names[index] ?? "?"}: ${leak}`;
  });
}

// Captures what this process writes to stdout, stderr and the console while the
// flow runs. Output still reaches the real streams.
function captureOutput() {
  const chunks: string[] = [];
  const restores: (() => void)[] = [];
  for (const stream of [process.stdout, process.stderr]) {
    const original = stream.write.bind(stream);
    stream.write = ((chunk: unknown, ...rest: unknown[]) => {
      chunks.push(String(chunk));
      return (original as (...args: unknown[]) => boolean)(chunk, ...rest);
    }) as typeof stream.write;
    restores.push(() => {
      stream.write = original as typeof stream.write;
    });
  }
  for (const method of ["log", "info", "warn", "error", "debug"] as const) {
    const original = console[method].bind(console);
    console[method] = ((...args: unknown[]) => {
      chunks.push(args.map(String).join(" "));
      original(...args);
    }) as typeof console.log;
    restores.push(() => {
      console[method] = original as typeof console.log;
    });
  }
  return {
    chunks,
    stop: () => {
      for (const restore of restores.splice(0)) restore();
    },
  };
}

async function boot(
  ran: { argv: string[]; stdin?: string }[],
): Promise<Daemon> {
  const inventoryPath = join(dir, "inventory.yaml");
  return startDaemon({
    mode: "compat",
    ...compatPaths(inventoryPath),
    inventoryPath,
    sshConfigPath: join(dir, "ssh_config"),
    executor: {
      run: async ({ argv, stdin }) => {
        ran.push({ argv, ...(stdin === undefined ? {} : { stdin }) });
        // A careless remote command: it echoes its input to stdout and stderr.
        return {
          exitCode: 0,
          stdout: `got ${stdin}`,
          stderr: `stderr ${stdin}`,
        };
      },
    },
  });
}

// The timeout is 20 s on purpose, not a retry. On Windows, every protected file
// write runs protect() (src/platform.ts), which starts PowerShell to set an
// owner-only ACL, about 200 ms per file. Each owner-password check runs argon2id
// at 64 MB (src/broker/owner.ts), about 200 ms per check. This flow does both
// many times, and measured 3.7-4.2 s on an idle Windows PC and 5.0-5.1 s under
// load. Those costs are the security behaviour, so they stay; the test is only
// allowed the time they need.
test("the full provide -> use flow leaves the canary out of every file, stream and sync payload", async () => {
  const inventoryPath = join(dir, "inventory.yaml");
  await writeFile(
    inventoryPath,
    "version: 1\nmachines:\n  pc:\n    description: this computer\n    transport: local\n    access: user\n",
  );
  await writeFile(
    join(dir, "known_hosts"),
    "pc ssh-ed25519 AAAA-public-only\n",
  );
  // Non-secret saved command and local history, so those stores are on disk.
  await SavedCommandStore.forInventory(inventoryPath).save({
    name: "Restart service",
    hosts: ["pc"],
    argv: ["systemctl", "restart", "{{unit}}"],
    parameters: [{ name: "unit", description: "Service unit" }],
    description: "Restart one named service",
  });
  recordLocalCommand({
    inventoryPath,
    host: "pc",
    argv: ["uptime"],
    phase: "outcome",
    status: "succeeded",
    policyDecision: "allowed",
    operationId: "op-local-1",
    exitCode: 0,
  });
  await flushLocalCommandHistory(inventoryPath);

  const ran: { argv: string[]; stdin?: string }[] = [];
  const seen: unknown[] = [];
  const capture = captureOutput();
  let daemon: Daemon | undefined;
  let pending: unknown[] = [];
  try {
    daemon = await boot(ran);
    await (daemon.verifier as FileVerifier).set(PASSWORD);
    const { token: owner } = await callBroker<{ token: string }>(
      "/v1/owner/login",
      { password: PASSWORD },
      { endpoint: daemon.endpoint },
    );
    const asOwner = {
      endpoint: daemon.endpoint,
      authorization: `Owner ${owner}`,
    };
    const created = await callBroker<{ token: string }>(
      "/v1/owner/clients/create",
      { id: "codex-pc", name: "Codex", hosts: ["pc"], password: PASSWORD },
      asOwner,
    );
    const agent = {
      endpoint: daemon.endpoint,
      authorization: `Bearer ${created.token}`,
    };
    const request = await callBroker<{ id: string }>(
      "/v1/secret/request",
      { purpose: "registry login", destination, fields: [{ name: "token" }] },
      agent,
    );
    seen.push(request);
    const provided = await callBroker(
      "/v1/owner/secrets/provide",
      {
        id: request.id,
        values: { token: CANARY },
        retention: "ephemeral",
        password: PASSWORD,
      },
      asOwner,
    );
    seen.push(provided);
    const status = await callBroker<{ ref: string }>(
      "/v1/secret/status",
      { id: request.id },
      agent,
    );
    seen.push(status);
    const used = await callBroker(
      "/v1/secret/use",
      { ref: status.ref, destination },
      agent,
    );
    seen.push(used);
    seen.push(await callBroker("/v1/owner/secrets/history", {}, asOwner));
    // The value really reached the command, so the scans below are meaningful.
    expect(ran).toEqual([{ argv: destination.argv, stdin: CANARY }]);
    pending = await daemon.broker.pending();
  } finally {
    capture.stop();
    await daemon?.stop();
  }

  // Agent-visible transcript: every response the agent or owner saw.
  expect(canaryLeaks([JSON.stringify(seen)], [CANARY])).toEqual([]);
  // The daemon's output streams.
  expect(canaryLeaks(capture.chunks, [CANARY])).toEqual([]);

  // Everything on disk under the workspace: state, saved commands, history,
  // events, and the backup sources (inventory, known_hosts, policy).
  const tree = await scanTree(dir);
  const names = tree.files.map((file) =>
    relative(dir, file).replaceAll("\\", "/"),
  );
  for (const expected of [
    "inventory.yaml",
    "known_hosts",
    "saved-commands.json",
    "history/commands.jsonl",
    "broker/clients.json",
  ])
    expect(names).toContain(expected);
  expect(tree.leaks).toEqual([]);

  // Workspace sync: the backup sources and the pending operations this flow
  // produced go to a server over the channel. Every request is recorded.
  const h: Harness = await fixture();
  try {
    await link(h);
    const wire: string[] = [];
    const inner = h.post;
    h.post = async (path, value) => {
      wire.push(JSON.stringify({ path, value }));
      return inner(path, value);
    };
    h.ops = pending as Harness["ops"];
    h.files = await backupFiles(inventoryPath, join(dir, "broker"));
    expect(h.files.map((file) => file.path)).toContain("known_hosts");
    expect((await h.client.backupOnce())?.seq).toBe(1);
    await h.client.syncOnce();
    expect(wire.length).toBeGreaterThan(2);
    expect(
      namedLeaks(
        wire,
        wire.map((_, i) => `wire[${i}]`),
      ),
    ).toEqual([]);
    // The plaintext the client assembles for sync and backup, before sealing.
    const plain = [
      ...h.files.map((file) => Buffer.from(file.data).toString("latin1")),
      JSON.stringify(h.ops),
    ];
    expect(canaryLeaks(plain, [CANARY])).toEqual([]);
    // Server and client workspace directories after the sync.
    expect((await scanTree(h.serverDir)).leaks).toEqual([]);
    expect((await scanTree(h.clientDir)).leaks).toEqual([]);
  } finally {
    await h.cleanup();
  }
}, 20_000);

test("scanner control: each encoded form of a planted canary is found in its file", async () => {
  const forms: Record<string, string> = {
    "raw.txt": CANARY,
    "base64.txt": Buffer.from(CANARY).toString("base64"),
    "base64url.txt": Buffer.from(CANARY).toString("base64url"),
    "hex.txt": Buffer.from(CANARY).toString("hex"),
    "url.txt": encodeURIComponent(CANARY),
  };
  for (const [name, text] of Object.entries(forms))
    await writeFile(join(dir, name), `prefix ${text} suffix`);
  await writeFile(join(dir, "binary.bin"), Buffer.from(CANARY));
  await writeFile(join(dir, "clean.txt"), "nothing to see");
  const { files, leaks } = await scanTree(dir);
  expect(files).toHaveLength(Object.keys(forms).length + 2);
  for (const name of [...Object.keys(forms), "binary.bin"])
    expect(leaks.some((leak) => leak.startsWith(`${join(dir, name)}:`))).toBe(
      true,
    );
  expect(leaks.some((leak) => leak.includes("clean.txt"))).toBe(false);
});
