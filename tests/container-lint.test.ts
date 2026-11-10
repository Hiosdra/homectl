// Lint-style checks for the container files. The image is not built on the
// development machine (no Docker daemon), so these tests are the gate: they
// read the Dockerfile, .dockerignore and the example compose file as text.
import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { parse } from "yaml";

const REPO = resolve(import.meta.dir, "..");
const read = (...parts: string[]) => readFile(join(REPO, ...parts), "utf8");

type Compose = {
  services: Record<string, Record<string, unknown>>;
  networks?: Record<string, unknown>;
};

function instructions(dockerfile: string): { op: string; rest: string }[] {
  // Join backslash-continued lines first, so one instruction is one entry.
  const joined = dockerfile.replace(/\\\n/g, " ");
  return joined
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"))
    .map((line) => {
      const [op = "", ...rest] = line.split(/\s+/);
      return { op: op.toUpperCase(), rest: rest.join(" ") };
    });
}

describe("Dockerfile", () => {
  test("the base image comes from a required build argument with no default", async () => {
    const text = await read("Dockerfile");
    const args = instructions(text).filter((i) => i.op === "ARG");
    expect(args.map((a) => a.rest)).toContain("BUN_IMAGE");
    expect(args.some((a) => a.rest.includes("="))).toBe(false);
    const from = instructions(text).filter((i) => i.op === "FROM");
    expect(from.map((f) => f.rest)).toEqual(["$" + "{BUN_IMAGE}"]);
  });

  test("the final user is numeric and not root", async () => {
    const users = instructions(await read("Dockerfile")).filter(
      (i) => i.op === "USER",
    );
    const last = users.at(-1)?.rest ?? "";
    expect(last).toMatch(/^\d+:\d+$/);
    expect(last.split(":")[0]).not.toBe("0");
    expect(users.some((u) => /^(root|0)(:|$)/.test(u.rest))).toBe(false);
  });

  test("no privileged mode, no Docker socket, no anonymous volume", async () => {
    const text = await read("Dockerfile");
    expect(text).not.toContain("--privileged");
    expect(text).not.toContain("docker.sock");
    expect(instructions(text).some((i) => i.op === "VOLUME")).toBe(false);
  });

  test("the healthcheck is the local status-only script and the entrypoint is the CLI", async () => {
    const text = await read("Dockerfile");
    const health = instructions(text).find((i) => i.op === "HEALTHCHECK");
    expect(health?.rest).toContain("/app/src/container/health.ts");
    expect(text).toMatch(
      /^ENTRYPOINT \["bun", "\/app\/src\/cli\/main\.ts"\]$/m,
    );
  });

  test("no secret material in ENV or ARG defaults", async () => {
    const text = await read("Dockerfile");
    const envLines = instructions(text).filter((i) => i.op === "ENV");
    for (const line of envLines)
      expect(line.rest).not.toMatch(/PASS|SECRET|TOKEN|KDBX|KEY/i);
  });
});

describe("example compose file", () => {
  test("no privileged mode, no host network, no Docker socket mount", async () => {
    const text = await read("examples", "container", "compose.example.yaml");
    const compose = parse(text) as Compose;
    const service = compose.services.homectl ?? {};
    expect(service.privileged).not.toBe(true);
    expect(service.network_mode).toBeUndefined();
    expect(text).not.toContain("docker.sock");
  });

  test("read-only root filesystem, all capabilities dropped, no new privileges", async () => {
    const compose = parse(
      await read("examples", "container", "compose.example.yaml"),
    ) as Compose;
    const service = compose.services.homectl ?? {};
    expect(service.read_only).toBe(true);
    expect(service.cap_drop).toEqual(["ALL"]);
    expect(service.security_opt).toContain("no-new-privileges:true");
  });

  test("runs as a numeric non-root user", async () => {
    const compose = parse(
      await read("examples", "container", "compose.example.yaml"),
    ) as Compose;
    const user = String(compose.services.homectl?.user ?? "");
    expect(user).toMatch(/^\d+:\d+$/);
    expect(user.split(":")[0]).not.toBe("0");
  });

  test("only the peer port is published, and only on an explicit address", async () => {
    const compose = parse(
      await read("examples", "container", "compose.example.yaml"),
    ) as Compose;
    const ports = (compose.services.homectl?.ports ?? []) as string[];
    expect(ports.length).toBe(1);
    // A required variable for the LAN address, then 7448 to 7448.
    expect(ports[0]).toMatch(/^\$\{HOMECTL_LAN_IP:\?[^}]+\}:7448:7448$/);
    expect(ports.join(" ")).not.toContain("7447");
    expect(ports.join(" ")).not.toContain("0.0.0.0");
  });

  test("the writable path is the single /data volume, with a tmpfs /tmp", async () => {
    const compose = parse(
      await read("examples", "container", "compose.example.yaml"),
    ) as Compose;
    const service = compose.services.homectl ?? {};
    const volumes = (service.volumes ?? []) as string[];
    expect(volumes.length).toBe(1);
    expect(volumes[0]?.endsWith(":/data")).toBe(true);
    expect(service.tmpfs).toEqual(["/tmp:size=64m,mode=1777"]);
  });

  test("resource limits, restart policy and the health probe are set", async () => {
    const compose = parse(
      await read("examples", "container", "compose.example.yaml"),
    ) as Compose;
    const service = compose.services.homectl ?? {};
    expect(service.mem_limit).toBeDefined();
    expect(service.cpus).toBeDefined();
    expect(service.pids_limit).toBeDefined();
    expect(service.restart).toBe("unless-stopped");
    expect(service.stop_grace_period).toBe("20s");
    expect(service.healthcheck).toBeDefined();
  });

  test("no secrets in the environment, and the panel never receives a password", async () => {
    const text = await read("examples", "container", "compose.example.yaml");
    const compose = parse(text) as Compose;
    const service = compose.services.homectl ?? {};
    expect(service.environment).toBeUndefined();
    expect(text).not.toMatch(/PASSWORD|SECRET|TOKEN|KDBX_PASS/i);
  });

  test("the base digest is a placeholder to replace, not a tag", async () => {
    const compose = parse(
      await read("examples", "container", "compose.example.yaml"),
    ) as Compose;
    const build = compose.services.homectl?.build as {
      args: Record<string, string>;
    };
    expect(build.args.BUN_IMAGE).toContain("@sha256:");
  });
});

