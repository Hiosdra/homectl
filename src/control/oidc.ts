// OIDC authentication for MCP clients (slice 4, docs/homectl-2.0/oidc-mcp-auth.md).
// The identity provider proves who the caller is; homectl decides what the
// caller may do. Static `hct_` tokens are unchanged and remain the default.
import {
  createHash,
  createPublicKey,
  type KeyObject,
  verify,
} from "node:crypto";
import { HomectlError } from "../types";

export const OIDC_ALGORITHMS = ["RS256", "ES256", "EdDSA"] as const;
export type OidcAlgorithm = (typeof OIDC_ALGORITHMS)[number];
export const MAX_TOKEN_BYTES = 8192;
export const MAX_JWKS_BYTES = 65_536;
export const CLOCK_SKEW_SECONDS = 60;
export const MAX_LIFETIME_SECONDS = 3600;
export const JWKS_TTL_MS = 10 * 60_000;
export const REFRESH_MIN_MS = 30_000;
export const FETCH_TIMEOUT_MS = 5_000;

// Fixed reason codes. Nothing from the token or the identity provider is echoed.
export type OidcRefusalCode =
  | "oidc-format"
  | "oidc-alg"
  | "oidc-header"
  | "oidc-unknown-key"
  | "oidc-signature"
  | "oidc-issuer"
  | "oidc-audience"
  | "oidc-subject"
  | "oidc-expired"
  | "oidc-not-before"
  | "oidc-lifetime"
  | "oidc-unmapped"
  | "oidc-revoked"
  | "oidc-discovery";

export class OidcRefusal extends Error {
  constructor(readonly code: OidcRefusalCode) {
    super(code);
  }
}

export interface OidcConfig {
  version: 1;
  issuer: string;
  audience: string;
  jwksUrl?: string;
}

export interface OidcMapping {
  issuer: string;
  claim: "sub" | "client_id";
  value: string;
}

export type Fetcher = (url: string, init: RequestInit) => Promise<Response>;

// https everywhere; plain http only to loopback (local tests and development).
export function isAllowedEndpoint(text: string): boolean {
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return false;
  }
  if (url.search || url.hash || url.username || url.password) return false;
  if (url.protocol === "https:") return true;
  return (
    url.protocol === "http:" &&
    ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)
  );
}

export function printableText(text: string, max: number): boolean {
  if (text.length === 0 || text.length > max) return false;
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0;
    if (code < 0x20 || code === 0x7f) return false;
  }
  return true;
}

export function validateOidcConfigInput(input: {
  issuer?: unknown;
  audience?: unknown;
  jwksUrl?: unknown;
}): OidcConfig {
  const invalid = (message: string) => new HomectlError(2, message);
  if (typeof input.issuer !== "string" || !isAllowedEndpoint(input.issuer))
    throw invalid(
      "Issuer must be an https URL (http is allowed only for loopback)",
    );
  if (typeof input.audience !== "string" || !printableText(input.audience, 256))
    throw invalid("Audience must be 1 to 256 printable characters");
  if (
    input.jwksUrl !== undefined &&
    (typeof input.jwksUrl !== "string" || !isAllowedEndpoint(input.jwksUrl))
  )
    throw invalid(
      "JWKS URL must be an https URL (http is allowed only for loopback)",
    );
  return {
    version: 1,
    issuer: input.issuer as string,
    audience: input.audience as string,
    ...(input.jwksUrl !== undefined
      ? { jwksUrl: input.jwksUrl as string }
      : {}),
  };
}

// The host only: enough for operators and audit, without paths or query data.
export function issuerHost(issuer: string): string {
  return new URL(issuer).host;
}

// Audit and views carry this, never the subject itself.
export function identityHash(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 12);
}

// Three base64url segments. A token that does not match is never JWT-verified.
export function looksLikeJwt(token: string): boolean {
  return (
    token.length <= MAX_TOKEN_BYTES &&
    /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*$/.test(token)
  );
}

function decodeObject(segment: string): Record<string, unknown> {
  let value: unknown;
  try {
    value = JSON.parse(Buffer.from(segment, "base64url").toString("utf8"));
  } catch {
    throw new OidcRefusal("oidc-format");
  }
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new OidcRefusal("oidc-format");
  return value as Record<string, unknown>;
}

