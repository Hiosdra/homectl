import { describe, expect, test } from "bun:test";
import {
  canonicalJson,
  chunkId,
  deriveKeys,
  keyFor,
  newClientKey,
  open,
  seal,
  unwrapKey,
  wrapKey,
} from "../src/backup";

const enc = (text: string) => new TextEncoder().encode(text);

describe("backup keys", () => {
  test("HKDF purpose keys are 32 bytes, distinct, and deterministic", () => {
    const client = newClientKey();
    const chunk = keyFor(client, "chunk-enc");
    const mac = keyFor(client, "chunk-id");
    expect(chunk.length).toBe(32);
    expect(Buffer.from(chunk).equals(Buffer.from(mac))).toBe(false);
    expect(
      Buffer.from(keyFor(client, "chunk-enc")).equals(Buffer.from(chunk)),
    ).toBe(true);
    const keys = deriveKeys(client);
    expect(Buffer.from(keys.chunk).equals(Buffer.from(chunk))).toBe(true);
  });

  test("rejects a client key that is not 32 bytes", () => {
    expect(() => keyFor(new Uint8Array(16), "manifest")).toThrow(/32 bytes/);
  });

  test("chunk ids are keyed: same content under another key gives another id", () => {
    const a = keyFor(newClientKey(), "chunk-id");
    const b = keyFor(newClientKey(), "chunk-id");
    const content = enc("the same bytes");
    expect(chunkId(a, content)).toMatch(/^[0-9a-f]{64}$/);
    expect(chunkId(a, content)).toBe(chunkId(a, content));
    expect(chunkId(a, content)).not.toBe(chunkId(b, content));
  });

  test("seal/open round-trips and binds the AAD", () => {
    const key = keyFor(newClientKey(), "chunk-enc");
    const blob = seal(key, enc("payload"), enc("slot-1"));
    expect(new TextDecoder().decode(open(key, blob, enc("slot-1")))).toBe(
      "payload",
    );
    expect(() => open(key, blob, enc("slot-2"))).toThrow(/wrong key|tampered/);
  });

  test("open fails with a wrong key or a flipped byte", () => {
    const key = keyFor(newClientKey(), "chunk-enc");
    const other = keyFor(newClientKey(), "chunk-enc");
    const blob = seal(key, enc("payload"), enc("aad"));
    expect(() => open(other, blob, enc("aad"))).toThrow();
    const tampered = new Uint8Array(blob);
    tampered[tampered.length - 1] = (tampered[tampered.length - 1] ?? 0) ^ 1;
    expect(() => open(key, tampered, enc("aad"))).toThrow();
  });

  test("wrapKey/unwrapKey round-trips and rejects a wrong client id (AAD)", () => {
    const client = newClientKey();
    const custody = newClientKey();
    const wrapped = wrapKey(client, custody, "laptop-a");
    expect(
      Buffer.from(unwrapKey(wrapped, custody, "laptop-a")).equals(
        Buffer.from(client),
      ),
    ).toBe(true);
    expect(() => unwrapKey(wrapped, custody, "laptop-b")).toThrow();
  });

  test("unwrapKey rejects the wrong custody key", () => {
    const wrapped = wrapKey(newClientKey(), newClientKey(), "laptop-a");
    expect(() => unwrapKey(wrapped, newClientKey(), "laptop-a")).toThrow();
  });

  test("canonicalJson sorts keys at every depth", () => {
    expect(canonicalJson({ b: 1, a: { d: [{ z: 1, y: 2 }], c: null } })).toBe(
      '{"a":{"c":null,"d":[{"y":2,"z":1}]},"b":1}',
    );
  });
});
