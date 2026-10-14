import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  hkdfSync,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";
import { HomectlError } from "../types";
export function digest(value: string) {
  return createHash("sha256").update(value).digest("hex");
}
export function derive(key: string, context: string): Buffer {
  return Buffer.from(
    hkdfSync("sha256", Buffer.from(key, "hex"), Buffer.alloc(0), context, 32),
  );
}
export type Envelope = { nonce: string; data: string; tag: string };
export function seal(
  key: Uint8Array,
  value: unknown,
  context: string,
): Envelope {
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  cipher.setAAD(Buffer.from(context));
  const plain = Buffer.from(JSON.stringify(value));
  try {
    const data = Buffer.concat([cipher.update(plain), cipher.final()]);
    return {
      nonce: nonce.toString("base64"),
      data: data.toString("base64"),
      tag: cipher.getAuthTag().toString("base64"),
    };
  } finally {
    plain.fill(0);
  }
}
export function open<T>(
  key: Uint8Array,
  envelope: Envelope,
  context: string,
): T {
  try {
    if (
      typeof envelope.data !== "string" ||
      envelope.data.length > 24 * 1024 * 1024
    )
      throw new Error();
    const nonce = Buffer.from(envelope.nonce, "base64");
    const tag = Buffer.from(envelope.tag, "base64");
    if (nonce.length !== 12 || tag.length !== 16) throw new Error();
    const cipher = createDecipheriv("aes-256-gcm", key, nonce);
    cipher.setAAD(Buffer.from(context));
    cipher.setAuthTag(tag);
    const plain = Buffer.concat([
      cipher.update(Buffer.from(envelope.data, "base64")),
      cipher.final(),
    ]);
    try {
      return JSON.parse(plain.toString()) as T;
    } finally {
      plain.fill(0);
    }
  } catch {
    throw new HomectlError(
      3,
      "Peer authentication or encrypted message failed",
    );
  }
}
export function proof(key: Uint8Array, message: string) {
  return createHmac("sha256", key).update(message).digest("hex");
}
export function equal(a: string, b: string) {
  return (
    a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b))
  );
}
export function verification(key: Uint8Array, transcript: string) {
  const n = createHmac("sha256", key)
    .update(`homectl-pair-v1:${transcript}`)
    .digest();
  return `${n.readUInt32BE(0).toString(16).padStart(8, "0")} ${n.readUInt32BE(4).toString(16).padStart(8, "0")}`;
}

export function transportKey(
  secret: Uint8Array,
  auth: string,
  context: string,
) {
  return Buffer.from(
    hkdfSync("sha256", secret, Buffer.from(auth, "hex"), context, 32),
  );
}
