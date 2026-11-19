// Writes dist/manifest.json: the release version and one entry per archive in dist/
// (platform, arch, libc, size and sha256). Run after scripts/build-release.ts. Signing is a
// separate step (scripts/sign-release.ts), and builds install only signed manifests.
//   bun scripts/release-manifest.ts [dist]
import { readdir, readFile, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { MANIFEST_NAME, type ReleaseArtifact } from "../src/release-trust";

// Build target name (as in scripts/build-release.ts) to what a self-update matches on.
const TARGETS: Record<
  string,
  { platform: string; arch: string; libc?: "glibc" | "musl" }
> = {
  "linux-x64": { platform: "linux", arch: "x64", libc: "glibc" },
  "linux-arm64": { platform: "linux", arch: "arm64", libc: "glibc" },
  "linux-x64-musl": { platform: "linux", arch: "x64", libc: "musl" },
  "linux-arm64-musl": { platform: "linux", arch: "arm64", libc: "musl" },
  "macos-x64": { platform: "darwin", arch: "x64" },
  "macos-arm64": { platform: "darwin", arch: "arm64" },
  "windows-x64": { platform: "win32", arch: "x64" },
};

const dist = resolve(process.argv[2] ?? "dist");
const pkg = JSON.parse(
  await readFile(resolve(import.meta.dir, "..", "package.json"), "utf8"),
) as { version: string };
const version = pkg.version;
const pattern = new RegExp(
  `^homectl-${version.replaceAll(".", "\\.")}-(.+)\\.(tar\\.gz|zip)$`,
);

const artifacts: ReleaseArtifact[] = [];
for (const name of (await readdir(dist)).sort()) {
  const match = pattern.exec(name);
  if (!match) continue;
  const target = TARGETS[match[1] ?? ""];
  if (!target) throw new Error(`No platform mapping for ${name}`);
  const bytes = await readFile(join(dist, name));
  artifacts.push({
    name,
    ...target,
    size: (await stat(join(dist, name))).size,
    sha256: new Bun.CryptoHasher("sha256").update(bytes).digest("hex"),
  });
}
if (artifacts.length === 0)
  throw new Error(`No release archives for ${version} in ${dist}`);

const manifest = { schema: 1, version, artifacts };
await writeFile(
  join(dist, MANIFEST_NAME),
  `${JSON.stringify(manifest, null, 2)}\n`,
);
console.log(`Wrote ${MANIFEST_NAME} for ${artifacts.length} archive(s)`);
