import { describe, expect, test } from "bun:test";
import {
  archiveName,
  formula,
  parseChecksums,
  releaseUrl,
  wingetManifests,
} from "../scripts/render-packaging";

const VERSION = "0.2.0";
const TARGETS = [
  "macos-arm64",
  "macos-x64",
  "linux-arm64",
  "linux-x64",
  "windows-x64",
];
const SUMS_TEXT = TARGETS.map((target, i) => {
  const ext = target.startsWith("windows") ? "zip" : "tar.gz";
  const name = archiveName(VERSION, target, ext);
  return `${String(i + 1)
    .repeat(64)
    .slice(0, 64)}  ${name}`;
}).join("\n");
const sums = parseChecksums(SUMS_TEXT);

describe("checksums", () => {
  test("reads both sha256sum formats: text mode and binary mode", () => {
    const text = parseChecksums(
      `${"a".repeat(64)}  one.tar.gz\n${"b".repeat(64)} *two.zip\n`,
    );
    expect(text.get("one.tar.gz")).toBe("a".repeat(64));
    expect(text.get("two.zip")).toBe("b".repeat(64));
  });

  test("a file missing from SHA256SUMS is an error, never an empty checksum", () => {
    expect(() => sums.get("homectl-0.2.0-linux-x64-musl.tar.gz")).toThrow(
      "No checksum",
    );
  });
});

describe("Homebrew formula", () => {
  const text = formula(VERSION, sums);

  test("points each platform at its own release archive and checksum", () => {
    for (const target of [
      "macos-arm64",
      "macos-x64",
      "linux-arm64",
      "linux-x64",
    ]) {
      const name = archiveName(VERSION, target, "tar.gz");
      expect(text).toContain(`url "${releaseUrl(VERSION, name)}"`);
      expect(text).toContain(`sha256 "${sums.get(name)}"`);
    }
  });

  test("installs the binary and names the license and the version", () => {
    expect(text).toContain("class Homectl < Formula");
    expect(text).toContain(`version "${VERSION}"`);
    expect(text).toContain('license "MIT"');
    expect(text).toContain('bin.install "homectl"');
  });

  test("the formula has one url per platform branch", () => {
    expect(text.match(/\burl "/g)?.length).toBe(4);
  });
});

describe("winget manifests", () => {
  const manifests = wingetManifests(VERSION, sums);
  const id = "Hiosdra.homectl";

  test("writes the three manifests winget expects, all with the same identifier and version", () => {
    expect(Object.keys(manifests).sort()).toEqual([
      `${id}.installer.yaml`,
      `${id}.locale.en-US.yaml`,
      `${id}.yaml`,
    ]);
    for (const text of Object.values(manifests)) {
      expect(text).toContain(`PackageIdentifier: ${id}`);
      expect(text).toContain(`PackageVersion: ${VERSION}`);
      expect(text).toContain("ManifestVersion: 1.6.0");
    }
  });

  test("the installer is a portable zip whose executable is named in the zip", () => {
    const installer = manifests[`${id}.installer.yaml`] as string;
    expect(installer).toContain("InstallerType: zip");
    expect(installer).toContain("NestedInstallerType: portable");
    expect(installer).toContain(
      `RelativeFilePath: homectl-${VERSION}-windows-x64\\homectl.exe`,
    );
    expect(installer).toContain("PortableCommandAlias: homectl");
    const zip = archiveName(VERSION, "windows-x64", "zip");
    expect(installer).toContain(`InstallerUrl: ${releaseUrl(VERSION, zip)}`);
    expect(installer).toContain(
      `InstallerSha256: ${sums.get(zip).toUpperCase()}`,
    );
  });
});
