// Owner grant lifecycle through the broker (homelab #21 C2/C3): preview the
// inventory's literal sudo rule, apply exactly what was reviewed, refuse
// anything that moved since, and revoke only homectl-managed drop-ins. The
// remote is an in-memory host behind the real strict-SSH command builder.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  HostPermissionRoutes,
  ownerHostCommand,
} from "../src/broker/host-permissions";
import { renderDropIn } from "../src/hostperm";
import { HomectlError, type Machine, type Runner } from "../src/types";
import {
  FakeHost,
  unquoteSshCommand,
  writeTargets,
} from "./hostperm-fake-remote";

const host = "lab";
const DROP_IN = "/etc/sudoers.d/homectl-oskar";
const RULE = ["/usr/bin/systemctl", "restart", "fixture.service"];
let dir: string;
let remote: FakeHost;
let machine: Machine;
let audit: { subject: string; audience: string[]; data: unknown }[];

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "hc-host-grants-"));
  await writeFile(
    join(dir, "known_hosts"),
    "[192.0.2.10]:2222 ssh-ed25519 YQ==\n",
  );
  remote = new FakeHost();
  audit = [];
  machine = {
    description: "Synthetic host",
    transport: "ssh",
    access: "observe",
    address: "192.0.2.10",
    user: "oskar",
    port: 2222,
    sudo_allow: [RULE],
    auth: {
      type: "keepassxc",
      entry: "lab",
      socket: "/broker/agent",
      public_key: "/broker/lab.pub",
    },
  };
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function routes() {
  const runner: Runner = async (spec) => {
    expect(spec.argv).toContain("StrictHostKeyChecking=yes");
    return remote.exec(unquoteSshCommand(spec.argv.at(-1) ?? ""), {
      ...(spec.stdin === undefined ? {} : { stdin: spec.stdin }),
    });
  };
  return new HostPermissionRoutes(
    {
      machine: async (id) => (id === host ? machine : undefined),
      hosts: async () => [host],
    },
    join(dir, "inventory.yaml"),
    dir,
    () => undefined,
    runner,
    {
      emit: async (type, subject, audience, data) => {
        expect(type).toBe("device.updated");
        audit.push({ subject, audience, data });
      },
    },
  );
}

const stepUp = async (password: unknown) => {
  if (password !== "fixture") throw new HomectlError(3, "Wrong owner password");
};
interface RouteResult {
  grant: {
    path: string;
    changed: boolean;
    foreign: boolean;
    diff?: string;
    fingerprint: string;
  };
  apply: { status: string };
  revoke: { status: string };
  repair: {
    path: string;
    changed: boolean;
    diff?: string;
    fingerprint?: string;
    status?: string;
    reason?: string;
  };
}
const call = (path: string, extra: Record<string, unknown> = {}) =>
  routes().owner(
    `/v1/owner/hosts/${path}`,
    { host, password: "fixture", ...extra },
    stepUp,
  ) as Promise<RouteResult>;
const writes = () => remote.log.flatMap((entry) => writeTargets(entry.argv));

test("applies exactly the reviewed grant and then reports it unchanged", async () => {
  const preview = await call("preview-grant");
  expect(preview.grant).toMatchObject({ path: DROP_IN, changed: true });
  expect(writes()).toEqual([]);

  const applied = await call("apply-grant", {
    fingerprint: preview.grant.fingerprint,
  });
  expect(applied.apply.status).toBe("applied");
  expect(remote.text(DROP_IN)).toContain(
    "/usr/bin/systemctl restart fixture.service",
  );
  // Every write stayed inside the homectl drop-in and its dot siblings.
  expect(
    writes().every((path) => /^\/etc\/sudoers\.d\/\.?homectl-oskar/.test(path)),
  ).toBe(true);

  const again = await call("preview-grant");
  expect(again.grant.changed).toBe(false);
});

