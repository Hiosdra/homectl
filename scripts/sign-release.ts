// Signs dist/manifest.json into dist/manifest.json.sig with the HOMECTL_SIGNING_KEY secret
// (a 32-byte Ed25519 seed, hex). Without the secret the release is left unsigned and this
// step says so and succeeds: builds refuse unsigned releases for automatic updates.
// The secret is read from the environment only and is never printed.
//   bun scripts/sign-release.ts [dist]
import { readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  MANIFEST_NAME,
  publicKeyOf,
  RELEASE_SIGNING_KEYS,
  SIGNATURE_NAME,
  signManifest,
  verifySignature,
} from "../src/release-trust";

const dist = resolve(process.argv[2] ?? "dist");
const seed = process.env.HOMECTL_SIGNING_KEY?.trim();
if (!seed) {
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
// Check the result the way a build will, before it is published.
verifySignature(manifest, text, { keys: [publicKey], revoked: [] });
await writeFile(join(dist, SIGNATURE_NAME), text);

if (!RELEASE_SIGNING_KEYS.includes(publicKey))
  console.log(
    `::warning::The public key of HOMECTL_SIGNING_KEY is not in RELEASE_SIGNING_KEYS (src/release-trust.ts). Builds will refuse this release until it is added. keyId ${signature.keyId}`,
  );
console.log(`Signed ${MANIFEST_NAME} (keyId ${signature.keyId})`);
