import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { canonicalJson, fingerprint } from "../src/control/canonical";
import { AuditJournal, GENESIS, verifyChain } from "../src/control/journal";
import { containsSecretMaterial, redactArgv } from "../src/control/redact";
import type { AuditEvent } from "../src/control/types";
import { HomectlError } from "../src/types";

async function workspace() {
  const dir = await mkdtemp(join(tmpdir(), "homectl-journal-"));
  return { dir, path: join(dir, "audit.jsonl") };
}

describe("canonical fingerprints", () => {
  test("key order does not change the fingerprint", () => {
    const a = {
      host: "lab",
      argv: ["uname", "-s"],
      machine: { access: "user", user: "op" },
    };
    const b = {
      machine: { user: "op", access: "user" },
      argv: ["uname", "-s"],
      host: "lab",
    };
    expect(canonicalJson(a)).toBe(canonicalJson(b));
    expect(fingerprint(a)).toBe(fingerprint(b));
  });

  test("any change to a bound field changes the fingerprint", () => {
    const base = { host: "lab", argv: ["uname", "-s"], impact: "read" };
    const base_fp = fingerprint(base);
    expect(fingerprint({ ...base, host: "nas" })).not.toBe(base_fp);
    expect(fingerprint({ ...base, argv: ["uname", "-a"] })).not.toBe(base_fp);
    expect(fingerprint({ ...base, impact: "read more" })).not.toBe(base_fp);
    expect(fingerprint({ ...base, argv: ["uname"] })).not.toBe(base_fp);
  });

  test("undefined properties are dropped rather than hashed", () => {
    expect(fingerprint({ a: 1, b: undefined })).toBe(fingerprint({ a: 1 }));
  });
});

describe("argv redaction and secret detection", () => {
  test("redacts secret-looking option values in both forms", () => {
    expect(redactArgv(["tool", "--password", "hunter2", "--x"])).toEqual([
      "tool",
      "--password",
      "[REDACTED]",
      "--x",
    ]);
    expect(redactArgv(["tool", "--token=abc123456"])).toEqual([
      "tool",
      "--token=[REDACTED]",
    ]);
  });

  test("leaves ordinary argv untouched", () => {
    const argv = ["systemctl", "status", "nginx", "--no-pager"];
    expect(redactArgv(argv)).toEqual(argv);
  });

  test("detects PEM keys, assignments, bearer values and client tokens", () => {
    for (const text of [
      "-----BEGIN OPENSSH PRIVATE KEY-----",
      "password=hunter2",
      "api_key: abcdef",
      "Authorization: Bearer abcdef123456",
      "hct_abcdefghijklmnop1234",
    ])
      expect(containsSecretMaterial(text)).toBe(true);
    for (const text of ["uname -s", "docker ps --format json", "status:read"])
      expect(containsSecretMaterial(text)).toBe(false);
  });
});

