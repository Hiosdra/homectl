// Sealed vault-password envelope for the panel unlock fallback (ADR-0003).
// Pure JavaScript, so it works where WebCrypto is unavailable (plain HTTP on the LAN).
// It protects the password against passive observers. It does not stop an attacker
// who can rewrite the panel page; the ADR records that as an accepted risk.
import { xchacha20poly1305 } from "@noble/ciphers/chacha.js";
import { randomBytes } from "@noble/ciphers/utils.js";
import { x25519 } from "@noble/curves/ed25519.js";
import { sha256 } from "@noble/hashes/sha2.js";

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const BASE_AAD = encoder.encode("homectl-panel-unlock-v1");
const KEY_LABEL = encoder.encode("homectl-unlock-key-v1");
const NONCE_BYTES = 24;
const CHALLENGE_BYTES = 16;
const KEY_BYTES = 32;

export type ServerKeys = { secret: Uint8Array; pub: Uint8Array };
export type SealedPassword = {
  eph: string;
  nonce: string;
  ct: string;
  challenge: string;
};

export function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

export function fromHex(hex: string, bytes?: number): Uint8Array {
  if (!/^(?:[0-9a-f]{2})*$/.test(hex)) throw new Error("invalid hex");
  const out = Uint8Array.from(hex.match(/../g) ?? [], (h) =>
    Number.parseInt(h, 16),
  );
  if (bytes !== undefined && out.length !== bytes)
    throw new Error("invalid length");
  return out;
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

function keyFor(
  shared: Uint8Array,
  ephPub: Uint8Array,
  serverPub: Uint8Array,
): Uint8Array {
  return sha256(concat(KEY_LABEL, shared, ephPub, serverPub));
}

export function newServerKeys(): ServerKeys {
  const secret = x25519.utils.randomSecretKey();
  return { secret, pub: x25519.getPublicKey(secret) };
}

// Short fingerprint for humans to compare once: 24 hex digits in groups of four.
export function fingerprint(pub: Uint8Array): string {
  return (toHex(sha256(pub)).slice(0, 24).match(/.{4}/g) ?? []).join(" ");
}

// Client side: seal the password to the server key, bound to a one-time challenge.
export function sealPassword(
  password: string,
  serverPub: Uint8Array,
  challenge: string,
): SealedPassword {
  fromHex(challenge, CHALLENGE_BYTES);
  if (serverPub.length !== KEY_BYTES) throw new Error("invalid server key");
  const ephSecret = x25519.utils.randomSecretKey();
  const ephPub = x25519.getPublicKey(ephSecret);
  const shared = x25519.getSharedSecret(ephSecret, serverPub);
  const key = keyFor(shared, ephPub, serverPub);
  const nonce = randomBytes(NONCE_BYTES);
  const aad = concat(BASE_AAD, fromHex(challenge));
  const ct = xchacha20poly1305(key, nonce, aad).encrypt(
    encoder.encode(password),
  );
  return {
    eph: toHex(ephPub),
    nonce: toHex(nonce),
    ct: toHex(ct),
    challenge,
  };
}

// Server side: open the envelope with the server secret. Every failure has the same message.
export function openPassword(
  envelope: SealedPassword,
  keys: ServerKeys,
): string {
  try {
    const ephPub = fromHex(envelope.eph, KEY_BYTES);
    const shared = x25519.getSharedSecret(keys.secret, ephPub);
    const key = keyFor(shared, ephPub, keys.pub);
    const aad = concat(BASE_AAD, fromHex(envelope.challenge, CHALLENGE_BYTES));
    const plain = xchacha20poly1305(
      key,
      fromHex(envelope.nonce, NONCE_BYTES),
      aad,
    ).decrypt(fromHex(envelope.ct));
    return decoder.decode(plain);
  } catch {
    throw new Error("cannot open sealed password");
  }
}
