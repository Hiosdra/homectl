import { describe, expect, test } from "bun:test";
import {
  fingerprint,
  fromHex,
  newServerKeys,
  openPassword,
  sealPassword,
  toHex,
} from "../src/web/unlock-seal";

const PASSWORD = "correct-horse-battery-staple-7";
const CHALLENGE = "00112233445566778899aabbccddeeff";

describe("sealed vault password", () => {
  test("the server opens the password sealed to its key and challenge", () => {
    const keys = newServerKeys();
    const envelope = sealPassword(PASSWORD, keys.pub, CHALLENGE);
    expect(openPassword(envelope, keys)).toBe(PASSWORD);
  });

  test("the envelope never contains the password in plain text or hex", () => {
    const keys = newServerKeys();
    const envelope = JSON.stringify(
      sealPassword(PASSWORD, keys.pub, CHALLENGE),
    );
    expect(envelope).not.toContain(PASSWORD);
    expect(envelope).not.toContain(toHex(new TextEncoder().encode(PASSWORD)));
  });

  test("each seal uses a fresh ephemeral key and nonce", () => {
    const keys = newServerKeys();
    const a = sealPassword(PASSWORD, keys.pub, CHALLENGE);
    const b = sealPassword(PASSWORD, keys.pub, CHALLENGE);
    expect(a.eph).not.toBe(b.eph);
    expect(a.nonce).not.toBe(b.nonce);
    expect(a.ct).not.toBe(b.ct);
  });

  test("a different challenge is rejected", () => {
    const keys = newServerKeys();
    const envelope = sealPassword(PASSWORD, keys.pub, CHALLENGE);
    const moved = {
      ...envelope,
      challenge: "ffeeddccbbaa99887766554433221100",
    };
    expect(() => openPassword(moved, keys)).toThrow(
      "cannot open sealed password",
    );
  });

  test("another server key cannot open the envelope", () => {
    const keys = newServerKeys();
    const other = newServerKeys();
    const envelope = sealPassword(PASSWORD, keys.pub, CHALLENGE);
    expect(() => openPassword(envelope, other)).toThrow(
      "cannot open sealed password",
    );
  });

  test("a tampered ciphertext is rejected", () => {
    const keys = newServerKeys();
    const envelope = sealPassword(PASSWORD, keys.pub, CHALLENGE);
    const bytes = fromHex(envelope.ct);
    bytes[0] = (bytes[0] ?? 0) ^ 0x01;
    const tampered = { ...envelope, ct: toHex(bytes) };
    expect(() => openPassword(tampered, keys)).toThrow(
      "cannot open sealed password",
    );
  });

  test("malformed input is refused before any crypto runs", () => {
    const keys = newServerKeys();
    expect(() => sealPassword(PASSWORD, keys.pub, "not-hex")).toThrow(
      "invalid hex",
    );
    expect(() => sealPassword(PASSWORD, keys.pub, "abcd")).toThrow(
      "invalid length",
    );
    expect(() => sealPassword(PASSWORD, new Uint8Array(31), CHALLENGE)).toThrow(
      "invalid server key",
    );
  });

  test("the fingerprint is 24 hex digits in six groups of four", () => {
    const keys = newServerKeys();
    expect(fingerprint(keys.pub)).toMatch(/^[0-9a-f]{4}( [0-9a-f]{4}){5}$/);
    expect(fingerprint(keys.pub)).toBe(fingerprint(keys.pub));
    expect(fingerprint(keys.pub)).not.toBe(fingerprint(newServerKeys().pub));
  });
});
