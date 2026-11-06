# OIDC authentication for MCP clients (slice 4 design)

Status: implemented on `feat/issue-5-control-plane` (slice 4). Prepares the Authentik integration (sibling issue). This slice contacts no real identity provider; tests use a synthetic issuer on loopback. Code: `src/control/oidc.ts`, the OIDC path in `src/control/engine.ts` (`authenticate`), the protected-resource route in `src/control/mcp.ts`. Tests: `tests/control-oidc.test.ts`, `tests/control-oidc-cli.test.ts`.

## Decisions

1. **Static tokens stay the default.** A client keeps its `hct_` token. OIDC is opt-in per client. A deployment without `control oidc set` behaves exactly as before.
2. **The IdP proves identity; homectl grants access.** An OIDC access token (JWT) identifies a homectl client. Scopes and host grants stay in the homectl client record. Claims such as `scope`, `groups` or `roles` never grant anything.
3. **Mapping.** A client record may carry `oidc: { issuer, claim, value }`, where `claim` is `sub` or `client_id` and `value` is the expected claim value. A verified token maps to the one client whose `issuer` equals the configured issuer and whose claim equals the token's. Two clients may not share a mapping.
4. **Token selection.** A bearer token that starts with `hct_` takes the static path. Otherwise, if OIDC is configured and the token has three base64url segments, it takes the OIDC path. Anything else is refused with the same generic 401.

## Verification

- Size: at most 8 KiB. Header and payload must be JSON objects.
- Header: `alg` must be one of `RS256`, `ES256`, `EdDSA`. `none`, `HS*` and every other value are refused before any key is looked up. `kid` is required. `crit`, `jku`, `jwk`, `x5u` and `x5c` are refused, so a token cannot carry its own key.
- Key: found by `kid` in the JWKS. The key type must match the algorithm (RSA ≥ 2048 bits for RS256, P-256 for ES256, Ed25519 for EdDSA). `use`, when present, must be `sig`; `alg`, when present, must match the header.
- Signature: verified with `node:crypto`. ES256 uses the raw `r||s` encoding.
- Claims: `iss` equals the configured issuer exactly. `aud` contains the configured audience. `sub` is a string. `exp` is required. `nbf`, if present, is not in the future beyond skew. `iat`, if present, is not in the future beyond skew, and `exp - iat` is at most one hour. Skew is 60 seconds.
- Mapping: after the claims pass, the client mapping must match. A revoked homectl client is refused even with a valid token.

## JWKS fetch, cache and rotation

- Discovery is optional. `--jwks-url` may be given; otherwise the JWKS URI is read once from `<issuer>/.well-known/openid-configuration` and cached.
- Transport: `https` only, except `http` to loopback addresses (for local tests and development). Redirects are refused. Timeout 5 seconds. Response at most 64 KiB.
- Cache: keys are cached for 10 minutes. After that the next verification refreshes them. A failed refresh keeps the previous keys for the current request only; unknown `kid` values still fail closed.
- Unknown `kid`: one refresh, at most once per 30 seconds. If the key is still unknown, the token is refused. A burst of unknown-`kid` tokens therefore costs at most one fetch per 30 seconds.
- Rotation: a refresh replaces the whole key set, so retired keys stop verifying at the next refresh. Tokens signed by a new key verify after one refresh.

## Replay and revocation

- Bearer tokens are replayable until `exp`. Mitigations: the one-hour lifetime cap, TLS for any non-loopback exposure, and no token material in logs. There is no `jti` deny-list in this slice; if needed later it is a separate decision.
- Revocation is homectl-side and immediate: `control client revoke` refuses the client's OIDC tokens on the next request. IdP-side revocation is not enforced before `exp`; document this for operators.

## What the MCP endpoint advertises

The loopback MCP server serves OAuth protected-resource metadata (MCP authorization spec) at `/.well-known/oauth-protected-resource`: the resource URL, `authorization_servers` (the configured issuer, only when configured), `bearer_methods_supported: ["header"]`, and the scope names homectl understands. A 401 carries `WWW-Authenticate: Bearer resource_metadata="<url>"`. This fits loopback-only binding: the metadata is public and contains only the configured issuer. It is not an authorization server. Homectl does not issue tokens, does not register clients, and does not run an authorization-code flow; the client obtains tokens from the IdP directly.

If the endpoint is ever reached through a reverse proxy, the proxy must terminate TLS, forward only `/mcp` and the well-known path, and must not forward cookies. Homectl still refuses any Host other than the loopback host it was started with.

## Audit and logs

- Accepted: audit event `auth.oidc` with `client` = the homectl client id and `reason` = `issuer=<host>; subject-sha256=<first 12 hex>`.
- Refused: fixed reason codes only (`oidc-alg`, `oidc-signature`, `oidc-unknown-key`, `oidc-issuer`, `oidc-audience`, `oidc-expired`, `oidc-not-before`, `oidc-lifetime`, `oidc-unmapped`, `oidc-revoked`), with no token, claim value or IdP response text.
- Never logged: tokens, the full subject, claims other than the mapping claim, JWKS contents, or the discovery document.

## Configuration (planned commands)

- `homectl control oidc set --issuer URL --audience AUD [--jwks-url URL]`: writes the control-state config. No network access at set time.
- `homectl control oidc show`: issuer host, audience, JWKS source and whether keys are cached. No secrets exist to show.
- `homectl control client add ID ... --oidc-subject SUB` or `--oidc-client-id CID`: adds the mapping. Without `--token-file` the client is OIDC only (no static token); with it, the client has both routes.
- `homectl control client list`: an OIDC column with the issuer host. The panel's Clients tab shows an "OIDC" badge with the issuer host.

## Out of scope

Deploying or contacting Authentik or any other IdP; authorization-code flows; dynamic client registration; token issuance; token introspection; JWT encryption; `jti` replay tracking.

## Tests planned

`tests/control-oidc.test.ts` with a synthetic issuer on loopback: valid token; wrong audience; wrong issuer; expired; `nbf` in the future; `alg` none and HS256 refused; unknown `kid` causing exactly one refresh and then refusal; key rotation accepted after one refresh; a revoked client refused with a valid token; a static token still working when OIDC is configured; no token material in logs or audit (only the issuer host and subject hash).

## Implementation notes

- Config file `oidc.json` in the control state directory (no secrets). `control oidc clear` removes it; OIDC tokens are then refused, static tokens are unaffected.
- Discovery is implemented: without `--jwks-url`, the JWKS URI is read once from the issuer's `.well-known/openid-configuration`.
- Each OIDC sign-in is audited as `auth.oidc` (client id, issuer host, subject hash). A refusal is `auth.rejected` with the fixed code, for example `OIDC token refused: oidc-audience`.
- A client mapped with `--oidc-subject` or `--oidc-client-id` gets **no static token** unless `--token-file` is also given. Such an OIDC-only client has one route. A client with both is shown as "OIDC + token". The client list and the panel label each client's route: "token", "OIDC only" or "OIDC + token".
- A mapping is unique per issuer, claim and value. `client list` and the panel show the issuer host and a 12-hex identity hash, never the subject.
- `client_id` mapping matches the token's `client_id` claim, or `azp` when `client_id` is absent.
- `/.well-known/oauth-protected-resource` returns the resource, the scope names and, when configured, `authorization_servers`. A 401 carries `WWW-Authenticate: Bearer resource_metadata=...`.
- Residual: a bearer JWT is replayable until `exp`; IdP-side revocation is not seen before `exp`; there is no `jti` deny-list.
