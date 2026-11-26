// Installs a newer release for the local panel's "Update" button and for `home-ctl update`
// on a release build. A Windows release build fetches the signed manifest, verifies it
// (src/release-trust.ts), downloads the archive the manifest names, checks its size and
// sha256, unpacks it beside the running release and points the commands at the new one.
// The previous release stays on disk, and `home-ctl update --rollback` points the commands
// back at it. A source checkout uses `home-ctl update`. Other builds are told what to do.
import { existsSync } from "node:fs";
import {
  copyFile,
  cp,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { VERSION } from "./container/health";
import { bundled } from "./internal";
import { run } from "./process";
import {
  checkArchive,
  checkCandidate,
  MANIFEST_NAME,
  parseManifest,
  SIGNATURE_NAME,
  selectArtifact,
  type TrustPolicy,
  verifySignature,
} from "./release-trust";
import { HomectlError, type Runner } from "./types";

// Where release archives and manifests are downloaded from. The broker's update routes
// (src/broker/update-routes.ts) read this same constant.
export const RELEASE_DOWNLOAD_BASE =
  "https://github.com/Hiosdra/homectl/releases/download";
// Command files are small text shims; anything larger is never read.
const SHIM_LIMIT = 64 * 1024;
// Which release was running before the last install, for --rollback.
const HISTORY_FILE = "release-history.json";

export type UpdateApplyOptions = {
  platform?: NodeJS.Platform;
  arch?: string;
  execPath?: string;
  home?: string;
  fetcher?: (url: string) => Promise<Response>;
  runner?: Runner;
  // The running version; defaults to this build's version.
  current?: string;
  // Signers to trust; defaults to the keys embedded in this build.
  trust?: TrustPolicy;
  // Test seam: runs after each stage. Throwing here simulates an interrupted apply.
  onStage?: (
    stage: "staged" | "installed" | "repointed",
  ) => void | Promise<void>;
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
  const current = options.current ?? VERSION;
  const version = latest.replace(/^v/, "");
  const folder = `homectl-${version}-windows-x64`;
  const archive = `${folder}.zip`;
  const base = `${RELEASE_DOWNLOAD_BASE}/v${version}`;

  // Nothing from the release is used until its signature has been checked.
  const manifestBytes = await download(`${base}/${MANIFEST_NAME}`, fetcher);
  const signature = new TextDecoder().decode(
    await download(`${base}/${SIGNATURE_NAME}`, fetcher),
  );
  verifySignature(manifestBytes, signature, options.trust);
  const manifest = parseManifest(manifestBytes);
  checkCandidate(manifest, { requested: version, current });
  const artifact = selectArtifact(manifest, { platform, arch });
  if (artifact.name !== archive)
    throw new HomectlError(
      5,
      "The release manifest names an unexpected archive. Nothing was installed.",
    );
  const bytes = await download(`${base}/${archive}`, fetcher);
  checkArchive(artifact, bytes);

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
    await options.onStage?.("staged");

    // The running release lives in <root>\<version>\<folder>; the new one goes beside it.
    const currentFolder = dirname(execPath);
    const root = dirname(dirname(currentFolder));
    const target = join(root, version, folder);
    // A copy is built under a .partial name and renamed into place, so `target` exists only
    // when it is complete. A rerun after an interruption reuses a complete copy.
    if (!existsSync(target)) {
      await mkdir(join(root, version), { recursive: true });
      const partial = `${target}.partial`;
      await rm(partial, { recursive: true, force: true });
      await cp(built, partial, { recursive: true });
      await rename(partial, target);
    }
    await options.onStage?.("installed");
    await repointCommands(join(home, ".local", "bin"), currentFolder, target);
    await options.onStage?.("repointed");
    await writeHistory(root, {
      previous: { version: current, folder: currentFolder },
    });
    // The new release carries its own skills, so it copies them now. A failure does not undo
    // the update; the note says what to run.
    const skills = await runner({
      argv: [join(target, "home-ctl.exe"), "__internal", "refresh-skills"],
      timeoutMs: 60_000,
    });
    return {
      updated: true,
      version,
      next: `Restart homectl to run ${version}. The previous release stays in ${currentFolder}; \`home-ctl update --rollback\` switches back to it.${
        skills.exitCode
          ? " Its skills were not refreshed; run home-ctl setup to see why."
          : ""
      }`,
    };
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

// Points the command files back at the release that ran before the last install. The
// earlier release must still be on disk and start; nothing else changes.
export async function rollbackRelease(
  options: UpdateApplyOptions = {},
): Promise<UpdateApplied> {
  const platform = options.platform ?? process.platform;
  if (platform !== "win32")
    throw new HomectlError(
      2,
      "Rollback applies to Windows release builds. Install an earlier release from the release page on this platform.",
    );
  const execPath = options.execPath ?? process.execPath;
  const home = options.home ?? homedir();
  const runner = options.runner ?? run;
  const currentFolder = dirname(execPath);
  const root = dirname(dirname(currentFolder));
  const previous = (await readHistory(root))?.previous;
  if (!previous)
    throw new HomectlError(
      5,
      "No earlier release is recorded, so there is nothing to roll back to.",
    );
  if (previous.folder === currentFolder)
    throw new HomectlError(
      5,
      "This is already the earlier release, so there is nothing to roll back. Nothing was changed.",
    );
  const exe = join(previous.folder, "home-ctl.exe");
  if (!existsSync(exe))
    throw new HomectlError(
      5,
      `The earlier release is no longer on disk (${previous.folder}). Nothing was changed.`,
    );
  const started = await runner({ argv: [exe, "help"], timeoutMs: 60_000 });
  if (started.exitCode)
    throw new HomectlError(
      5,
      "The earlier release does not start. Nothing was changed.",
    );
  await repointCommands(
    join(home, ".local", "bin"),
    currentFolder,
    previous.folder,
  );
  // Recording the release we leave makes a second rollback switch back again.
  await writeHistory(root, {
    previous: { version: options.current ?? VERSION, folder: currentFolder },
  });
  return {
    updated: true,
    version: previous.version,
    next: `Restart homectl to run ${previous.version}. Run \`home-ctl update --rollback\` again to switch back.`,
  };
}

type History = { previous?: { version: string; folder: string } };

async function readHistory(root: string): Promise<History | undefined> {
  try {
    const value = JSON.parse(
      await readFile(join(root, HISTORY_FILE), "utf8"),
    ) as History;
    const previous = value.previous;
    if (
      previous &&
      typeof previous.version === "string" &&
      typeof previous.folder === "string"
    )
      return { previous };
    return undefined;
  } catch {
    return undefined;
  }
}

async function writeHistory(root: string, history: History) {
  await writeFile(
    join(root, HISTORY_FILE),
    `${JSON.stringify(history, null, 2)}\n`,
  );
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
