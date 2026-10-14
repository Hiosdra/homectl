import { randomInt, randomUUID } from "node:crypto";
import * as client from "secure-remote-password/client";
import * as server from "secure-remote-password/server";
import { HomectlError } from "../types";
import { derive, type Envelope, open, seal, verification } from "./crypto";
import { defaults, type Peer, type PeerState, type Permissions } from "./store";

const username = "homectl-pair-v1";
export type Identity = { id: string; name: string; platform: string };
export type Pair = {
  id: string;
  expiresAt: number;
  code?: string;
  salt?: string;
  verifier?: string;
  ephemeral?: server.Ephemeral;
  clientPublic?: string;
  key?: Buffer;
  remote?: Identity;
  address?: string;
  localConfirmed: boolean;
  remoteConfirmed: boolean;
  sas?: string;
  outgoing: boolean;
  permissions: Permissions;
};
export function identity(state: PeerState): Identity {
  return { id: state.id, name: state.name, platform: process.platform };
}
export function validateIdentity(value: Identity) {
  if (
    !value ||
    !/^[a-f0-9-]{36}$/.test(value.id) ||
    typeof value.name !== "string" ||
    value.name.length > 100 ||
    !value.name.trim() ||
    !["linux", "win32", "darwin"].includes(value.platform)
  )
    throw new HomectlError(2, "Invalid peer identity");
  return value;
}
export function createPair(permissions = defaults()): Pair {
  const code = `${randomInt(1000, 10000)}-${randomInt(1000, 10000)}`;
  const salt = client.generateSalt();
  const verifier = client.deriveVerifier(
    client.derivePrivateKey(salt, username, code),
  );
  return {
    id: randomUUID(),
    expiresAt: Date.now() + 300_000,
    code,
    salt,
    verifier,
    localConfirmed: false,
    remoteConfirmed: false,
    outgoing: false,
    permissions,
  };
}
function active(p: Pair) {
  if (Date.now() >= p.expiresAt)
    throw new HomectlError(3, "Pairing window expired; start again");
}
export function pairStart(p: Pair, publicValue: string) {
  active(p);
  if (
    p.outgoing ||
    p.clientPublic ||
    !p.verifier ||
    !/^[a-f0-9]{512}$/i.test(publicValue)
  )
    throw new HomectlError(
      3,
      "Pairing attempt unavailable; generate a new code",
    );
  p.clientPublic = publicValue;
  p.ephemeral = server.generateEphemeral(p.verifier);
  p.code = undefined;
  return { id: p.id, salt: p.salt, public: p.ephemeral.public };
}
export function pairProof(
  p: Pair,
  proof: string,
  envelope: Envelope,
  local: Identity,
) {
  active(p);
  if (!p.ephemeral || !p.clientPublic || !p.verifier || !p.salt || p.key)
    throw new HomectlError(3, "Pairing attempt unavailable");
  try {
    const session = server.deriveSession(
      p.ephemeral.secret,
      p.clientPublic,
      p.salt,
      username,
      p.verifier,
      proof,
    );
    p.key = derive(session.key, `homectl-pair-v1:${p.id}`);
    p.remote = validateIdentity(
      open<Identity>(p.key, envelope, `pair:${p.id}:identity:joiner`),
    );
    if (p.remote.id === local.id) throw new Error();
    p.sas = verification(p.key, JSON.stringify([p.id, local, p.remote]));
    p.verifier = undefined;
    p.ephemeral = undefined;
    return {
      proof: session.proof,
      envelope: seal(p.key, local, `pair:${p.id}:identity:host`),
    };
  } catch {
    p.expiresAt = 0;
    p.key?.fill(0);
    throw new HomectlError(3, "Pairing failed; code invalidated");
  }
}
export async function joinPair(
  address: string,
  code: string,
  local: Identity,
  post: (path: string, value: unknown) => Promise<unknown>,
): Promise<Pair> {
  if (!/^\d{4}-\d{4}$/.test(code))
    throw new HomectlError(2, "Enter the code shown on the other device");
  const ephemeral = client.generateEphemeral();
  const start = (await post("/pair/start", { public: ephemeral.public })) as {
    id: string;
    salt: string;
    public: string;
  };
  if (
    !/^[a-f0-9-]{36}$/.test(start.id) ||
    !/^[a-f0-9]{64}$/i.test(start.salt) ||
    !/^[a-f0-9]{512}$/i.test(start.public)
  )
    throw new HomectlError(3, "Invalid pairing response");
  const session = client.deriveSession(
    ephemeral.secret,
    start.public,
    start.salt,
    username,
    client.derivePrivateKey(start.salt, username, code),
  );
  const key = derive(session.key, `homectl-pair-v1:${start.id}`);
  try {
    const result = (await post("/pair/proof", {
      id: start.id,
      proof: session.proof,
      envelope: seal(key, local, `pair:${start.id}:identity:joiner`),
    })) as { proof: string; envelope: Envelope };
    client.verifySession(ephemeral.public, session, result.proof);
    const remote = validateIdentity(
      open<Identity>(key, result.envelope, `pair:${start.id}:identity:host`),
    );
    if (remote.id === local.id) throw new Error();
    return {
      id: start.id,
      expiresAt: Date.now() + 300_000,
      key,
      remote,
      address,
      sas: verification(key, JSON.stringify([start.id, remote, local])),
      localConfirmed: false,
      remoteConfirmed: false,
      outgoing: true,
      permissions: defaults(),
    };
  } catch {
    key.fill(0);
    throw new HomectlError(3, "Pairing authentication failed; start again");
  }
}
export function paired(p: Pair): Peer {
  active(p);
  if (
    !p.key ||
    !p.remote ||
    !p.localConfirmed ||
    !p.remoteConfirmed ||
    !p.address
  )
    throw new HomectlError(
      3,
      "Confirm the verification phrase on both devices first",
    );
  return {
    ...p.remote,
    address: p.address,
    key: p.key.toString("hex"),
    permissions: p.permissions,
    pairedAt: Date.now(),
  };
}
