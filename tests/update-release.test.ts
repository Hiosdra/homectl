// Signed release installs (homelab #21, U2). Keys are generated at runtime and archives are
// fakes that a fake unpacker expands, so these tests run on every platform. Every install
// is forced to the Windows x64 path the release build uses.
import { afterAll, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ed25519 } from "@noble/curves/ed25519.js";
import {
  checkCandidate,
  compareVersions,
  keyIdOf,
  parseManifest,
  publicKeyOf,
  type ReleaseManifest,
  selectArtifact,
  signManifest,
  verifySignature,
} from "../src/release-trust";
import type { Runner } from "../src/types";
import {
  installRelease,
  rollbackRelease,
  systemTar,
} from "../src/update-apply";

const RELEASES = "https://github.com/Hiosdra/homectl/releases/download";
const encode = (text: string) => new TextEncoder().encode(text);
const decode = (bytes: Uint8Array) => new TextDecoder().decode(bytes);
const ok = { stdout: "", stderr: "", exitCode: 0 };

type Signer = { seedHex: string; publicKey: string };
function newSigner(): Signer {
  const seedHex = Buffer.from(ed25519.utils.randomSecretKey()).toString("hex");
  return { seedHex, publicKey: publicKeyOf(seedHex) };
}

// A fake archive: its first lines name the folder and the program body.
const fakeArchive = (folder: string, body: string) =>
  encode(`FAKE-ARCHIVE\n${folder}\n${body}\n`);

// The unpacker the tests use in place of tar.exe: it expands a fake archive.
const runner: Runner = async ({ argv }) => {
  if (argv[0] !== systemTar()) return ok;
  const [, , zip, , staging] = argv as [string, string, string, string, string];
  const [, folder, body] = decode(await readFile(zip)).split("\n");
  await mkdir(join(staging, folder as string), { recursive: true });
  await writeFile(join(staging, folder as string, "home-ctl.exe"), body ?? "");
  return ok;
};

// A release as the pipeline publishes it: archive, manifest and signature, by URL.
function publish(
  signer: Signer,
  version: string,
  options: {
    body?: string;
    platform?: string;
    arch?: string;
    name?: string;
    sha256?: string;
    manifestVersion?: string;
  } = {},
) {
  const folder = `homectl-${version}-windows-x64`;
  const archiveBytes = fakeArchive(folder, options.body ?? "new");
  const artifact = {
    name: options.name ?? `${folder}.zip`,
    platform: options.platform ?? "win32",
    arch: options.arch ?? "x64",
    sha256:
      options.sha256 ??
      new Bun.CryptoHasher("sha256").update(archiveBytes).digest("hex"),
    size: archiveBytes.byteLength,
  };
  const manifest = {
    schema: 1,
    version: options.manifestVersion ?? version,
    artifacts: [artifact],
  };
  const manifestBytes = encode(`${JSON.stringify(manifest, null, 2)}\n`);
  const signature = JSON.stringify(signManifest(manifestBytes, signer.seedHex));
  const base = `${RELEASES}/v${version}`;
  const files = new Map<string, Uint8Array>([
    [`${base}/manifest.json`, manifestBytes],
    [`${base}/manifest.json.sig`, encode(signature)],
    [`${base}/${artifact.name}`, archiveBytes],
  ]);
  return { files, folder, manifestBytes, base };
}

const fetcherFor = (files: Map<string, Uint8Array>) => async (url: string) => {
  const bytes = files.get(url);
  return bytes
    ? new Response(bytes.slice())
    : new Response("not found", { status: 404 });
};