test("refuses a missing, stale or drifted review before writing", async () => {
  await expect(call("apply-grant")).rejects.toThrow("fingerprint is required");
  const preview = await call("preview-grant");
  // The inventory rule widened after review.
  machine.sudo_allow = [
    RULE,
    ["/usr/bin/systemctl", "stop", "fixture.service"],
  ];
  await expect(
    call("apply-grant", { fingerprint: preview.grant.fingerprint }),
  ).rejects.toThrow("changed since it was reviewed");
  // The live file changed after review.
  machine.sudo_allow = [RULE];
  const fresh = await call("preview-grant");
  remote.put(DROP_IN, "# someone else\n", { mode: "0440" });
  await expect(
    call("apply-grant", { fingerprint: fresh.grant.fingerprint }),
  ).rejects.toThrow("changed since it was reviewed");
  expect(writes()).toEqual([]);
  expect(remote.text(DROP_IN)).toBe("# someone else\n");
});

test("never overwrites or removes a drop-in homectl does not own", async () => {
  remote.put(DROP_IN, "oskar ALL=(ALL) NOPASSWD: ALL\n", { mode: "0440" });
  const preview = await call("preview-grant");
  expect(preview.grant).toMatchObject({ foreign: true });
  expect(preview.grant.diff).toBeUndefined();
  const applied = await call("apply-grant", {
    fingerprint: preview.grant.fingerprint,
  });
  expect(applied.apply.status).toBe("refused");
  const revoked = await call("revoke-grant");
  expect(revoked.revoke.status).toBe("refused");
  expect(writes()).toEqual([]);
  expect(remote.text(DROP_IN)).toBe("oskar ALL=(ALL) NOPASSWD: ALL\n");
});

test("revoke removes the managed drop-in and is idempotent", async () => {
  const preview = await call("preview-grant");
  await call("apply-grant", { fingerprint: preview.grant.fingerprint });
  const revoked = await call("revoke-grant");
  expect(revoked.revoke.status).toBe("removed");
  expect(remote.text(DROP_IN)).toBeUndefined();
  expect((await call("revoke-grant")).revoke.status).toBe("absent");
  // Owner-only audit entries, one per write attempt.
  expect(
    audit.map((a) => [
      a.subject,
      a.audience,
      (a.data as { action: string; status: string }).status,
    ]),
  ).toEqual([
    [host, [], "applied"],
    [host, [], "removed"],
    [host, [], "absent"],
  ]);
});

// The inventory grant as the broker renders it, and a drifted homectl file.
const DESIRED = renderDropIn(
  "oskar",
  { kind: "allow", argv: [RULE] },
  "inventory-grant",
);
const DRIFTED = renderDropIn(
  "oskar",
  { kind: "allow", argv: [["/usr/bin/systemctl", "stop", "fixture.service"]] },
  "inventory-grant",
);
const MANAGED_ONLY = /^\/etc\/sudoers\.d\/\.?homectl-oskar/;

test("repair previews a drifted homectl drop-in with a fingerprint and writes nothing", async () => {
  remote.put(DROP_IN, DRIFTED, { mode: "0440" });
  const preview = await call("repair-grant");
  expect(preview.repair).toMatchObject({ path: DROP_IN, changed: true });
  expect(preview.repair.diff).toContain("fixture.service");
  expect(preview.repair.fingerprint).toMatch(/^[0-9a-f]{64}$/);
  expect(writes()).toEqual([]);
  expect(remote.text(DROP_IN)).toBe(DRIFTED);
});

test("repair applies only the reviewed fingerprint and restores the inventory grant", async () => {
  remote.put(DROP_IN, DRIFTED, { mode: "0440" });
  const preview = await call("repair-grant");
  const repaired = await call("repair-grant", {
    fingerprint: preview.repair.fingerprint,
  });
  expect(repaired.repair.status).toBe("applied");
  expect(remote.text(DROP_IN)).toBe(DESIRED);
  expect(writes().every((path) => MANAGED_ONLY.test(path))).toBe(true);
  const again = await call("repair-grant");
  expect(again.repair.changed).toBe(false);
});

