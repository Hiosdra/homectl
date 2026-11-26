import { mkdtemp, readFile, rm, rmdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fingerprint } from "../control/canonical";
import {
  applyGrant,
  type DropInPlan,
  detectPlatform,
  planGrant,
  type RemoteExec,
  renderDropIn,
  revokeGrant,
} from "../hostperm";
import { collectHostKeys } from "../peer/hostkeys";
import { run } from "../process";
import { trustedHostProbeSpec } from "../transports";
import { HomectlError, type Runner } from "../types";
import type { RouteExtension } from "./server";
import type { EventsPort, InventoryPort } from "./types";

type HostAction = "inspect" | "preview" | "apply" | "revoke" | "repair";
const ACTIONS: Record<string, HostAction | undefined> = {
  "/v1/owner/hosts/inspect": "inspect",
  "/v1/owner/hosts/preview-grant": "preview",
  "/v1/owner/hosts/apply-grant": "apply",
  "/v1/owner/hosts/revoke-grant": "revoke",
  "/v1/owner/hosts/repair-grant": "repair",
};

export class HostPermissionRoutes implements RouteExtension {
  constructor(
    private readonly inventory: InventoryPort,
    private readonly inventoryPath: string,
    private readonly stateDirectory: string,
    private readonly gate: () => string | undefined,
    private readonly runner: Runner = run,
    private readonly events?: EventsPort,
  ) {}

  // Owner-only audit trail for every grant write attempt, whatever its outcome.
  private async audit(
    host: string,
    action: "apply-grant" | "revoke-grant" | "repair-grant",
    report: { status: string; path: string; reason: string },
  ) {
    await this.events?.emit("device.updated", host, [], {
      action,
      status: report.status,
      path: report.path,
      reason: report.reason,
    });
  }