describe("prebuilt Compose Project example", () => {
  async function project() {
    return parse(
      await read("examples", "container", "compose.project.yaml"),
    ) as Compose & { name: string; secrets: Record<string, unknown> };
  }

  test("is a named project using the prebuilt local image", async () => {
    const compose = await project();
    const service = compose.services.homectl ?? {};
    expect(compose.name).toBe("homectl-pr6");
    expect(service.image).toBe(`\${HOMECTL_IMAGE:-homectl-peer:pr6}`);
    expect(service.build).toBeUndefined();
    expect(service.container_name).toBe("homectl");
  });

  test("retains container restrictions and the existing data volume", async () => {
    const compose = await project();
    const service = compose.services.homectl ?? {};
    expect(service.user).toBe("10001:10001");
    expect(service.privileged).toBe(false);
    expect(service.read_only).toBe(true);
    expect(service.cap_drop).toEqual(["ALL"]);
    expect(service.security_opt).toContain("no-new-privileges:true");
    expect(service.volumes).toEqual(["/volume2/appdata/homectl:/data"]);
    expect(service.tmpfs).toEqual(["/tmp:size=64m,mode=1777"]);
  });

  test("publishes the peer on an explicit LAN IP and panel on a configurable bind", async () => {
    const compose = await project();
    const ports = (compose.services.homectl?.ports ?? []) as string[];
    expect(ports).toEqual([
      `\${HOMECTL_LAN_IP:?set the NAS LAN IP}:7448:7448`,
      `\${HOMECTL_PANEL_BIND:?set loopback or LAN IP and panel host port}:7447`,
    ]);
  });

  test("mounts the panel token as a Compose secret and uses the exact origin", async () => {
    const compose = await project();
    const service = compose.services.homectl ?? {};
    const command = service.command as string[];
    expect(service.secrets).toEqual(["panel_token"]);
    expect(command).toContain("--panel-interface");
    expect(command).toContain("172.28.0.10");
    expect(command).toContain("--panel-origin");
    expect(command).toContain(
      `\${HOMECTL_PANEL_ORIGIN:?set the exact browser origin}`,
    );
    expect(command).toContain("--panel-token-file");
    expect(command).toContain("/run/secrets/panel_token");
    expect(compose.secrets.panel_token).toEqual({
      file: `\${HOMECTL_PANEL_TOKEN_FILE:?set the path to a protected token file}`,
    });
    expect(JSON.stringify(compose)).not.toMatch(/PASSWORD=|TOKEN=[A-Za-z0-9]/i);
  });

  test("reuses the existing named external network and is managed by Compose", async () => {
    const compose = await project();
    expect(compose.networks?.lan).toEqual({
      external: true,
      name: `\${HOMECTL_NETWORK_NAME:-homectl-pr6-lan}`,
    });
    expect(compose.services.homectl?.healthcheck).toBeDefined();
    expect(compose.services.homectl?.restart).toBe("unless-stopped");
  });
});

describe(".dockerignore", () => {
  test("excludes git metadata, node_modules, databases, keys and local state", async () => {
    const lines = (await read(".dockerignore"))
      .split("\n")
      .map((line) => line.trim());
    for (const pattern of [
      ".git",
      "**/node_modules",
      "**/*.kdbx",
      "**/*.key",
      "**/.env",
      "**/control-plane",
      "**/serve",
    ])
      expect(lines).toContain(pattern);
  });
});