describe("audit journal hash chain", () => {
  const events: AuditEvent[] = [
    { event: "client.created", client: "codex-pc" },
    {
      event: "operation.planned",
      client: "codex-pc",
      operationId: "0b6f2c1e-3a4d-4e5f-8a9b-0c1d2e3f4a5b",
      host: "lab",
      argv: ["uname", "-s"],
    },
    {
      event: "request.rejected",
      client: "codex-pc",
      reason: "Host not permitted for this client",
    },
  ];

  async function filled() {
    const { dir, path } = await workspace();
    const journal = new AuditJournal(path, join(dir, "audit.anchor"), () =>
      Date.UTC(2026, 10, 5),
    );
    for (const event of events) await journal.append({ ...event });
    return { dir, path, journal };
  }

  test("appends link each entry to its predecessor and verify cleanly", async () => {
    const { dir, journal } = await filled();
    try {
      const entries = await journal.read();
      expect(entries.map((e) => e.seq)).toEqual([1, 2, 3]);
      expect(entries[0]?.prev).toBe(GENESIS);
      expect(entries[1]?.prev).toBe(entries[0]?.hash);
      expect(entries[2]?.prev).toBe(entries[1]?.hash);
      const check = await journal.verify();
      expect(check.ok).toBe(true);
      expect(check.entries).toBe(3);
      expect(check.head).toBe(entries.at(-1)?.hash ?? "missing");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("an edited middle entry is detected at its sequence number", async () => {
    const { dir, path, journal } = await filled();
    try {
      const lines = (await readFile(path, "utf8")).split("\n").filter(Boolean);
      const middle = JSON.parse(lines[1] ?? "{}");
      middle.event.host = "nas";
      lines[1] = JSON.stringify(middle);
      await writeFile(path, `${lines.join("\n")}\n`);
      const check = await journal.verify();
      expect(check.ok).toBe(false);
      expect(check.error).toContain("at entry 2");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("a deleted middle entry breaks the chain", async () => {
    const { dir, path, journal } = await filled();
    try {
      const lines = (await readFile(path, "utf8")).split("\n").filter(Boolean);
      await writeFile(path, `${[lines[0], lines[2]].join("\n")}\n`);
      const check = await journal.verify();
      expect(check.ok).toBe(false);
      expect(check.error).toMatch(/sequence break|chain link broken/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("reordered entries are rejected", async () => {
    const { dir, path, journal } = await filled();
    try {
      const lines = (await readFile(path, "utf8")).split("\n").filter(Boolean);
      await writeFile(path, `${[lines[1], lines[0], lines[2]].join("\n")}\n`);
      expect((await journal.verify()).ok).toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("tail truncation is detected through the anchor", async () => {
    const { dir, path, journal } = await filled();
    try {
      const lines = (await readFile(path, "utf8")).split("\n").filter(Boolean);
      await writeFile(path, `${lines.slice(0, 2).join("\n")}\n`);
      const check = await journal.verify();
      expect(check.ok).toBe(false);
      expect(check.anchored).toBe(true);
      expect(check.error).toContain("entries were removed from the end");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("truncating the journal to nothing is also detected", async () => {
    const { dir, path, journal } = await filled();
    try {
      await writeFile(path, "");
      expect((await journal.verify()).ok).toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("a deleted anchor is reported, not silently accepted", async () => {
    const { dir, journal } = await filled();
    try {
      await rm(join(dir, "audit.anchor"));
      const check = await journal.verify();
      expect(check.ok).toBe(false);
      expect(check.error).toContain("anchor is missing");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("a journal that diverges from its anchor is detected", async () => {
    const { dir, path, journal } = await filled();
    try {
      const lines = (await readFile(path, "utf8")).split("\n").filter(Boolean);
      // Rebuild a valid two-entry chain that differs from the anchored one.
      const other = new AuditJournal(
        join(dir, "other.jsonl"),
        join(dir, "other.anchor"),
        () => Date.UTC(2026, 10, 6),
      );
      await other.append({ event: "client.created", client: "other" });
      await other.append({ event: "client.created", client: "third" });
      const forged = (await readFile(join(dir, "other.jsonl"), "utf8"))
        .split("\n")
        .filter(Boolean);
      await writeFile(path, `${[forged[0], forged[1], lines[2]].join("\n")}\n`);
      const check = await journal.verify();
      expect(check.ok).toBe(false);
      expect(check.error).toMatch(/diverges from its anchor|chain link broken/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("a journal append also refuses when truncation is present", async () => {
    const { dir, path, journal } = await filled();
    try {
      const lines = (await readFile(path, "utf8")).split("\n").filter(Boolean);
      await writeFile(path, `${lines.slice(0, 1).join("\n")}\n`);
      await expect(
        journal.append({ event: "request.accepted", client: "codex-pc" }),
      ).rejects.toBeInstanceOf(HomectlError);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("a corrupt journal refuses further appends", async () => {
    const { dir, path, journal } = await filled();
    try {
      await writeFile(path, `${await readFile(path, "utf8")}not json\n`);
      await expect(
        journal.append({ event: "request.accepted", client: "codex-pc" }),
      ).rejects.toBeInstanceOf(HomectlError);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("secret-like payloads are refused and nothing is written", async () => {
    const { dir, path, journal } = await filled();
    try {
      const before = await readFile(path, "utf8");
      await expect(
        journal.append({
          event: "request.rejected",
          client: "codex-pc",
          reason: "password=hunter2",
        }),
      ).rejects.toMatchObject({ code: 5 });
      expect(await readFile(path, "utf8")).toBe(before);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("verifyChain on an empty journal is valid", () => {
    expect(verifyChain([])).toEqual({ ok: true, entries: 0, head: GENESIS });
  });
});
