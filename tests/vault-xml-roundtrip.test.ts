// KDBX XML round trip after moving kdbxweb's @xmldom/xmldom to 0.8.x (the
// 0.7 line had serialization injection advisories). Values that look like XML
// markup must come back byte for byte and must not alter the document.
import { afterAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDatabase, openDatabase, passwordSource } from "../src/vault";

const SMALL = { memory: 1024, iterations: 1, parallelism: 1 };
const PASSWORD = "xml round trip password";
const dirs: string[] = [];
afterAll(async () => {
  for (const dir of dirs) await rm(dir, { recursive: true, force: true });
});

const HOSTILE = [
  "plain",
  "a]]>b<![CDATA[c]]>",
  "<!-- comment --><?pi x?>",
  '<!DOCTYPE x [<!ENTITY e "boom">]>&e;',
  "&amp; &lt; &gt; &quot; &#x41;",
  "</Value></String><String><Key>Injected</Key>",
  "unicode zażółć 😀",
];

test("values that look like XML survive save and reopen unchanged", async () => {
  const dir = await mkdtemp(join(tmpdir(), "homectl-vault-xml-"));
  dirs.push(dir);
  const path = join(dir, "x.kdbx");
  const created = await createDatabase(path, passwordSource(PASSWORD), {
    argon2: SMALL,
  });
  HOSTILE.forEach((value, index) => {
    const entry = created.db.createEntry(created.db.getDefaultGroup());
    entry.fields.set("Title", `entry-${index}`);
    entry.fields.set("UserName", value);
    entry.fields.set("Notes", value);
  });
  await created.save();

  const reopened = await openDatabase(path, passwordSource(PASSWORD));
  const entries = reopened.db.getDefaultGroup().entries;
  expect(entries).toHaveLength(HOSTILE.length);
  HOSTILE.forEach((value, index) => {
    const entry = entries.find(
      (e) => e.fields.get("Title") === `entry-${index}`,
    );
    expect(entry?.fields.get("UserName")).toBe(value);
    expect(entry?.fields.get("Notes")).toBe(value);
    // No field was injected by a value.
    expect([...(entry?.fields.keys() ?? [])].sort()).toEqual(
      ["Notes", "Password", "Title", "URL", "UserName"].filter((key) =>
        entry?.fields.has(key),
      ),
    );
    expect(entry?.fields.has("Injected")).toBe(false);
  });
});
