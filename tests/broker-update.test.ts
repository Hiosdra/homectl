// Owner update routes (homelab #21 §8): status, step-up, version and signature
// refusals, the install-capability gate, the cached release check and the staged
// happy path. The release source, the installer and the signing keys are fakes
// made at runtime; nothing reaches the network or replaces a real binary.
import { describe, expect, test } from "bun:test";
import { ed25519 } from "@noble/curves/ed25519.js";
import {
  type InstallFacts,
  type Installer,
  blockedReason,
  checkSignature,
  isPackageManagerPath,
  UpdateRoutes,
} from "../src/broker/update-routes";
import type { EventsPort } from "../src/broker/types";
import { publicKeyOf, signManifest } from "../src/release-trust";
import { HomectlError } from "../src/types";

const RELEASES = "https://github.com/Hiosdra/homectl/releases/download";
const API = "https://api.github.com/repos/Hiosdra/homectl/releases/latest";
const encode = (text: string) => new TextEncoder().encode(text);

type Signer = { seedHex: string; publicKey: string };
function newSigner(): Signer {
  const seedHex = Buffer.from(ed25519.utils.randomSecretKey()).toString("hex");
  return { seedHex, publicKey: publicKeyOf(seedHex) };
}
const trusted = newSigner();
const stranger = newSigner();

const windows: InstallFacts = {
  bundled: true,
  platform: "win32",
  arch: "x64",
  execPath:
    "C:\\Users\\tester\\AppData\\Local\\Programs\\homectl\\0.2.0\\homectl-0.2.0-windows-x64\\home-ctl.exe",
  container: false,
};

const stepUp = (password: unknown) =>
  password === "owner-pw"
    ? Promise.resolve()
    : Promise.reject(new HomectlError(3, "Confirm with the owner password"));

// The files a release publishes, by URL. The manifest is signed by `signer`.
function publish(
  version: string,
  signer: Signer,
  options: { manifestVersion?: string; signatureMissing?: boolean } = {},
): Map<string, Uint8Array> {
  const archive = encode(`FAKE-ARCHIVE ${version}`);
  const manifest = {
    schema: 1,
    version: options.manifestVersion ?? version,
    artifacts: [
      {
        name: `homectl-${version}-windows-x64.zip`,
        platform: "win32",
        arch: "x64",
        sha256: new Bun.CryptoHasher("sha256").update(archive).digest("hex"),
        size: archive.byteLength,
      },
    ],
  };
  const manifestBytes = encode(`${JSON.stringify(manifest, null, 2)}\n`);
  const signature = JSON.stringify(signManifest(manifestBytes, signer.seedHex));
  const base = `${RELEASES}/v${version}`;
  const files = new Map<string, Uint8Array>([
    [`${base}/manifest.json`, manifestBytes],
  ]);
  if (!options.signatureMissing)
    files.set(`${base}/manifest.json.sig`, encode(signature));
  return files;
}

// A fake GitHub release API plus the release files. Counts API calls.
function releaseSource(
  tag: string,
  files: Map<string, Uint8Array>,
  options: { networkDownFor?: string } = {},
) {
  const calls = { api: 0 };
  const fetch = async (url: string) => {
    if (url === API) {
      calls.api += 1;
      return new Response(
        JSON.stringify({
          tag_name: `v${tag}`,
          html_url: `https://github.com/Hiosdra/homectl/releases/tag/v${tag}`,
        }),
        { status: 200 },
      );
    }
    if (options.networkDownFor && url.includes(options.networkDownFor))
      throw new TypeError("network unreachable");
    const bytes = files.get(url);
    return bytes
      ? new Response(bytes.slice(), { status: 200 })
      : new Response("not found", { status: 404 });
  };
  return { fetch, calls };
}

type Harness = {
  routes: UpdateRoutes;
  installs: { version: string; trust: unknown; current: string }[];
  events: {
    type: string;
    subject: string;
    audience: string[];
    data: Record<string, unknown>;
  }[];
  calls: { api: number };
  clock: { now: number };
  owner: (path: string, input: Record<string, unknown>) => Promise<unknown>;
};