function keyKindFor(alg: OidcAlgorithm): "rsa" | "ec" | "ed25519" {
  return alg === "RS256" ? "rsa" : alg === "ES256" ? "ec" : "ed25519";
}

interface KeyEntry {
  key: KeyObject;
  kind: "rsa" | "ec" | "ed25519";
  alg?: string;
}

// Builds a public key from one JWK, or undefined when it is unusable. Private
// key material (`d`) is never accepted.
function entryFromJwk(
  raw: unknown,
): { kid: string; entry: KeyEntry } | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const jwk = raw as Record<string, unknown>;
  if (typeof jwk.kid !== "string" || !printableText(jwk.kid, 256))
    return undefined;
  if (jwk.d !== undefined) return undefined;
  if (jwk.use !== undefined && jwk.use !== "sig") return undefined;
  try {
    const key = createPublicKey({ key: jwk as never, format: "jwk" });
    const details = key.asymmetricKeyDetails ?? {};
    let kind: KeyEntry["kind"] | undefined;
    if (key.asymmetricKeyType === "rsa" && (details.modulusLength ?? 0) >= 2048)
      kind = "rsa";
    else if (
      key.asymmetricKeyType === "ec" &&
      details.namedCurve === "prime256v1"
    )
      kind = "ec";
    else if (key.asymmetricKeyType === "ed25519") kind = "ed25519";
    if (!kind) return undefined;
    return {
      kid: jwk.kid,
      entry: {
        key,
        kind,
        ...(typeof jwk.alg === "string" ? { alg: jwk.alg } : {}),
      },
    };
  } catch {
    return undefined;
  }
}

// Keys for one issuer. Refreshes are time-bounded: the cache lasts JWKS_TTL_MS,
// an unknown kid refreshes at most once per REFRESH_MIN_MS, and a failed fetch
// keeps the previous keys (an unknown kid still fails closed).
export class JwksSource {
  private keys = new Map<string, KeyEntry>();
  private loadedAt = Number.NEGATIVE_INFINITY;
  private lastRefresh = Number.NEGATIVE_INFINITY;
  private jwksUrl: string | undefined;
  refreshes = 0;

  constructor(
    private readonly issuer: string,
    jwksUrl: string | undefined,
    private readonly fetcher: Fetcher,
    private readonly now: () => number,
  ) {
    this.jwksUrl = jwksUrl;
  }

  async keyFor(
    kid: string,
    alg: OidcAlgorithm,
  ): Promise<KeyObject | undefined> {
    const now = this.now();
    if (
      now - this.loadedAt > JWKS_TTL_MS &&
      now - this.lastRefresh >= REFRESH_MIN_MS
    )
      await this.refresh();
    let entry = this.keys.get(kid);
    if (!entry && now - this.lastRefresh >= REFRESH_MIN_MS) {
      await this.refresh();
      entry = this.keys.get(kid);
    }
    return entry && usable(entry, alg) ? entry.key : undefined;
  }

  private async refresh(): Promise<void> {
    this.lastRefresh = this.now();
    this.refreshes += 1;
    try {
      if (!this.jwksUrl) this.jwksUrl = await this.discover();
      const text = await this.get(this.jwksUrl);
      const parsed = JSON.parse(text) as { keys?: unknown };
      const next = new Map<string, KeyEntry>();
      for (const raw of Array.isArray(parsed.keys) ? parsed.keys : []) {
        const built = entryFromJwk(raw);
        if (built) next.set(built.kid, built.entry);
      }
      // Rotation: the new set replaces the old one, so retired keys stop verifying.
      this.keys = next;
      this.loadedAt = this.now();
    } catch {
      // Keep the previous keys; the caller sees only "unknown key".
    }
  }

  private async discover(): Promise<string> {
    const document = JSON.parse(
      await this.get(
        `${this.issuer.replace(/\/$/, "")}/.well-known/openid-configuration`,
      ),
    ) as { jwks_uri?: unknown };
    if (
      typeof document.jwks_uri !== "string" ||
      !isAllowedEndpoint(document.jwks_uri)
    )
      throw new OidcRefusal("oidc-discovery");
    return document.jwks_uri;
  }

