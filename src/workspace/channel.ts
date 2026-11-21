// Authenticated, encrypted request channel between a workspace client and its
// server (homelab #21 §6). Both ends share a link key that SRP pairing with a
// one-time code established. Every request is two round trips:
//   1. challenge: the server answers with a fresh X25519 public key and an
//      HMAC proof under the link key, so the client knows it is the server;
//   2. message: the client derives a per-request key (ECDH + link key), seals
//      one request, and the server consumes the challenge, opens it and seals
//      the response under the same key.
// A challenge is single-use and expires in 30 s, so a captured message
// cannot be replayed. The 0.2 peer hub uses the same construction; contexts
// differ ("workspace-v1"), so keys and proofs never cross between them.
import {
  createPublicKey,
  diffieHellman,
  generateKeyPairSync,
  type KeyObject,
  randomUUID,
} from "node:crypto";
import {
  type Envelope,
  equal,
  open,
  proof,
  seal,
  transportKey,
} from "../peer/crypto";
import { HomectlError } from "../types";

const UUID = /^[a-f0-9-]{36}$/;
const CHALLENGE_MS = 30_000;
const MAX_CHALLENGES = 256;

export type Post = (path: string, value: unknown) => Promise<unknown>;

export interface LinkPeer {
  id: string;
  key: string; // hex link key
}

function x25519(value: unknown): KeyObject {
  try {
    const key = createPublicKey({
      key: Buffer.from(String(value), "base64"),
      format: "der",
      type: "spki",
    });
    if (key.asymmetricKeyType === "x25519") return key;
  } catch {}
  throw new HomectlError(3, "Unsupported workspace key");
}

const challengeProof = (
  link: string,
  client: string,
  server: string,
  challenge: string,
  publicKey: string,
) =>
  proof(
    Buffer.from(link, "hex"),
    `workspace-challenge-v1:${client}:${server}:${challenge}:${publicKey}`,
  );

export class ChannelServer {
  private readonly challenges = new Map<
    string,
    {
      client: string;
      expiresAt: number;
      privateKey: KeyObject;
      publicKey: string;
    }
  >();

  constructor(
    private readonly self: () => string,
    // Current link key of an active client, or undefined (unknown/removed).
    private readonly lookup: (client: string) => Promise<string | undefined>,
    private readonly handle: (
      client: string,
      action: string,
      payload: unknown,
    ) => Promise<unknown>,
    private readonly now: () => number = Date.now,
  ) {}

  async challenge(input: Record<string, unknown>) {
    const client = String(input.id ?? "");
    const link = UUID.test(client) ? await this.lookup(client) : undefined;
    if (!link) throw new HomectlError(3, "Unknown workspace client");
    const now = this.now();
    for (const [id, c] of this.challenges)
      if (c.expiresAt < now) this.challenges.delete(id);
    if (this.challenges.size >= MAX_CHALLENGES)
      throw new HomectlError(3, "Too many workspace challenges");
    const challenge = randomUUID();
    const pair = generateKeyPairSync("x25519");
    const publicKey = pair.publicKey
      .export({ format: "der", type: "spki" })
      .toString("base64");
    this.challenges.set(challenge, {
      client,
      expiresAt: now + CHALLENGE_MS,
      privateKey: pair.privateKey,
      publicKey,
    });
    return {
      challenge,
      publicKey,
      proof: challengeProof(link, client, this.self(), challenge, publicKey),
    };
  }