function harness(
  options: {
    tag?: string;
    files?: Map<string, Uint8Array>;
    networkDownFor?: string;
    facts?: InstallFacts;
    current?: string;
    install?: Installer;
    ttlMs?: number;
  } = {},
): Harness {
  const files = options.files ?? publish("0.3.0", trusted);
  const source = releaseSource(options.tag ?? "0.3.0", files, {
    ...(options.networkDownFor
      ? { networkDownFor: options.networkDownFor }
      : {}),
  });
  const installs: Harness["installs"] = [];
  const install: Installer =
    options.install ??
    (async (version, installOptions) => {
      installs.push({
        version,
        trust: installOptions.trust,
        current: installOptions.current ?? "",
      });
      return {
        updated: true,
        version,
        next: `Restart homectl to run ${version}.`,
      };
    });
  const events: Harness["events"] = [];
  const port: EventsPort = {
    emit: async (type, subject, audience, data) => {
      events.push({ type, subject, audience, data });
    },
  };
  const clock = { now: 1_800_000_000_000 };
  const routes = new UpdateRoutes({
    current: options.current ?? "0.2.0",
    fetch: source.fetch,
    now: () => clock.now,
    ttlMs: options.ttlMs ?? 60 * 60 * 1000,
    trust: { keys: [trusted.publicKey] },
    facts: options.facts ?? windows,
    install,
    events: port,
  });
  return {
    routes,
    installs,
    events,
    calls: source.calls,
    clock,
    owner: (path, input) =>
      routes.owner(path, input, stepUp) as Promise<unknown>,
  };
}

const STATUS = "/v1/owner/update/status";
const APPLY = "/v1/owner/update/apply";

describe("update status", () => {
  test("reports a verified signature and that the panel can apply it", async () => {
    const h = harness();
    expect(await h.owner(STATUS, {})).toEqual({
      current: "0.2.0",
      latest: "0.3.0",
      available: true,
      signature: "verified",
      canApply: true,
    });
  });

  test("reports a failed signature when the release is signed by an untrusted key", async () => {
    const h = harness({ files: publish("0.3.0", stranger) });
    expect(await h.owner(STATUS, {})).toMatchObject({
      latest: "0.3.0",
      signature: "failed",
      canApply: true,
    });
  });

  test("reports an unverified signature when the release has no signed manifest", async () => {
    const h = harness({
      files: publish("0.3.0", trusted, { signatureMissing: true }),
    });
    expect(await h.owner(STATUS, {})).toMatchObject({
      signature: "unverified",
    });
  });

  test("reports an unknown signature when the release files cannot be reached", async () => {
    const h = harness({ networkDownFor: "manifest.json" });
    expect(await h.owner(STATUS, {})).toMatchObject({
      latest: "0.3.0",
      signature: "unknown",
    });
  });

  test("reports no release and an unknown signature when the release check fails", async () => {
    const failing = new UpdateRoutes({
      current: "0.2.0",
      fetch: async () => new Response("down", { status: 503 }),
      facts: windows,
    });
    const status = await failing.owner(STATUS, {}, stepUp);
    expect(status).toEqual({
      current: "0.2.0",
      available: false,
      signature: "unknown",
      canApply: true,
    });
  });

  test("a manifest for another version is a failed signature, not a verified one", async () => {
    const h = harness({ files: publish("0.3.0", trusted, {}) });
    const source = publish("0.3.0", trusted, { manifestVersion: "0.3.5" });
    const other = harness({ files: source });
    expect(await h.owner(STATUS, {})).toMatchObject({ signature: "verified" });
    expect(await other.owner(STATUS, {})).toMatchObject({
      signature: "failed",
    });
  });

  test("the release check is reused until its TTL runs out", async () => {
    const h = harness({ ttlMs: 1000 });
    await h.owner(STATUS, {});
    await h.owner(STATUS, {});
    expect(h.calls.api).toBe(1);
    h.clock.now += 1001;
    await h.owner(STATUS, {});
    expect(h.calls.api).toBe(2);
  });

  test("a source checkout, a container or a package-manager install cannot apply, and says why", async () => {
    const source = harness({ facts: { ...windows, bundled: false } });
    expect(await source.owner(STATUS, {})).toMatchObject({
      canApply: false,
      reason: expect.stringContaining("source checkout"),
    });
    const container = harness({ facts: { ...windows, container: true } });
    expect(await container.owner(STATUS, {})).toMatchObject({
      canApply: false,
      reason: expect.stringContaining("container"),
    });
    const scoop = harness({
      facts: {
        ...windows,
        execPath:
          "C:\\Users\\tester\\scoop\\apps\\homectl\\0.2.0\\home-ctl.exe",
      },
    });
    expect(await scoop.owner(STATUS, {})).toMatchObject({
      canApply: false,
      reason: expect.stringContaining("package manager"),
    });
    const linux = harness({
      facts: { ...windows, platform: "linux", arch: "x64" },
    });
    expect(await linux.owner(STATUS, {})).toMatchObject({
      canApply: false,
      reason: expect.stringContaining("Windows x64"),
    });
  });
});

