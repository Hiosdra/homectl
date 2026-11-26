// Signs dist/manifest.json into dist/manifest.json.sig with the HOMECTL_SIGNING_KEY secret
// (a 32-byte Ed25519 seed, hex). Without the secret the release is left unsigned and this
// step says so and succeeds unless --require-trusted is set for publication.
// The secret is read from the environment only and is never printed.
//   bun scripts/sign-release.ts [dist] [--require-trusted]
import { readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  MANIFEST_NAME,
  publicKeyOf,
  RELEASE_SIGNING_KEYS,
  REVOKED_RELEASE_KEY_IDS,
  SIGNATURE_NAME,
  signManifest,
  verifySignature,
} from "../src/release-trust";

const args = process.argv.slice(2);
const requireTrusted = args.includes("--require-trusted");
const dist = resolve(args.find((arg) => arg !== "--require-trusted") ?? "dist");
const seed = process.env.HOMECTL_SIGNING_KEY?.trim();
if (!seed) {
  if (requireTrusted) {
    console.error("HOMECTL_SIGNING_KEY is required to publish a release.");
    process.exit(1);
  }
  console.log(
    "::notice::HOMECTL_SIGNING_KEY is not set, so the release manifest is not signed. Builds will not install it automatically.",
  );
  process.exit(0);
}

let publicKey: string;
try {
  if (!/^[0-9a-f]{64}$/i.test(seed)) throw new Error("not a seed");
  publicKey = publicKeyOf(seed);
} catch {
  console.error(
    "HOMECTL_SIGNING_KEY is not a 32-byte Ed25519 seed in hex. Nothing was signed.",
  );
  process.exit(1);
}

const manifest = await readFile(join(dist, MANIFEST_NAME));
const signature = signManifest(manifest, seed);
const text = `${JSON.stringify(signature, null, 2)}\n`;
const trusted =
  RELEASE_SIGNING_KEYS.includes(publicKey) &&
  !REVOKED_RELEASE_KEY_IDS.includes(signature.keyId);
if (requireTrusted && !trusted) {
  console.error(
    "The release signing key must be trusted and active in this build.",
  );
  process.exit(1);
}
// Check the result the way a build will, before it is published.
verifySignature(manifest, text, { keys: [publicKey], revoked: [] });
await writeFile(join(dist, SIGNATURE_NAME), text);

if (!trusted)
  console.log(
    `::warning::The public key of HOMECTL_SIGNING_KEY is not an active trusted signer in src/release-trust.ts. Builds will refuse this release. keyId ${signature.keyId}`,
  );
console.log(`Signed ${MANIFEST_NAME} (keyId ${signature.keyId})`);
