// Owner grant lifecycle through the broker (homelab #21 C2/C3): preview the
// inventory's literal sudo rule, apply exactly what was reviewed, refuse
// anything that moved since, and revoke only homectl-managed drop-ins. The
// remote is an in-memory host behind the real strict-SSH command builder.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HostPermissionRoutes } from "../src/broker/host-permissions";
import { HomectlError, type Machine, type Runner } from "../src/types";
import { FakeHost, writeTargets } from "./hostperm-fake-remote";

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

// The SSH spec carries one POSIX-quoted command; turn it back into argv.
function unquote(command: string): string[] {
  const words: string[] = [];
  for (const match of command.matchAll(/'((?:[^']|'\\'')*)'/g))
    words.push((match[1] ?? "").replaceAll("'\\''", "'"));
  return words;
}

function routes() {
  const runner: Runner = async (spec) => {
    expect(spec.argv).toContain("StrictHostKeyChecking=yes");
    return remote.exec(unquote(spec.argv.at(-1) ?? ""), {
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