describe("update apply", () => {
  test("is refused without the owner password, before anything is prepared", async () => {
    const h = harness();
    await expect(h.owner(APPLY, { version: "0.3.0" })).rejects.toThrow(
      "Confirm with the owner password",
    );
    await expect(
      h.owner(APPLY, { version: "0.3.0", password: "wrong" }),
    ).rejects.toThrow("Confirm with the owner password");
    expect(h.installs).toHaveLength(0);
    expect(h.events).toHaveLength(0);
  });

  test("is refused for any version but the one offered, and for one not newer than running", async () => {
    const h = harness();
    await expect(
      h.owner(APPLY, { version: "0.3.1", password: "owner-pw" }),
    ).rejects.toThrow("Only the offered version 0.3.0");
    await expect(
      h.owner(APPLY, { version: "0.2.0", password: "owner-pw" }),
    ).rejects.toThrow("Only the offered version 0.3.0");
    await expect(
      h.owner(APPLY, { version: "0.3.0.1", password: "owner-pw" }),
    ).rejects.toThrow("version must look like 0.3.1");
    expect(h.installs).toHaveLength(0);

    const same = harness({ current: "0.3.0" });
    await expect(
      same.owner(APPLY, { version: "0.3.0", password: "owner-pw" }),
    ).rejects.toThrow("not newer than the running 0.3.0");
    expect(same.installs).toHaveLength(0);
  });

  test("is refused when the signature of that version does not verify", async () => {
    const h = harness({ files: publish("0.3.0", stranger) });
    await expect(
      h.owner(APPLY, { version: "0.3.0", password: "owner-pw" }),
    ).rejects.toThrow("does not verify. Nothing was installed.");
    const unknown = harness({ networkDownFor: "manifest.json" });
    await expect(
      unknown.owner(APPLY, { version: "0.3.0", password: "owner-pw" }),
    ).rejects.toThrow("could not be checked right now");
    expect(h.installs).toHaveLength(0);
    expect(unknown.installs).toHaveLength(0);
  });

  test("is refused when the install is not one the panel may update", async () => {
    const h = harness({ facts: { ...windows, bundled: false } });
    await expect(
      h.owner(APPLY, { version: "0.3.0", password: "owner-pw" }),
    ).rejects.toThrow("source checkout");
    expect(h.installs).toHaveLength(0);
    expect(h.events).toHaveLength(0);
  });

  test("the happy path stages the verified version through the injected installer and audits it", async () => {
    const h = harness();
    const result = await h.owner(APPLY, {
      version: "v0.3.0",
      password: "owner-pw",
    });
    expect(result).toEqual({
      state: "staged",
      version: "0.3.0",
      next: "Restart homectl to run 0.3.0.",
    });
    expect(h.installs).toEqual([
      {
        version: "0.3.0",
        trust: { keys: [trusted.publicKey] },
        current: "0.2.0",
      },
    ]);
    expect(h.events).toEqual([
      {
        type: "device.updated",
        subject: "homectl",
        audience: ["owner"],
        data: { from: "0.2.0", to: "0.3.0", state: "staged" },
      },
    ]);
  });

  test("an installer failure is audited as failed and passed on", async () => {
    const h = harness({
      install: async () => {
        throw new HomectlError(5, "The archive could not be unpacked.");
      },
    });
    await expect(
      h.owner(APPLY, { version: "0.3.0", password: "owner-pw" }),
    ).rejects.toThrow("could not be unpacked");
    expect(h.events).toEqual([
      {
        type: "device.updated",
        subject: "homectl",
        audience: ["owner"],
        data: { from: "0.2.0", to: "0.3.0", state: "failed" },
      },
    ]);
  });
});

describe("signature and install checks", () => {
  test("checkSignature reads only the named version's files", async () => {
    const seen: string[] = [];
    const files = publish("0.3.0", trusted);
    const state = await checkSignature("0.3.0", {
      fetch: async (url) => {
        seen.push(url);
        const bytes = files.get(url);
        return bytes
          ? new Response(bytes.slice())
          : new Response("", { status: 404 });
      },
      trust: { keys: [trusted.publicKey] },
    });
    expect(state).toBe("verified");
    expect(seen).toEqual([
      `${RELEASES}/v0.3.0/manifest.json`,
      `${RELEASES}/v0.3.0/manifest.json.sig`,
    ]);
  });

  test("a build with no signing key cannot verify anything", async () => {
    expect(
      await checkSignature("0.3.0", {
        fetch: async () => new Response("x"),
        trust: { keys: [] },
      }),
    ).toBe("unverified");
  });

  test("the install facts give one clear reason, or none", () => {
    expect(blockedReason(windows)).toBeUndefined();
    expect(
      isPackageManagerPath(
        "C:\\Users\\tester\\AppData\\Local\\Microsoft\\WinGet\\Packages\\home-ctl.exe",
      ),
    ).toBe(true);
    expect(isPackageManagerPath("/opt/homebrew/bin/home-ctl")).toBe(true);
    expect(
      isPackageManagerPath(
        "C:\\Users\\tester\\Programs\\homectl\\home-ctl.exe",
      ),
    ).toBe(false);
  });
});
