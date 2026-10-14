import { expect, test } from "bun:test";
import { generateKeyPairSync, verify } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseInventory } from "../src/inventory";
import { collectHostKeys, validateHostKeys } from "../src/peer/hostkeys";
import { privateDirectory, protect, windows } from "../src/platform";
import {
  addKey,
  createDedicatedAgent,
  publicBlob,
  reader,
  sshString,
  u32,
} from "../src/session/agent";
import { sessionPaths } from "../src/session/config";

async function agentRequest(path: string, request: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(path);
    let output = Buffer.alloc(0);
    socket.setTimeout(2000, () => socket.destroy(new Error("timeout")));
    socket.on("error", reject);
    socket.on("connect", () =>
      socket.write(Buffer.concat([u32(request.length), request])),
    );
    socket.on("data", (b: Buffer) => {
      output = Buffer.concat([output, b]);
      if (output.length >= 4 && output.length >= 4 + output.readUInt32BE()) {
        socket.destroy();
        resolve(output.subarray(4));
      }
    });
  });
}
test("dedicated agent interoperates with SSH Ed25519 signing without disk keys", async () => {
  const dir = await mkdtemp(join(tmpdir(), "hca-"));
  const paths = sessionPaths(join(dir, "inventory.yaml"));
  const socket = windows ? paths.socket : join(dir, "agent.sock");
  const agent = createDedicatedAgent(socket, null);
  await agent.listen();
  try {
    const pair = generateKeyPairSync("ed25519");
    const pem = Buffer.from(
      pair.privateKey.export({ format: "pem", type: "pkcs8" }),
    );
    await addKey(socket, pem);
    pem.fill(0);
    const identities = await agentRequest(socket, Buffer.from([11]));
    expect(identities[0]).toBe(12);
    expect(identities.readUInt32BE(1)).toBe(1);
    const data = Buffer.from("synthetic-signing-challenge");
    const signature = await agentRequest(
      socket,
      Buffer.concat([
        Buffer.from([13]),
        sshString(publicBlob(pair.privateKey)),
        sshString(data),
        u32(0),
      ]),
    );
    expect(signature[0]).toBe(14);
    const r = reader(reader(signature.subarray(1)).string());
    expect(r.string().toString()).toBe("ssh-ed25519");
    expect(verify(null, data, pair.publicKey, r.string())).toBe(true);
    r.done();
    await agentRequest(socket, Buffer.from([19]));
    expect(
      (await agentRequest(socket, Buffer.from([11]))).readUInt32BE(1),
    ).toBe(0);
  } finally {
    agent.close();
    await rm(dir, { recursive: true, force: true });
  }
});
test("expired dedicated agent refuses to load keys", async () => {
  const dir = await mkdtemp(join(tmpdir(), "hca-"));
  const socket = windows
    ? sessionPaths(join(dir, "i.yaml")).socket
    : join(dir, "agent.sock");
  const agent = createDedicatedAgent(socket, Date.now() - 1);
  await agent.listen();
  try {
    const key = generateKeyPairSync("ed25519").privateKey.export({
      format: "pem",
      type: "pkcs8",
    });
    await expect(addKey(socket, Buffer.from(key))).rejects.toThrow();
  } finally {
    agent.close();
    await rm(dir, { recursive: true, force: true });
  }
});
test("inventory accepts Windows native paths and private named-pipe references", () => {
  const inv = {
    version: 1,
    session: { ttl: "24h", database: "C:\\Users\\Example\\homelab.kdbx" },
    machines: {
      nas: {
        description: "Synthetic",
        transport: "ssh",
        address: "192.0.2.1",
        user: "operator",
        access: "observe",
        ssh_alias: "nas",
        auth: {
          type: "keepassxc",
          inventory: "C:\\Users\\Example\\inventory.yaml",
          entry: "homectl-nas",
          socket: String.raw`\\.\pipe\homectl-example-agent`,
          public_key: "C:\\Users\\Example\\nas.pub",
        },
      },
    },
  };
  expect(parseInventory(JSON.stringify(inv)).machines.nas?.auth?.socket).toBe(
    String.raw`\\.\pipe\homectl-example-agent`,
  );
});
test("managed trusted host keys cannot inject unrelated hosts or extra lines", () => {
  const machines = {
    nas: {
      description: "Synthetic",
      transport: "ssh" as const,
      address: "192.0.2.1",
      user: "operator",
      access: "observe" as const,
      ssh_alias: "nas",
    },
  };
  const keys = collectHostKeys(
    "192.0.2.1 ssh-ed25519 AAAA\n192.0.2.99 ssh-ed25519 BBBB",
    machines,
  );
  expect(Object.keys(keys)).toHaveLength(1);
  validateHostKeys(keys, machines);
  const id = Object.keys(keys)[0] ?? "";
  expect(() =>
    validateHostKeys({ [id]: "192.0.2.99 ssh-ed25519 AAAA" }, machines),
  ).toThrow();
  expect(() =>
    validateHostKeys(
      { [id]: `${keys[id]}\n192.0.2.99 ssh-ed25519 BBBB` },
      machines,
    ),
  ).toThrow();
});

test("private Windows ACL setup handles spaces, Unicode and repeated protection", async () => {
  const dir = await mkdtemp(join(tmpdir(), "homectl space-ż-"));
  try {
    await privateDirectory(dir);
    await privateDirectory(dir);
    const file = join(dir, "private file.txt");
    await writeFile(file, "synthetic");
    await protect(file);
    await protect(file);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
