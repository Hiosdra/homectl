// The workspace listener serves only the workspace network paths, with
// bounded bodies and no internals in errors (homelab #21 §6).
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WorkspaceServer } from "../src/workspace/server";
import { backupFiles, workspaceFetch } from "../src/workspace/wiring";

let dir: string;
let server: WorkspaceServer;
let fetch: (req: Request) => Promise<Response>;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "hc-workspace-wire-"));
  await mkdir(join(dir, "state"), { recursive: true });
  server = new WorkspaceServer(join(dir, "state"));
  fetch = workspaceFetch(server);
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const post = (path: string, body: unknown) =>
  new Request(`http://listener.test${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

test("only POST to workspace paths is served; everything else is 404", async () => {
  const get = await fetch(
    new Request("http://listener.test/v1/workspace/challenge"),
  );
  expect(get.status).toBe(404);
  const other = await fetch(post("/v1/owner/clients/list", {}));
  expect(other.status).toBe(404);
  const unknown = await fetch(post("/v1/workspace/nope", {}));
  expect(unknown.status).toBe(404);
});

test("refusals carry a message only, with a 403 for unknown clients", async () => {
  const response = await fetch(
    post("/v1/workspace/challenge", {
      id: "00000000-0000-4000-8000-000000000000",
    }),
  );
  expect(response.status).toBe(403);
  const body = (await response.json()) as {
    error: { message: string; stack?: string };
  };
  expect(body.error.message).toBe("Unknown workspace client");
  expect(body.error.stack).toBeUndefined();
});

test("a body that is not an object, or not JSON, is a 400", async () => {
  const notJson = await fetch(
    new Request("http://listener.test/v1/workspace/challenge", {
      method: "POST",
      body: "{nope",
    }),
  );
  expect(notJson.status).toBe(400);
  const array = await fetch(post("/v1/workspace/challenge", [1, 2]));
  expect(array.status).toBe(400);
});

test("a request over the 1 MiB limit is refused before it is handled", async () => {
  const huge = { id: "x".repeat(2 * 1024 * 1024) };
  const response = await fetch(post("/v1/workspace/challenge", huge));
  expect(response.status).toBe(400);
  expect(
    ((await response.json()) as { error: { message: string } }).error.message,
  ).toBe("Request too large");
});

test("pairing is closed until the owner opens an invite", async () => {
  const response = await fetch(
    post("/v1/workspace/pair/start", { public: "00" }),
  );
  expect(response.status).toBe(403);
});

test("backup files are the inventory, known_hosts and policy, and missing ones are skipped", async () => {
  const inventory = join(dir, "inv", "inventory.yaml");
  await mkdir(join(dir, "inv"), { recursive: true });
  await writeFile(inventory, "machines: {}\n");
  await writeFile(join(dir, "inv", "known_hosts"), "lab ssh-ed25519 AAAA\n");
  await mkdir(join(dir, "state2"), { recursive: true });
  const files = await backupFiles(inventory, join(dir, "state2"));
  expect(files.map((file) => file.path)).toEqual([
    "inventory.yaml",
    "known_hosts",
  ]);
  expect(new TextDecoder().decode(files[0]?.data)).toContain("machines");
});
