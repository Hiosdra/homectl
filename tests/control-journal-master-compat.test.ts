import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Ajv from "ajv";
import { AuditJournal } from "../src/control/journal";
import type { AuditEventName } from "../src/control/types";

const masterEventNames: AuditEventName[] = [
  "auth.rejected",
  "request.accepted",
  "request.rejected",
  "client.created",
  "client.revoked",
  "operation.planned",
  "operation.decided",
  "operation.executing",
  "operation.succeeded",
  "operation.failed",
  "operation.unknown",
  "handoff.offered",
  "handoff.cancelled",
  "handoff.accepted",
  "handoff.resolution-proposed",
  "handoff.resolution-accepted",
  "peer.suspended",
  "peer.resumed",
  "auth.oidc",
  "oidc.configured",
];

test("written control-plane events remain valid under the master audit schema", async () => {
  const dir = await mkdtemp(join(tmpdir(), "homectl-master-audit-schema-"));
  try {
    const fixture = JSON.parse(
      await readFile(
        join(import.meta.dir, "fixtures", "master-audit-event.schema.json"),
        "utf8",
      ),
    );
    const ajv = new Ajv({ allErrors: true, strict: false });
    ajv.addSchema(fixture, "master-control-plane");
    const validate = ajv.getSchema(
      "master-control-plane#/definitions/auditEvent",
    );
    expect(validate).toBeDefined();

    const journal = new AuditJournal(
      join(dir, "audit.jsonl"),
      join(dir, "audit.anchor"),
    );
    for (const event of masterEventNames) await journal.append({ event });

    for (const entry of await journal.read())
      expect(validate?.(entry.event)).toBe(true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