  async owner(
    path: string,
    input: Record<string, unknown>,
    stepUp: (password: unknown) => Promise<void>,
  ): Promise<unknown> {
    const action = ACTIONS[path];
    if (!action) return undefined;
    const preview =
      action === "preview" || action === "apply" || action === "repair";
    const host = input.host;
    if (
      typeof host !== "string" ||
      !/^[A-Za-z0-9][A-Za-z0-9._-]{0,62}$/.test(host)
    )
      throw new HomectlError(2, "A valid inventory host is required");
    await stepUp(input.password);
    const reviewed = input.fingerprint;
    // Repair previews without a fingerprint; a fingerprint means apply.
    const applying =
      action === "apply" || (action === "repair" && reviewed !== undefined);
    if (
      applying &&
      (typeof reviewed !== "string" || !/^[0-9a-f]{64}$/.test(reviewed))
    )
      throw new HomectlError(2, "The reviewed grant fingerprint is required");
    const machine = await this.inventory.machine(host);
    if (!machine || !(await this.inventory.hosts()).includes(host))
      throw new HomectlError(3, "Host is not in the broker inventory");
    const desired = preview
      ? this.desiredGrant(machine.user, machine.sudo_allow)
      : undefined;
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
      // Writes get more time: backup, install, visudo and verification.
      const deadline =
        Date.now() +
        (action === "inspect" || action === "preview" ? 45_000 : 120_000);
      // File contents (sudoers drop-ins) travel only on stdin.
      const exec = async (argv: string[], opts?: { stdin?: string }) => {
        const unavailable = this.gate();
        if (unavailable) throw new HomectlError(3, unavailable);
        const remaining = deadline - Date.now();
        if (remaining <= 0)
          throw new HomectlError(5, "Host inspection timed out");
        const spec = trustedHostProbeSpec(machine, argv, pins);
        const result = await this.runner({
          ...spec,
          ...(opts?.stdin === undefined ? {} : { stdin: opts.stdin }),
          timeoutMs: Math.min(10_000, remaining),
        });
        if (result.exitCode < 0 || result.exitCode > 128)
          throw new HomectlError(
            5,
            "SSH inspection failed. Check the pinned host key, broker credential and network.",
          );
        return result;
      };
      const platform = await detectPlatform(exec);
      if (action === "revoke") {
        if (!machine.user || !platform.supports.dropIns)
          throw new HomectlError(3, "The host has no revocable homectl grant");
        const revoke = await revokeGrant(exec, machine.user);
        await this.audit(host, "revoke-grant", revoke);
        return { host, revoke };
      }
      if (desired === undefined) return { host, platform };
      if (!platform.supports.dropIns)
        throw new HomectlError(
          3,
          "The host platform does not support sudoers drop-ins",
        );
      const plan = await planGrant(exec, desired.user, desired.content, {
        os: platform.os,
      });
      // A repair review carries its own marker, so an apply review cannot
      // approve a repair (and the other way round).
      const planned = fingerprint({
        host,
        address: machine.address ?? "",
        port: machine.port ?? 22,
        pins: pinned,
        revocations,
        path: plan.path,
        current: plan.current ?? null,
        desired: plan.desired,
        ...(action === "repair" ? { operation: "repair" } : {}),
      });
      // `await` keeps the finally block below from running before the repair.
      if (action === "repair")
        return await this.repair(host, plan, planned, reviewed, exec);
      if (action === "apply") {
        // The owner approved exactly what they reviewed. Anything that moved
        // since (inventory rule, live file, pins, address) needs a new review.
        if (planned !== reviewed)
          throw new HomectlError(
            3,
            "The grant changed since it was reviewed; preview it again",
          );
        const apply = await applyGrant(exec, plan, {
          ...(plan.current === undefined
            ? {}
            : { expectedCurrent: plan.current }),
        });
        await this.audit(host, "apply-grant", apply);
        return { host, apply };
      }
      return {
        host,
        platform,
        grant: {
          path: plan.path,
          changed: plan.changed,
          foreign: plan.foreign,
          ...(plan.foreign ? {} : { diff: plan.diff }),
          fingerprint: planned,
        },
      };
    } finally {
      await rm(pins, { force: true });
      await rmdir(work);
    }
  }

  // Restores a homectl-owned drop-in that no longer matches the inventory
  // grant. It never creates a drop-in and never touches a file without the
  // homectl header. Apply goes through applyGrant: visudo validation, an
  // atomic swap, and a rollback to the drifted content if any check fails.
  private async repair(
    host: string,
    plan: DropInPlan,
    planned: string,
    reviewed: unknown,
    exec: RemoteExec,
  ): Promise<unknown> {
    if (plan.foreign)
      throw new HomectlError(
        3,
        "The drop-in has no homectl header; it is not touched",
      );
    if (plan.current === undefined)
      throw new HomectlError(
        3,
        "There is no homectl drop-in to repair; apply the grant instead",
      );
    if (reviewed === undefined)
      return {
        host,
        repair: {
          path: plan.path,
          changed: plan.changed,
          ...(plan.changed ? { diff: plan.diff, fingerprint: planned } : {}),
        },
      };
    if (planned !== reviewed)
      throw new HomectlError(
        3,
        "The drop-in changed since it was reviewed; preview the repair again",
      );
    const repair = await applyGrant(exec, plan, {
      expectedCurrent: plan.current,
    });
    await this.audit(host, "repair-grant", repair);
    return { host, repair };
  }

  private desiredGrant(user: string | undefined, argv: string[][] | undefined) {
    if (!user || !argv?.length)
      throw new HomectlError(
        3,
        "The inventory host has no literal sudo grants to preview",
      );
    return {
      user,
      content: renderDropIn(user, { kind: "allow", argv }, "inventory-grant"),
    };
  }
}

// `home-ctl owner <command> <host> [fingerprint]` → owner route and body.
// The fingerprint is the reviewed grant or the out-of-band verified host key.
const OWNER_HOST_ROUTES: Record<string, string | undefined> = {
  "scan-host-keys": "/v1/owner/hosts/scan-keys",
  "pin-host-key": "/v1/owner/hosts/pin-key",
  "inspect-host": "/v1/owner/hosts/inspect",
  "preview-host-grant": "/v1/owner/hosts/preview-grant",
  "apply-host-grant": "/v1/owner/hosts/apply-grant",
  "revoke-host-grant": "/v1/owner/hosts/revoke-grant",
  "repair-host-grant": "/v1/owner/hosts/repair-grant",
};

export function ownerHostCommand(positionals: string[]) {
  const [action, host, fingerprint] = positionals;
  const route = action ? OWNER_HOST_ROUTES[action] : undefined;
  // repair-host-grant <host> previews; with a fingerprint it applies.
  const arities =
    action === "repair-host-grant"
      ? [2, 3]
      : [action === "apply-host-grant" || action === "pin-host-key" ? 3 : 2];
  if (!route || !host || !arities.includes(positionals.length))
    return undefined;
  return { route, body: { host, ...(fingerprint ? { fingerprint } : {}) } };
}