  async message(input: Record<string, unknown>) {
    const client = String(input.id ?? "");
    const challenge = String(input.challenge ?? "");
    const requestId = String(input.requestId ?? "");
    const c = this.challenges.get(challenge);
    this.challenges.delete(challenge);
    const link = c ? await this.lookup(client) : undefined;
    if (
      !c ||
      !link ||
      c.client !== client ||
      c.expiresAt < this.now() ||
      !UUID.test(requestId)
    )
      throw new HomectlError(3, "Unknown client or expired/replayed request");
    const clientKey = String(input.clientKey ?? "");
    const context = `workspace-v1:${client}:${this.self()}:${requestId}:${challenge}:${c.publicKey}:${clientKey}`;
    const secret = diffieHellman({
      privateKey: c.privateKey,
      publicKey: x25519(clientKey),
    });
    const key = transportKey(secret, link, context);
    secret.fill(0);
    try {
      const request = open<{ action: string; payload: unknown }>(
        key,
        input.envelope as Envelope,
        `${context}:request`,
      );
      if (typeof request?.action !== "string")
        throw new HomectlError(2, "Malformed workspace request");
      let response: { ok: true; value: unknown } | { ok: false; error: string };
      try {
        response = {
          ok: true,
          value: await this.handle(client, request.action, request.payload),
        };
      } catch (error) {
        // Only deliberate refusals cross the link; internals stay local.
        response = {
          ok: false,
          error:
            error instanceof HomectlError
              ? error.message
              : "The workspace server could not complete the request",
        };
      }
      return { envelope: seal(key, response, `${context}:response`) };
    } finally {
      key.fill(0);
    }
  }
}

// Client side: one authenticated, encrypted request to the server.
export async function channelRequest(
  post: Post,
  self: string,
  server: LinkPeer,
  action: string,
  payload: unknown,
): Promise<unknown> {
  const reply = (await post("/v1/workspace/challenge", { id: self })) as {
    challenge?: unknown;
    publicKey?: unknown;
    proof?: unknown;
  };
  const challenge = String(reply?.challenge ?? "");
  const publicKey = String(reply?.publicKey ?? "");
  if (
    !UUID.test(challenge) ||
    !equal(
      String(reply?.proof ?? ""),
      challengeProof(server.key, self, server.id, challenge, publicKey),
    )
  )
    throw new HomectlError(3, "Workspace server authentication failed");
  const pair = generateKeyPairSync("x25519");
  const clientKey = pair.publicKey
    .export({ format: "der", type: "spki" })
    .toString("base64");
  const requestId = randomUUID();
  const context = `workspace-v1:${self}:${server.id}:${requestId}:${challenge}:${publicKey}:${clientKey}`;
  const secret = diffieHellman({
    privateKey: pair.privateKey,
    publicKey: x25519(publicKey),
  });
  const key = transportKey(secret, server.key, context);
  secret.fill(0);
  try {
    const result = (await post("/v1/workspace/message", {
      id: self,
      requestId,
      challenge,
      clientKey,
      envelope: seal(key, { action, payload }, `${context}:request`),
    })) as { envelope: Envelope };
    const response = open<
      { ok: true; value: unknown } | { ok: false; error: string }
    >(key, result?.envelope, `${context}:response`);
    if (!response.ok)
      throw new HomectlError(
        3,
        `Workspace server refused: ${String(response.error).slice(0, 300)}`,
      );
    return response.value;
  } finally {
    key.fill(0);
  }
}

// HTTP POST for workspace traffic. No redirects, bounded size and time.
export function httpPost(address: string): Post {
  const base = workspaceAddress(address);
  return async (path, value) => {
    const response = await fetch(`${base}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(value),
      signal: AbortSignal.timeout(30_000),
      redirect: "error",
    });
    const text = await response.text();
    if (text.length > 32 * 1024 * 1024)
      throw new HomectlError(5, "Workspace response too large");
    if (!response.ok)
      throw new HomectlError(
        5,
        "The workspace server refused the request; check its panel",
      );
    return JSON.parse(text);
  };
}

// Normalises "host:port" or an http(s) URL to an origin without a path.
export function workspaceAddress(value: string): string {
  const raw = /^https?:\/\//.test(value) ? value : `http://${value}`;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new HomectlError(2, "Enter the server as host:port or a URL");
  }
  if (url.username || url.password || url.search || url.hash)
    throw new HomectlError(2, "The server address must not carry credentials");
  if (url.pathname !== "/" && url.pathname !== "")
    throw new HomectlError(2, "The server address must not have a path");
  return url.origin;
}
