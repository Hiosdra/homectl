import { afterEach, beforeEach, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { publicKeyOf, verifySignature } from "../src/release-trust";

const script = resolve(import.meta.dir, "../scripts/sign-release.ts");
const manifest = '{"schema":1,"version":"0.3.0","artifacts":[]}\n';
let dist: string;

beforeEach(async () => {
  dist = await mkdtemp(join(tmpdir(), "hc-sign-release-"));
  await writeFile(join(dist, "manifest.json"), manifest);
});
afterEach(async () => {
  await rm(dist, { recursive: true, force: true });
});

async function sign(seed: string, ...flags: string[]) {
  const child = Bun.spawn([process.execPath, script, dist, ...flags], {
    env: { ...process.env, HOMECTL_SIGNING_KEY: seed },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [output, errors, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { output, errors, exitCode };
}

test("publication fails without a signing key", async () => {
  const outcome = await sign("", "--require-trusted");
  expect(outcome.exitCode).toBe(1);
  expect(outcome.errors).toContain("required to publish");
  expect(await Bun.file(join(dist, "manifest.json.sig")).exists()).toBe(false);
});

test("publication rejects a key outside the updater trust set", async () => {
  const outcome = await sign(
    randomBytes(32).toString("hex"),
    "--require-trusted",
  );
  expect(outcome.exitCode).toBe(1);
  expect(outcome.errors).toContain("trusted and active");
  expect(await Bun.file(join(dist, "manifest.json.sig")).exists()).toBe(false);
});

test("an unsigned manual build works and an explicitly signed build can be verified", async () => {
  expect((await sign("")).exitCode).toBe(0);
  expect(await Bun.file(join(dist, "manifest.json.sig")).exists()).toBe(false);
  const seed = randomBytes(32).toString("hex");
  const outcome = await sign(seed);
  expect(outcome.exitCode).toBe(0);
  expect(outcome.output).not.toContain(seed);
  const signature = await readFile(join(dist, "manifest.json.sig"), "utf8");
  expect(() =>
    verifySignature(Buffer.from(manifest), signature, {
      keys: [publicKeyOf(seed)],
      revoked: [],
    }),
  ).not.toThrow();
});
