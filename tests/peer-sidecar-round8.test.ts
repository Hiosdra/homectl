import { afterEach, expect, spyOn, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadState, saveState } from "../src/peer/store";

const cleanup: string[] = [];
afterEach(async () => {
  for (const dir of cleanup.splice(0))
    await rm(dir, { recursive: true, force: true });
});

async function peerFiles(
  sidecarContents: "garbage" | "wrong-version" | "directory",
) {
  const dir = await mkdtemp(join(tmpdir(), "homectl-peer-sidecar-"));
  cleanup.push(dir);
  const peerFile = join(dir, "peers.json");
  await writeFile(
    peerFile,
    JSON.stringify({
      version: 1,
      id: "local-id",
      name: "local",
      key: "k".repeat(64),
      peers: {},
      records: {
        "machine:lab": { clock: { "local-id": 1 }, value: { name: "lab" } },
      },
      observed: {},
    }),
  );
  const sidecar = join(dir, "peers-saved-commands.json");
  if (sidecarContents === "directory") await mkdir(sidecar);
  else
    await writeFile(
      sidecar,
      sidecarContents === "garbage"
        ? "{ malformed saved-command peer state\n"
        : JSON.stringify({ version: 2, records: {}, observed: {} }),
    );
  return { dir, peerFile, sidecar };
}

for (const kind of ["garbage", "wrong-version", "directory"] as const) {
  test(`an unreadable saved-command sidecar (${kind}) degrades without failing load`, async () => {
    const { peerFile, sidecar } = await peerFiles(kind);
    const warning = spyOn(console, "warn").mockImplementation(() => {});
    try {
      const loaded = await loadState(peerFile);
      expect(loaded.records["machine:lab"]?.value).toEqual({ name: "lab" });
      expect(
        Object.keys(loaded.records).filter((id) =>
          id.startsWith("saved-command:"),
        ),
      ).toEqual([]);
      expect(warning).toHaveBeenCalledWith(
        expect.stringContaining("saved-command sync is disabled"),
      );

      // Ordinary peer changes still save; the bad sidecar is never overwritten.
      loaded.records["machine:lab"] = {
        clock: { "local-id": 2 },
        value: { name: "lab-renamed" },
      };
      const before =
        kind === "directory" ? null : await readFile(sidecar, "utf8");
      await saveState(peerFile, loaded);
      const saved = JSON.parse(await readFile(peerFile, "utf8"));
      expect(saved.records["machine:lab"].value).toEqual({
        name: "lab-renamed",
      });
      if (before !== null) expect(await readFile(sidecar, "utf8")).toBe(before);
    } finally {
      warning.mockRestore();
    }
  });
}

test("repairing the sidecar re-enables saved-command peer state", async () => {
  const { peerFile, sidecar } = await peerFiles("garbage");
  const warning = spyOn(console, "warn").mockImplementation(() => {});
  try {
    await loadState(peerFile);
    await writeFile(
      sidecar,
      JSON.stringify({ version: 1, records: {}, observed: {} }),
    );
    const loaded = await loadState(peerFile);
    loaded.records["saved-command:abc"] = {
      clock: { "local-id": 1 },
      value: { id: "abc" },
    };
    await saveState(peerFile, loaded);
    expect(JSON.parse(await readFile(sidecar, "utf8")).records).toHaveProperty(
      "saved-command:abc",
    );
  } finally {
    warning.mockRestore();
  }
});
