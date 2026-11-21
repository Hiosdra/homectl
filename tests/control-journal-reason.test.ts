import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AuditJournal, verifyChain } from "../src/control/journal";
import { auditReason } from "../src/control/reason";
import type { AuditEvent } from "../src/control/types";

// Regression: a rejected execute wrote its full error text as the audit reason.
// Some messages are longer than the schema allows (120 characters), so the entry
// failed verification and every later append was refused. Approvals then failed.

const LONG =
  "This Proxmox operation is owner-only: no client can approve it, so it will not run. Make the change in the Proxmox interface instead";

async function withJournal(run: (journal: AuditJournal) => Promise<void>) {
  const dir = await mkdtemp(join(tmpdir(), "homectl-journal-"));
  try {
    await run(
      new AuditJournal(join(dir, "audit.jsonl"), join(dir, "audit.anchor")),
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

describe("journal reasons", () => {
  test("the root cause: an over-long reason fails the chain check", async () => {
    await withJournal(async (journal) => {
      await journal.append({
        event: "request.accepted",
        client: "local",
        op: "plan",
      } as AuditEvent);
      // Written without the guard, as the engine used to write it.
      const entries = await journal.read();
      const fake = {
        event: "request.rejected",
        client: "codex",
        op: "execute",
        reason: LONG,
      } as AuditEvent;
      expect(entries.length).toBe(1);
      const chain = verifyChain([
        ...entries,
        {
          v: 1,
          seq: 2,
          at: "2026-11-21T00:00:00.000Z",
          prev: entries[0]?.hash ?? "",
          event: fake,
          hash: "0".repeat(64),
        },
      ]);
      expect(chain.ok).toBe(false);
      expect(chain.error).toContain("schema violation");
    });
  });

  test("a rejected execute with a long message keeps later approvals working", async () => {
    await withJournal(async (journal) => {
      await journal.append({
        event: "request.rejected",
        client: "codex",
        op: "execute",
        reason: auditReason(LONG),
      } as AuditEvent);
      await journal.append({
        event: "request.accepted",
        client: "local",
        op: "plan",
      } as AuditEvent);
      expect((await journal.verify()).ok).toBe(true);
    });
  });

  test("auditReason keeps short text and shortens long text within the schema limit", () => {
    expect(auditReason("Operation is not awaiting approval")).toBe(
      "Operation is not awaiting approval",
    );
    const long = auditReason(LONG);
    expect(long.length).toBeLessThanOrEqual(120);
    expect(long.startsWith("This Proxmox operation is owner-only")).toBe(true);
    expect(long.endsWith("...")).toBe(true);
  });

  test("the journal refuses to write an entry that would break verification", async () => {
    await withJournal(async (journal) => {
      await journal.append({
        event: "request.accepted",
        client: "local",
        op: "plan",
      } as AuditEvent);
      // An unknown field is a schema violation the verifier would reject later.
      await expect(
        journal.append({
          event: "request.rejected",
          client: "codex",
          bogusField: "x",
        } as AuditEvent),
      ).rejects.toThrow("does not match the journal schema");
      // Nothing was written: the chain still verifies and later appends work.
      expect((await journal.verify()).ok).toBe(true);
      await journal.append({
        event: "request.accepted",
        client: "local",
        op: "plan",
      } as AuditEvent);
      expect((await journal.verify()).ok).toBe(true);
    });
  });
});