test("repair never creates a missing drop-in and never touches a foreign file", async () => {
  await expect(call("repair-grant")).rejects.toThrow(
    "no homectl drop-in to repair",
  );
  const foreign = "oskar ALL=(ALL) NOPASSWD: ALL\n";
  remote.put(DROP_IN, foreign, { mode: "0440" });
  await expect(
    call("repair-grant", { fingerprint: "a".repeat(64) }),
  ).rejects.toThrow("it is not touched");
  expect(writes()).toEqual([]);
  expect(remote.text(DROP_IN)).toBe(foreign);
});

test("an apply review cannot approve a repair, and a repair review cannot approve an apply", async () => {
  remote.put(DROP_IN, DRIFTED, { mode: "0440" });
  const applyReview = await call("preview-grant");
  const repairReview = await call("repair-grant");
  await expect(
    call("repair-grant", { fingerprint: applyReview.grant.fingerprint }),
  ).rejects.toThrow("changed since it was reviewed");
  await expect(
    call("apply-grant", { fingerprint: repairReview.repair.fingerprint }),
  ).rejects.toThrow("changed since it was reviewed");
  expect(writes()).toEqual([]);
  expect(remote.text(DROP_IN)).toBe(DRIFTED);
});

test("a repair whose visudo check fails rolls back to the drifted content", async () => {
  remote.put(DROP_IN, DRIFTED, { mode: "0440" });
  const preview = await call("repair-grant");
  // Fail only the whole-configuration check; the rollback's check passes.
  let tripped = false;
  remote.failIf = (argv) => {
    if (tripped || !argv.includes("visudo") || !argv.includes("-c"))
      return false;
    tripped = true;
    return true;
  };
  const repaired = await call("repair-grant", {
    fingerprint: preview.repair.fingerprint,
  });
  expect(repaired.repair.status).toBe("rolled-back");
  expect(remote.text(DROP_IN)).toBe(DRIFTED);
});

test("owner access is unchanged after a grant and after a revoke", async () => {
  const keys = "/home/oskar/.ssh/authorized_keys";
  const mainSudoers = "/etc/sudoers";
  remote.put(keys, "ssh-ed25519 AAAAowner owner@lab\n", {
    mode: "0600",
    owner: "oskar",
    group: "oskar",
  });
  const beforeKeys = structuredClone(remote.files.get(keys));
  const beforeSudoers = structuredClone(remote.files.get(mainSudoers));

  const preview = await call("preview-grant");
  expect(
    (await call("apply-grant", { fingerprint: preview.grant.fingerprint }))
      .apply.status,
  ).toBe("applied");
  expect(remote.files.get(keys)).toEqual(beforeKeys);
  expect(remote.files.get(mainSudoers)).toEqual(beforeSudoers);

  expect((await call("revoke-grant")).revoke.status).toBe("removed");
  expect(remote.files.get(keys)).toEqual(beforeKeys);
  expect(remote.files.get(mainSudoers)).toEqual(beforeSudoers);
  expect(writes().some((path) => path === keys || path === mainSudoers)).toBe(
    false,
  );
});

test("owner repair-host-grant previews without a fingerprint and applies with one", () => {
  expect(ownerHostCommand(["repair-host-grant", host])).toEqual({
    route: "/v1/owner/hosts/repair-grant",
    body: { host },
  });
  const fp = "b".repeat(64);
  expect(ownerHostCommand(["repair-host-grant", host, fp])).toEqual({
    route: "/v1/owner/hosts/repair-grant",
    body: { host, fingerprint: fp },
  });
  expect(ownerHostCommand(["repair-host-grant"])).toBeUndefined();
  expect(
    ownerHostCommand(["repair-host-grant", host, fp, "extra"]),
  ).toBeUndefined();
});
