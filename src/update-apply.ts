// Installs a newer release for the local panel's "Update" button. A Windows release build
// downloads the release archive, checks it against the published SHA256SUMS, unpacks it
// beside the running release, and points the commands at the new one. The previous
// release stays on disk, and each command file keeps a backup. A source checkout uses
// `home-ctl update`. Other builds are told what to do instead.
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import {
  copyFile,
  cp,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { bundled } from "./internal";
import { run } from "./process";
import { HomectlError, type Runner } from "./types";

const RELEASES = "https://github.com/Hiosdra/homectl/releases/download";
// Command files are small text shims; anything larger is never read.
const SHIM_LIMIT = 64 * 1024;

export type UpdateApplyOptions = {
  platform?: NodeJS.Platform;
  arch?: string;
  execPath?: string;
  home?: string;
  fetcher?: (url: string) => Promise<Response>;
  runner?: Runner;
};

export type UpdateApplied = {
  updated: boolean;
  version?: string;
  revision?: string;
  next: string;
};

export async function applyUpdate(
  latest: string,
  options: UpdateApplyOptions = {},
): Promise<UpdateApplied> {
  if (!bundled) {
    const { update } = await import("./update");
    const result = await update(false);
    if (!("updated" in result))
      throw new HomectlError(5, "The update did not run.");
    return {
      updated: result.updated === true,
      revision: result.revision,
      next: result.next ?? "Restart homectl to load the update.",
    };
  }
  return installRelease(latest, options);
}

export async function installRelease(
  latest: string,
  options: UpdateApplyOptions,
): Promise<UpdateApplied> {
  const platform = options.platform ?? process.platform;
  const arch = options.arch ?? process.arch;
  if (platform !== "win32" || arch !== "x64")
    throw new HomectlError(
      2,
      "Automatic install is available for Windows x64 release builds. Install the newer release from the release page on this platform.",
    );
  const execPath = options.execPath ?? process.execPath;
  const home = options.home ?? homedir();
  const fetcher = options.fetcher ?? ((url: string) => fetch(url));
  const runner = options.runner ?? run;
  const version = latest.replace(/^v/, "");
  const folder = `homectl-${version}-windows-x64`;
  const archive = `${folder}.zip`;

  const sums = new TextDecoder().decode(
    await download(`${RELEASES}/v${version}/SHA256SUMS`, fetcher),
  );
  const expected = sums
    .split(/\r?\n/)
    .map((line) => line.trim().split(/\s+/))
    .find(([, name]) => name === archive || name === `*${archive}`)?.[0];
  if (!expected)
    throw new HomectlError(5, "The release has no checksum for this build.");
  const bytes = await download(`${RELEASES}/v${version}/${archive}`, fetcher);
  const actual = createHash("sha256").update(bytes).digest("hex");
  if (actual !== expected.toLowerCase())
    throw new HomectlError(
      5,
      "The downloaded release does not match its checksum. Nothing was installed.",
    );

  const staging = await mkdtemp(join(tmpdir(), "homectl-update-"));
  try {
    const zip = join(staging, archive);
    await writeFile(zip, bytes);
    const unpacked = await runner({
      argv: [systemTar(), "-xf", zip, "-C", staging],
    });
    if (unpacked.exitCode)
      throw new HomectlError(5, "The release archive could not be unpacked.");
    const built = join(staging, folder);
    const exe = join(built, "home-ctl.exe");
    if (!existsSync(exe))
      throw new HomectlError(5, "The release archive has no home-ctl.exe.");
    const started = await runner({ argv: [exe, "help"], timeoutMs: 60_000 });
    if (started.exitCode)
      throw new HomectlError(
        5,
        "The new homectl does not start. Nothing was changed.",
      );

    // The running release lives in <root>\<version>\<folder>; the new one goes beside it.
    const currentFolder = dirname(execPath);
    const root = dirname(dirname(currentFolder));
    const target = join(root, version, folder);
    if (existsSync(target))
      throw new HomectlError(5, `Version ${version} is already installed.`);
    await mkdir(join(root, version), { recursive: true });
    await cp(built, target, { recursive: true });
    await repointCommands(join(home, ".local", "bin"), currentFolder, target);
    // The new release carries its own skills, so it copies them now. A failure does not undo
    // the update; the note says what to run.
    const skills = await runner({
      argv: [join(target, "home-ctl.exe"), "__internal", "refresh-skills"],
      timeoutMs: 60_000,
    });
    return {
      updated: true,
      version,
      next: `Restart homectl to run ${version}. The previous release stays in ${currentFolder}.${
        skills.exitCode
          ? " Its skills were not refreshed; run home-ctl setup to see why."
          : ""
      }`,
    };
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

// The Windows tar, by full path: a Git-provided tar earlier in PATH cannot read zip archives.
export function systemTar() {
  return join(process.env.SystemRoot ?? "C:Windows", "System32", "tar.exe");
}

async function download(
  url: string,
  fetcher: (url: string) => Promise<Response>,
) {
  const response = await fetcher(url);
  if (!response.ok)
    throw new HomectlError(
      5,
      `The release download failed (${response.status}).`,
    );
  return new Uint8Array(await response.arrayBuffer());
}

// Rewrites the command files that point at the old release. Only small files whose name
// starts with home-ctl or homectl (the name before the rename) are read; each one is backed
// up before it changes.
async function repointCommands(
  binDir: string,
  oldFolder: string,
  newFolder: string,
) {
  if (!existsSync(binDir)) return;
  const forms = (path: string) => [
    path,
    path.replaceAll("\\", "/"),
    path.replaceAll("/", "\\"),
  ];
  const from = forms(oldFolder);
  const to = forms(newFolder);
  for (const name of await readdir(binDir)) {
    if (
      !(name.startsWith("home-ctl") || name.startsWith("homectl")) ||
      name.endsWith(".bak")
    )
      continue;
    const file = join(binDir, name);
    const info = await stat(file);
    if (!info.isFile() || info.size > SHIM_LIMIT) continue;
    const text = await readFile(file, "utf8");
    let next = text;
    from.forEach((oldPath, i) => {
      next = next.replaceAll(oldPath, to[i] ?? oldPath);
    });
    if (next === text) continue;
    await copyFile(file, `${file}.before-update.bak`);
    await writeFile(file, next);
  }
}
