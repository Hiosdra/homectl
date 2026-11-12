// Builds the Linux packages (deb, rpm, pacman, apk) from the release archives that
// build-release.ts wrote to dist/. nfpm packages the executable that is already
// compiled, so the packages carry the same bytes as the archives. Package checksums
// are appended to dist/SHA256SUMS.
//   bun scripts/build-packages.ts                  nfpm from PATH (CI installs it)
//   NFPM_IMAGE=goreleaser/nfpm:v2.49.0 bun scripts/build-packages.ts   nfpm in Docker
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dir, "..");
const dist = join(root, "dist");
const staging = join(root, ".packaging-stage");
const template = join(root, "packaging", "nfpm", "nfpm.yaml");
const image = process.env.NFPM_IMAGE;

const { version } = JSON.parse(
  await readFile(join(root, "package.json"), "utf8"),
) as { version: string };

// glibc builds get deb. The musl builds get apk, for Alpine.
// rpm and pacman are configured in packaging/nfpm/nfpm.yaml but not built: on Fedora and
// Arch the systemd package already ships /usr/bin/homectl (systemd-homed), so a package
// that installs the same path conflicts with it. The command name is an owner decision.
const plan = [
  { target: "linux-x64", arch: "amd64", packagers: ["deb"] },
  { target: "linux-arm64", arch: "arm64", packagers: ["deb"] },
  { target: "linux-x64-musl", arch: "amd64", packagers: ["apk"] },
  { target: "linux-arm64-musl", arch: "arm64", packagers: ["apk"] },
];

async function run(argv: string[]): Promise<void> {
  const child = Bun.spawn(argv, {
    cwd: root,
    stdout: "inherit",
    stderr: "inherit",
  });
  const code = await child.exited;
  if (code !== 0)
    throw new Error(`${argv.slice(0, 3).join(" ")} exited with ${code}`);
}

// Paths are relative to the repository root, with forward slashes, because nfpm can run in a container.
function nfpmCommand(args: string[]): string[] {
  if (image)
    return [
      "docker",
      "run",
      "--rm",
      "-v",
      `${root}:/work`,
      "-w",
      "/work",
      image,
      ...args,
    ];
  return ["nfpm", ...args];
}

const selected = plan.filter(
  (p) => Bun.file(join(dist, `homectl-${version}-${p.target}.tar.gz`)).size > 0,
);
if (selected.length === 0)
  throw new Error(
    "No Linux release archives in dist/. Run build-release.ts first.",
  );

const templateText = await readFile(template, "utf8");

await rm(staging, { recursive: true, force: true });
try {
  for (const p of selected) {
    const folder = `homectl-${version}-${p.target}`;
    const stage = `.packaging-stage/${p.target}`;
    await mkdir(join(root, stage), { recursive: true });
    // Relative paths: GNU tar reads a drive letter such as C: as a remote host.
    await run(["tar", "-xzf", `dist/${folder}.tar.gz`, "-C", stage]);

    // nfpm does not expand variables, so the placeholders are filled here.
    const config = `${stage}/nfpm.yaml`;
    const filled = templateText
      .replaceAll("@VERSION@", version)
      .replaceAll("@ARCH@", p.arch)
      .replaceAll("@BINARY@", `${stage}/${folder}/homectl`);
    await writeFile(join(root, config), filled);

    for (const packager of p.packagers) {
      await run(
        nfpmCommand([
          "package",
          "--packager",
          packager,
          "--target",
          "dist",
          "--config",
          config,
        ]),
      );
      console.log(`packaged ${packager} ${p.arch} (${p.target})`);
    }
  }
} finally {
  await rm(staging, { recursive: true, force: true });
}

// Append the package files to the checksums the archives already have.
const sums = join(dist, "SHA256SUMS");
const existing = (await readFile(sums, "utf8")).trimEnd();
const names: string[] = [];
for await (const name of new Bun.Glob("*").scan(dist)) names.push(name);
const entries = names
  .filter((name) => /\.(deb|rpm|apk|pkg\.tar\.zst)$/.test(name))
  .sort();
const lines: string[] = [];
for (const name of entries) {
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(await Bun.file(join(dist, name)).arrayBuffer());
  lines.push(`${hasher.digest("hex")}  ${name}`);
}
if (lines.length === 0) throw new Error("nfpm produced no package files");
await writeFile(sums, `${existing}\n${lines.join("\n")}\n`);
console.log(`Added ${lines.length} package checksum(s) to dist/SHA256SUMS`);
