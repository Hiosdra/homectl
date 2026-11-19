import { mkdtemp, readFile, rm, rmdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { detectPlatform } from "../hostperm";
import { collectHostKeys } from "../peer/hostkeys";
import { run } from "../process";
import { trustedHostProbeSpec } from "../transports";
import { HomectlError, type Runner } from "../types";
import type { RouteExtension } from "./server";
import type { InventoryPort } from "./types";

export class HostPermissionRoutes implements RouteExtension {
  constructor(
    private readonly inventory: InventoryPort,
    private readonly inventoryPath: string,
    private readonly stateDirectory: string,
    private readonly gate: () => string | undefined,
    private readonly runner: Runner = run,
  ) {}

  async owner(
    path: string,
    input: Record<string, unknown>,
    stepUp: (password: unknown) => Promise<void>,
  ): Promise<unknown> {
    if (path !== "/v1/owner/hosts/inspect") return undefined;
    const host = input.host;
    if (
      typeof host !== "string" ||
      !/^[A-Za-z0-9][A-Za-z0-9._-]{0,62}$/.test(host)
    )
      throw new HomectlError(2, "A valid inventory host is required");
    await stepUp(input.password);
    const machine = await this.inventory.machine(host);
    if (!machine || !(await this.inventory.hosts()).includes(host))
      throw new HomectlError(3, "Host is not in the broker inventory");
    const knownHosts = join(dirname(this.inventoryPath), "known_hosts");
    const stored = await readFile(knownHosts, "utf8").catch(() => "");
    const pinned = Object.values(
      collectHostKeys(stored, { host: { ...machine, ssh_alias: undefined } }),
    );
    if (pinned.length === 0)
      throw new HomectlError(
        3,
        "Confirm and pin the inventory address's SSH host key before inspecting",
      );
    const revocations = stored
      .split("\n")
      .filter((line) => /^\s*@revoked\s/.test(line));
    const work = await mkdtemp(join(this.stateDirectory, "host-probe-"));
    const pins = join(work, "known_hosts");
    try {
      await writeFile(pins, [...pinned, ...revocations, ""].join("\n"), {
        flag: "wx",
        mode: 0o600,
      });
      const deadline = Date.now() + 45_000;
      const platform = await detectPlatform(async (argv) => {
        const unavailable = this.gate();
        if (unavailable) throw new HomectlError(3, unavailable);
        const remaining = deadline - Date.now();
        if (remaining <= 0)
          throw new HomectlError(5, "Host inspection timed out");
        const spec = trustedHostProbeSpec(machine, argv, pins);
        const result = await this.runner({
          ...spec,
          timeoutMs: Math.min(10_000, remaining),
        });
        if (result.exitCode < 0 || result.exitCode > 128)
          throw new HomectlError(
            5,
            "SSH inspection failed. Check the pinned host key, broker credential and network.",
          );
        return result;
      });
      return { host, platform };
    } finally {
      await rm(pins, { force: true });
      await rmdir(work);
    }
  }
}