  private async get(url: string): Promise<string> {
    if (!isAllowedEndpoint(url)) throw new OidcRefusal("oidc-discovery");
    const response = await this.fetcher(url, {
      redirect: "error",
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!response.ok) throw new OidcRefusal("oidc-discovery");
    const buffer = await response.arrayBuffer();
    if (buffer.byteLength > MAX_JWKS_BYTES)
      throw new OidcRefusal("oidc-discovery");
    return new TextDecoder().decode(buffer);
  }
}

function usable(entry: KeyEntry, alg: OidcAlgorithm): boolean {
  return (
    entry.kind === keyKindFor(alg) &&
    (entry.alg === undefined || entry.alg === alg)
  );
}

export interface VerifiedToken {
  issuer: string;
  subject: string;
  clientId?: string;
}

// Verifies signature and claims. Throws OidcRefusal with a fixed code.
export async function verifyOidcToken(
  token: string,
  options: { config: OidcConfig; source: JwksSource; nowMs: number },
): Promise<VerifiedToken> {
  if (!looksLikeJwt(token)) throw new OidcRefusal("oidc-format");
  const [headerPart = "", payloadPart = "", signaturePart = ""] =
    token.split(".");
  const header = decodeObject(headerPart);
  const payload = decodeObject(payloadPart);
  // The algorithm is checked before any key is looked up: none and HS* stop here.
  if (!(OIDC_ALGORITHMS as readonly string[]).includes(header.alg as string))
    throw new OidcRefusal("oidc-alg");
  const alg = header.alg as OidcAlgorithm;
  for (const name of ["crit", "jku", "jwk", "x5u", "x5c"])
    if (name in header) throw new OidcRefusal("oidc-header");
  if (
    header.typ !== undefined &&
    header.typ !== "JWT" &&
    header.typ !== "at+jwt"
  )
    throw new OidcRefusal("oidc-header");
  if (typeof header.kid !== "string" || header.kid.length === 0)
    throw new OidcRefusal("oidc-header");

  const key = await options.source.keyFor(header.kid, alg);
  if (!key) throw new OidcRefusal("oidc-unknown-key");
  const input = Buffer.from(`${headerPart}.${payloadPart}`);
  const signature = Buffer.from(signaturePart, "base64url");
  const valid =
    alg === "RS256"
      ? verify("sha256", input, key, signature)
      : alg === "ES256"
        ? signature.length === 64 &&
          verify("sha256", input, { key, dsaEncoding: "ieee-p1363" }, signature)
        : verify(null, input, key, signature);
  if (!valid) throw new OidcRefusal("oidc-signature");

  if (payload.iss !== options.config.issuer)
    throw new OidcRefusal("oidc-issuer");
  const audience = payload.aud;
  const audiences =
    typeof audience === "string"
      ? [audience]
      : Array.isArray(audience)
        ? audience
        : [];
  if (!audiences.includes(options.config.audience))
    throw new OidcRefusal("oidc-audience");
  if (typeof payload.sub !== "string" || !printableText(payload.sub, 256))
    throw new OidcRefusal("oidc-subject");

  const now = Math.floor(options.nowMs / 1000);
  if (typeof payload.exp !== "number" || now - CLOCK_SKEW_SECONDS > payload.exp)
    throw new OidcRefusal("oidc-expired");
  if (payload.nbf !== undefined) {
    if (
      typeof payload.nbf !== "number" ||
      payload.nbf > now + CLOCK_SKEW_SECONDS
    )
      throw new OidcRefusal("oidc-not-before");
  }
  if (payload.iat !== undefined) {
    if (
      typeof payload.iat !== "number" ||
      payload.iat > now + CLOCK_SKEW_SECONDS
    )
      throw new OidcRefusal("oidc-not-before");
    if (payload.exp - payload.iat > MAX_LIFETIME_SECONDS)
      throw new OidcRefusal("oidc-lifetime");
  }
  const clientId =
    typeof payload.client_id === "string"
      ? payload.client_id
      : typeof payload.azp === "string"
        ? payload.azp
        : undefined;
  return {
    issuer: payload.iss as string,
    subject: payload.sub,
    ...(clientId !== undefined ? { clientId } : {}),
  };
}