const roots: string[] = [];
async function temp(prefix: string) {
  const root = await mkdtemp(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

// The running release and the command files that point at it, as installed by hand.
async function installedRelease(version = "0.2.0") {
  const root = await temp("homectl-install-");
  const home = join(root, "home");
  const folder = `homectl-${version}-windows-x64`;
  const oldFolder = join(root, "share", "homectl", version, folder);
  await mkdir(oldFolder, { recursive: true });
  await writeFile(join(oldFolder, "home-ctl.exe"), "old");
  const bin = join(home, ".local", "bin");
  await mkdir(bin, { recursive: true });
  const exe = join(oldFolder, "home-ctl.exe");
  await writeFile(join(bin, "home-ctl.cmd"), `@echo off\n"${exe}" %*\n`);
  await writeFile(join(bin, "homectl.cmd"), `@echo off\n"${exe}" %*\n`);
  const sh = `#!/bin/sh\nexec "${exe.replaceAll("\\", "/")}" "$@"\n`;
  await writeFile(join(bin, "home-ctl"), sh);
  await writeFile(join(bin, "homectl"), sh);
  return { root, home, oldFolder, bin, exe };
}

const installedExe = (root: string, version: string, folder: string) =>
  join(root, "share", "homectl", version, folder, "home-ctl.exe");

const trusting = (signer: Signer) => ({ keys: [signer.publicKey] });

const install = (
  latest: string,
  inst: Awaited<ReturnType<typeof installedRelease>>,
  files: Map<string, Uint8Array>,
  extra: Record<string, unknown> = {},
) =>
  installRelease(latest, {
    platform: "win32",
    arch: "x64",
    execPath: inst.exe,
    home: inst.home,
    fetcher: fetcherFor(files),
    runner,
    current: "0.2.0",
    trust: trusting(extra.signer as Signer),
    ...extra,
  });

describe("signed release install", () => {
  test("a good signed release installs beside the running one and repoints the commands", async () => {
    const signer = newSigner();
    const release = publish(signer, "0.3.0");
    const inst = await installedRelease();
    const result = await install("v0.3.0", inst, release.files, { signer });
    expect(result.version).toBe("0.3.0");
    expect(
      await readFile(installedExe(inst.root, "0.3.0", release.folder), "utf8"),
    ).toBe("new");
    expect(await readFile(inst.exe, "utf8")).toBe("old");
    const cmd = await readFile(join(inst.bin, "home-ctl.cmd"), "utf8");
    expect(cmd).toContain("0.3.0");
    expect(cmd).not.toContain("0.2.0");
    expect(await readFile(join(inst.bin, "home-ctl"), "utf8")).toContain(
      "0.3.0",
    );
    expect(existsSync(join(inst.bin, "home-ctl.cmd.before-update.bak"))).toBe(
      true,
    );
    const history = JSON.parse(
      await readFile(
        join(inst.root, "share", "homectl", "release-history.json"),
        "utf8",
      ),
    );
    expect(history.previous.version).toBe("0.2.0");
  });

  test("a manifest whose bytes changed after signing is rejected and nothing is installed", async () => {
    const signer = newSigner();
    const release = publish(signer, "0.3.0");
    const url = `${release.base}/manifest.json`;
    release.files.set(
      url,
      encode(decode(release.manifestBytes).replace(/"size": \d+/, '"size": 1')),
    );
    const inst = await installedRelease();
    await expect(
      install("v0.3.0", inst, release.files, { signer }),
    ).rejects.toThrow("does not verify");
    expect(existsSync(join(inst.root, "share", "homectl", "0.3.0"))).toBe(
      false,
    );
    expect(await readFile(join(inst.bin, "home-ctl.cmd"), "utf8")).toContain(
      "0.2.0",
    );
  });

  test("a release signed by a key this build does not trust is rejected", async () => {
    const signer = newSigner();
    const other = newSigner();
    const release = publish(signer, "0.3.0");
    const inst = await installedRelease();
    await expect(
      install("v0.3.0", inst, release.files, { signer: other }),
    ).rejects.toThrow("does not trust");
  });

  test("a revoked signing key is refused even though it is still listed", async () => {
    const signer = newSigner();
    const release = publish(signer, "0.3.0");
    const inst = await installedRelease();
    await expect(
      install("v0.3.0", inst, release.files, {
        signer,
        trust: {
          keys: [signer.publicKey],
          revoked: [keyIdOf(signer.publicKey)],
        },
      }),
    ).rejects.toThrow("does not trust");
  });

  test("a build with no embedded release key installs nothing automatically", async () => {
    const signer = newSigner();
    const release = publish(signer, "0.3.0");
    const inst = await installedRelease();
    await expect(
      install("v0.3.0", inst, release.files, { signer, trust: { keys: [] } }),
    ).rejects.toThrow("no release signing key");
  });

  test("a release with no build for this platform is refused", async () => {
    const signer = newSigner();
    const release = publish(signer, "0.3.0", {
      platform: "linux",
      name: "homectl-0.3.0-linux-x64.tar.gz",
    });
    const inst = await installedRelease();
    await expect(
      install("v0.3.0", inst, release.files, { signer }),
    ).rejects.toThrow("no build for win32 x64");
  });

  test("a non-Windows build is told to use the release page", async () => {
    await expect(
      installRelease("v0.3.0", {
        platform: "linux",
        arch: "x64",
        fetcher: async () => new Response("unused"),
      }),
    ).rejects.toThrow("Windows x64");
  });

  test("an older signed release is refused as a downgrade", async () => {
    const signer = newSigner();
    const release = publish(signer, "0.1.0");
    const inst = await installedRelease();
    await expect(
      install("v0.1.0", inst, release.files, { signer }),
    ).rejects.toThrow("downgrade");
  });

  test("a signed manifest for another version cannot be served under this version", async () => {
    const signer = newSigner();
    const newer = publish(signer, "0.3.1");
    const files = new Map(newer.files);
    // The 0.3.1 manifest and archive are served at the 0.3.0 address.
    files.set(`${RELEASES}/v0.3.0/manifest.json`, newer.manifestBytes);
    files.set(
      `${RELEASES}/v0.3.0/manifest.json.sig`,
      files.get(`${RELEASES}/v0.3.1/manifest.json.sig`) as Uint8Array,
    );
    const inst = await installedRelease();
    await expect(install("v0.3.0", inst, files, { signer })).rejects.toThrow(
      "is for 0.3.1",
    );
  });

  test("an archive that does not match its signed checksum installs nothing", async () => {
    const signer = newSigner();
    const release = publish(signer, "0.3.0", { sha256: "0".repeat(64) });
    const inst = await installedRelease();
    await expect(
      install("v0.3.0", inst, release.files, { signer }),
    ).rejects.toThrow("does not match its checksum");
    expect(existsSync(join(inst.root, "share", "homectl", "0.3.0"))).toBe(
      false,
    );
  });

  test("an interrupted apply is recoverable by running the update again", async () => {
    const signer = newSigner();
    const release = publish(signer, "0.3.0");
    const inst = await installedRelease();
    const partial = join(
      inst.root,
      "share",
      "homectl",
      "0.3.0",
      `${release.folder}.partial`,
    );
    await mkdir(partial, { recursive: true });
    let interrupt = true;
    const onStage = (stage: string) => {
      if (stage === "installed" && interrupt) {
        interrupt = false;
        throw new Error("power cut");
      }
    };
    await expect(
      install("v0.3.0", inst, release.files, { signer, onStage }),
    ).rejects.toThrow("power cut");
    // The copy was complete before the interruption; the commands still point at 0.2.0.
    expect(existsSync(partial)).toBe(false);
    expect(existsSync(installedExe(inst.root, "0.3.0", release.folder))).toBe(
      true,
    );
    expect(await readFile(join(inst.bin, "home-ctl.cmd"), "utf8")).toContain(
      "0.2.0",
    );
    const again = await install("v0.3.0", inst, release.files, { signer });
    expect(again.version).toBe("0.3.0");
    expect(await readFile(join(inst.bin, "home-ctl.cmd"), "utf8")).toContain(
      "0.3.0",
    );
  });
});

describe("release rollback", () => {
  test("--rollback points the commands back at the earlier release, and a second rollback switches back", async () => {
    const signer = newSigner();
    const release = publish(signer, "0.3.0");
    const inst = await installedRelease();
    await install("v0.3.0", inst, release.files, { signer });
    const newExe = installedExe(inst.root, "0.3.0", release.folder);
    const rollback = () =>
      rollbackRelease({
        platform: "win32",
        execPath: newExe,
        home: inst.home,
        runner,
        current: "0.3.0",
      });
    const back = await rollback();
    expect(back.version).toBe("0.2.0");
    expect(await readFile(join(inst.bin, "home-ctl.cmd"), "utf8")).toContain(
      "0.2.0",
    );
    expect(await readFile(inst.exe, "utf8")).toBe("old");
    // The commands now run the earlier executable, which rolls forward again.
    await rollbackRelease({
      platform: "win32",
      execPath: inst.exe,
      home: inst.home,
      runner,
      current: "0.2.0",
    });
    expect(await readFile(join(inst.bin, "home-ctl.cmd"), "utf8")).toContain(
      "0.3.0",
    );
    // Running the release that is recorded as the earlier one changes nothing.
    await expect(
      rollbackRelease({
        platform: "win32",
        execPath: inst.exe,
        home: inst.home,
        runner,
      }),
    ).rejects.toThrow("already the earlier release");
  });

  test("rollback with no earlier release recorded changes nothing", async () => {
    const inst = await installedRelease();
    await expect(
      rollbackRelease({
        platform: "win32",
        execPath: inst.exe,
        home: inst.home,
        runner,
      }),
    ).rejects.toThrow("nothing to roll back to");
  });

  test("rollback refuses when the earlier release is no longer on disk", async () => {
    const signer = newSigner();
    const release = publish(signer, "0.3.0");
    const inst = await installedRelease();
    await install("v0.3.0", inst, release.files, { signer });
    await rm(inst.oldFolder, { recursive: true, force: true });
    await expect(
      rollbackRelease({
        platform: "win32",
        execPath: installedExe(inst.root, "0.3.0", release.folder),
        home: inst.home,
        runner,
      }),
    ).rejects.toThrow("no longer on disk");
  });
});

describe("release trust rules", () => {
  const manifest = (
    artifacts: ReleaseManifest["artifacts"],
    version = "0.3.0",
  ): ReleaseManifest => ({ schema: 1, version, artifacts });
  const artifact = (
    platform: string,
    arch: string,
    libc?: "glibc" | "musl",
  ): ReleaseManifest["artifacts"][number] => ({
    name: `homectl-0.3.0-${platform}-${arch}.zip`,
    platform,
    arch,
    ...(libc ? { libc } : {}),
    sha256: "0".repeat(64),
    size: 1,
  });

  test("versions compare by their numbers, not as text", () => {
    expect(compareVersions("0.10.0", "0.9.9")).toBe(1);
    expect(compareVersions("v0.3.0", "0.3.0")).toBe(0);
    expect(compareVersions("0.2.9", "0.3.0")).toBe(-1);
  });

  test("two builds for the same platform and arch are refused rather than guessed", () => {
    const list = manifest([
      artifact("linux", "x64", "glibc"),
      artifact("linux", "x64", "musl"),
    ]);
    expect(
      selectArtifact(list, { platform: "linux", arch: "x64", libc: "musl" })
        .libc,
    ).toBe("musl");
    expect(() =>
      selectArtifact(list, { platform: "linux", arch: "x64" }),
    ).toThrow("no build");
    const duplicate = manifest([
      artifact("win32", "x64"),
      artifact("win32", "x64"),
    ]);
    expect(() =>
      selectArtifact(duplicate, { platform: "win32", arch: "x64" }),
    ).toThrow("refusing to guess");
  });

  test("a manifest with an unknown schema or a malformed checksum is refused after the signature check", () => {
    expect(() => parseManifest(encode(JSON.stringify({ schema: 2 })))).toThrow(
      "unknown format",
    );
    expect(() =>
      parseManifest(
        encode(
          JSON.stringify(
            manifest([{ ...artifact("win32", "x64"), sha256: "not-hex" }]),
          ),
        ),
      ),
    ).toThrow("malformed file");
  });

  test("a candidate must name the requested version", () => {
    expect(() =>
      checkCandidate(manifest([], "0.3.1"), {
        requested: "0.3.0",
        current: "0.2.0",
      }),
    ).toThrow("is for 0.3.1");
  });

  test("a malformed signature file is refused", () => {
    const signer = newSigner();
    expect(() =>
      verifySignature(encode("{}"), "{not json", trusting(signer)),
    ).toThrow("not valid JSON");
    expect(() =>
      verifySignature(
        encode("{}"),
        JSON.stringify({ algorithm: "rsa", keyId: "x", signature: "00" }),
        trusting(signer),
      ),
    ).toThrow("malformed");
  });
});

afterAll(async () => {
  for (const root of roots) await rm(root, { recursive: true, force: true });
});
