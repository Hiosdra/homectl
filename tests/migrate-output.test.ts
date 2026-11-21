// Human output for `home-ctl migrate`: the dry-run plan and the result of a run.
// The JSON form is unchanged and is covered by migrate-command.test.ts.
import { expect, test } from "bun:test";
import { formatHuman, formatMigration } from "../src/cli/output";
import type { MigrationResult } from "../src/migrate/types";

const plan: MigrationResult = {
  status: "planned",
  from: 2,
  to: 3,
  steps: [
    {
      id: "v2-retire-pending-authority",
      description: "Close pending and approved operations from 0.2",
      touches: ["control-plane/state.json"],
    },
    {
      id: "v2-report-preserved-and-agent-config",
      description: "List what stayed in place",
      touches: [],
    },
  ],
};

test("a dry run lists each step with the files it may touch", () => {
  const output = formatMigration(plan);
  expect(output).toContain(
    "Dry run: data version 2 would migrate to 3 in 2 step(s). Nothing was changed.",
  );
  expect(output).toContain(
    "1. Close pending and approved operations from 0.2 (v2-retire-pending-authority)",
  );
  expect(output).toContain("   May touch: control-plane/state.json");
  expect(output).toContain("   May touch: nothing");
  expect(output).not.toContain("{");
});

test("a dry run on an empty workspace says there is nothing to migrate", () => {
  const output = formatMigration({
    status: "planned",
    from: 0,
    to: 3,
    steps: [],
  });
  expect(output).toContain("nothing to migrate");
  expect(output).toContain("data version 3");
  expect(output).toContain("Nothing was changed.");
});

test("a finished run names the versions, the backup, the steps and the notes", () => {
  const output = formatMigration({
    status: "migrated",
    from: 2,
    to: 3,
    backup: "/state/backups/migration-v2-1",
    steps: ["v2-retire-pending-authority", "v2-carry-agent-clients"],
    notes: ["1 open operation(s) from 0.2 were closed"],
  });
  expect(output).toContain("Migrated data version 2 to 3.");
  expect(output).toContain("Backup: /state/backups/migration-v2-1");
  expect(output).toContain(
    "Steps: v2-retire-pending-authority, v2-carry-agent-clients",
  );
  expect(output).toContain(
    "Notes:\n• 1 open operation(s) from 0.2 were closed",
  );
});

test("a finished run without notes has no notes heading", () => {
  const output = formatMigration({
    status: "migrated",
    from: 2,
    to: 3,
    backup: "/b",
    steps: [],
    notes: [],
  });
  expect(output).toContain("Steps: none");
  expect(output).not.toContain("Notes:");
});

test("a workspace already at the current version, or a new one, is reported", () => {
  expect(formatMigration({ status: "current", version: 3 })).toBe(
    "Data version 3 is current. Nothing to migrate.",
  );
  expect(formatMigration({ status: "initialized", version: 3 })).toContain(
    "Created an empty workspace at data version 3",
  );
});

test("the migrate command picks this formatter for its results", () => {
  expect(formatHuman(plan, "migrate")).toBe(formatMigration(plan));
  // Other commands keep their own output for a value with a status field.
  expect(formatHuman({ status: "ok" }, "status")).not.toContain("Dry run");
});
