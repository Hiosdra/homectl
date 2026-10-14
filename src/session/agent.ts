import {
  createPrivateKey,
  createPublicKey,
  type KeyObject,
  sign,
} from "node:crypto";
import { createConnection, createServer, type Socket } from "node:net";
import { HomectlError } from "../types";
export function u32(value: number) {
  const b = Buffer.alloc(4);
  b.writeUInt32BE(value);
  return b;
}
export function sshString(value: string | Uint8Array): Buffer {
  const b = Buffer.from(value);
  return Buffer.concat([u32(b.length), b]);
}
export function reader(b: Buffer) {
  let o = 0;
  return {
    number() {
      if (o + 4 > b.length) throw new Error();
      const n = b.readUInt32BE(o);
      o += 4;
      return n;
    },
    string() {
      if (o + 4 > b.length) throw new Error();
      const n = b.readUInt32BE(o);
      o += 4;
      if (n > b.length - o) throw new Error();
      const s = b.subarray(o, o + n);
      o += n;
      return s;
    },
    done() {
      if (o !== b.length) throw new Error();
    },
  };
}
export function publicBlob(key: KeyObject) {
  if (key.asymmetricKeyType !== "ed25519")
    throw new HomectlError(5, "Only Ed25519 keys are supported");
  const der = createPublicKey(key).export({ format: "der", type: "spki" });
  return Buffer.concat([
    sshString("ssh-ed25519"),
    sshString(der.subarray(-32)),
  ]);
}
export function decodeKey(bytes: Buffer): KeyObject {
  if (!bytes.toString().includes("BEGIN OPENSSH PRIVATE KEY"))
    return createPrivateKey(bytes);
  const raw = Buffer.from(
    bytes.toString().replace(/-----[^\n]+-----|\s/g, ""),
    "base64",
  );
  try {
    if (raw.subarray(0, 15).toString() !== "openssh-key-v1\0")
      throw new Error();
    const r = reader(raw.subarray(15));
    if (
      r.string().toString() !== "none" ||
      r.string().toString() !== "none" ||
      r.string().length ||
      r.number() !== 1
    )
      throw new Error();
    const pub = r.string();
    const p = reader(r.string());
    r.done();
    const check = p.number();
    if (check !== p.number() || p.string().toString() !== "ssh-ed25519")
      throw new Error();
    const publicBytes = p.string();
    const secret = p.string();
    p.string();
    if (
      publicBytes.length !== 32 ||
      secret.length !== 64 ||
      !secret.subarray(32).equals(publicBytes)
    )
      throw new Error();
    const key = createPrivateKey({
      key: Buffer.concat([
        Buffer.from("302e020100300506032b657004220420", "hex"),
        secret.subarray(0, 32),
      ]),
      format: "der",
      type: "pkcs8",
    });
    if (!publicBlob(key).equals(pub)) throw new Error();
    return key;
  } catch {
    throw new HomectlError(
      5,
      "Invalid or unsupported private key; details suppressed",
    );
  } finally {
    raw.fill(0);
  }
}
// Windows has no foreground per-inventory OpenSSH agent. Serve the minimal
// Ed25519 protocol on a private named pipe, holding keys only in this process.
export function createDedicatedAgent(path: string, expiresAt: number | null) {
  const keys = new Map<
    string,
    { key: KeyObject; blob: Buffer; comment: Buffer }
  >();
  const connections = new Set<Socket>();
  const server = createServer((socket) => {
    connections.add(socket);
    socket.on("close", () => connections.delete(socket));
    socket.on("error", () => {});
    socket.setTimeout(30_000, () => socket.destroy());
    let input = Buffer.alloc(0);
    socket.on("data", (chunk: Buffer) => {
      input = Buffer.concat([input, chunk]);
      if (input.length > 256 * 1024) return socket.destroy();
      while (input.length >= 4) {
        const n = input.readUInt32BE();
        if (!n || n > 128 * 1024) return socket.destroy();
        if (input.length < n + 4) return;
        const request = input.subarray(4, n + 4);
        input = input.subarray(n + 4);
        let response: Buffer = Buffer.from([5]);
        try {
          if (expiresAt !== null && Date.now() >= expiresAt) keys.clear();
          const r = reader(request.subarray(1));
          if (request[0] === 11) {
            r.done();
            response = Buffer.concat([
              Buffer.from([12]),
              u32(keys.size),
              ...[...keys.values()].flatMap((k) => [
                sshString(k.blob),
                sshString(k.comment),
              ]),
            ]);
          } else if (request[0] === 13) {
            const blob = r.string();
            const data = r.string();
            if (r.number() !== 0) throw new Error();
            r.done();
            const k = keys.get(blob.toString("base64"));
            if (!k) throw new Error();
            response = Buffer.concat([
              Buffer.from([14]),
              sshString(
                Buffer.concat([
                  sshString("ssh-ed25519"),
                  sshString(sign(null, data, k.key)),
                ]),
              ),
            ]);
          } else if (
            request[0] === 17 &&
            (expiresAt === null || Date.now() < expiresAt)
          ) {
            if (r.string().toString() !== "ssh-ed25519") throw new Error();
            const pub = r.string();
            const secret = r.string();
            const comment = r.string();
            r.done();
            if (
              pub.length !== 32 ||
              secret.length !== 64 ||
              !secret.subarray(32).equals(pub) ||
              keys.size >= 256
            )
              throw new Error();
            const key = createPrivateKey({
              key: Buffer.concat([
                Buffer.from("302e020100300506032b657004220420", "hex"),
                secret.subarray(0, 32),
              ]),
              format: "der",
              type: "pkcs8",
            });
            const blob = publicBlob(key);
            if (
              !blob.equals(
                Buffer.concat([sshString("ssh-ed25519"), sshString(pub)]),
              )
            )
              throw new Error();
            keys.set(blob.toString("base64"), {
              key,
              blob,
              comment: Buffer.from(comment),
            });
            response = Buffer.from([6]);
          } else if (request[0] === 19) {
            r.done();
            keys.clear();
            response = Buffer.from([6]);
          }
        } catch {}
        socket.write(Buffer.concat([u32(response.length), response]));
        request.fill(0);
      }
    });
  });
  return {
    server,
    listen: () =>
      new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(path, resolve);
      }),
    close: () => {
      keys.clear();
      for (const c of connections) c.destroy();
      server.close();
    },
  };
}
export async function addKey(
  path: string,
  bytes: Uint8Array,
  lifetime?: number,
) {
  const key = decodeKey(Buffer.from(bytes));
  const jwk = key.export({ format: "jwk" });
  const pub = publicBlob(key).subarray(-32);
  const secret = Buffer.concat([Buffer.from(jwk.d ?? "", "base64url"), pub]);
  const request = Buffer.concat([
    Buffer.from([lifetime === undefined ? 17 : 25]),
    sshString("ssh-ed25519"),
    sshString(pub),
    sshString(secret),
    sshString("homectl"),
    ...(lifetime === undefined ? [] : [Buffer.from([1]), u32(lifetime)]),
  ]);
  try {
    await new Promise<void>((resolve, reject) => {
      const socket = createConnection(path);
      let response = Buffer.alloc(0);
      socket.setTimeout(5000, () => socket.destroy(new Error()));
      socket.on("error", () =>
        reject(new HomectlError(5, "Managed key loading failed")),
      );
      socket.on("connect", () =>
        socket.write(Buffer.concat([u32(request.length), request])),
      );
      socket.on("data", (b: Buffer) => {
        response = Buffer.concat([response, b]);
        if (response.length >= 5) {
          socket.destroy();
          if (response.readUInt32BE() === 1 && response[4] === 6) resolve();
          else reject(new HomectlError(5, "Managed key rejected"));
        }
      });
    });
  } finally {
    secret.fill(0);
    request.fill(0);
  }
}
