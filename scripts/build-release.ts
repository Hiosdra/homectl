// Builds the release executables into dist/: one archive per target and a
// SHA256SUMS file. Every executable carries the web panel, so the panel is built
// first and the committed placeholder in src/web/embedded.ts is restored after.
//   bun scripts/build-release.ts            all targets
//   bun scripts/build-release.ts linux-x64  one target (for local checks)
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dir, "..");
const dist = join(root, "dist");
const stage = join(dist, "stage");
const embedded = join(root, "src", "web", "embedded.ts");

const pkg = JSON.parse(await readFile(join(root, "package.json"), "utf8")) as {
  version: string;
};
const version = pkg.version;

// Bun's compile targets. Musl builds run on Alpine and other musl systems.
const targets = [
  { name: "linux-x64", target: "bun-linux-x64", exe: "" },
  { name: "linux-arm64", target: "bun-linux-arm64", exe: "" },
  { name: "linux-x64-musl", target: "bun-linux-x64-musl", exe: "" },
  { name: "linux-arm64-musl", target: "bun-linux-arm64-musl", exe: "" },
  { name: "macos-x64", target: "bun-darwin-x64", exe: "" },
  { name: "macos-arm64", target: "bun-darwin-arm64", exe: "" },
  { name: "windows-x64", target: "bun-windows-x64", exe: ".exe" },
];

const only = process.argv[2];
const selected = only ? targets.filter((t) => t.name === only) : targets;
if (selected.length === 0) throw new Error(`Unknown target: ${only}`);

async function run(argv: string[], cwd = root) {
  const child = Bun.spawn(argv, { cwd, stdout: "inherit", stderr: "inherit" });
  const code = await child.exited;
  if (code !== 0) throw new Error(`${argv.join(" ")} exited with ${code}`);
}

const placeholder = await readFile(embedded, "utf8");
await rm(dist, { recursive: true, force: true });
await mkdir(stage, { recursive: true });
const archives: string[] = [];
try {
  await run([process.execPath, "scripts/build-panel.ts"]);
  for (const t of selected) {
    const folder = `homectl-${version}-${t.name}`;
    const binary = join(stage, folder, `homectl${t.exe}`);
    await mkdir(join(stage, folder), { recursive: true });
    await run([
      process.execPath,
      "build",
      "--compile",
      `--target=${t.target}`,
      "src/cli/main.ts",
      "--outfile",
      binary,
    ]);
    if (t.exe === "") {
      const archive = join(dist, `${folder}.tar.gz`);
      await run(["tar", "-czf", archive, "-C", stage, folder]);
      archives.push(archive);
    } else {
      const archive = join(dist, `${folder}.zip`);
      await run(["zip", "-qr", archive, folder], stage);
      archives.push(archive);
    }
    console.log(`built ${folder}`);
  }
} finally {
  // Put the committed placeholder back, so the release build leaves no diff.
  await writeFile(embedded, placeholder);
  await rm(stage, { recursive: true, force: true });
}

const lines: string[] = [];
for (const archive of archives) {
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(await Bun.file(archive).arrayBuffer());
  lines.push(`${hasher.digest("hex")}  ${archive.split(/[\\/]/).at(-1)}`);
}
await writeFile(join(dist, "SHA256SUMS"), `${lines.join("\n")}\n`);
console.log(`Wrote ${archives.length} archive(s) and SHA256SUMS to dist/`);
