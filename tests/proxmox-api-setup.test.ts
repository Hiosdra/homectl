import { expect, test } from "bun:test";
import { X509Certificate } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rootCertificates } from "node:tls";
import { proxmoxApiSetup } from "../src/broker/proxmox-api-setup";
import { loadInventory } from "../src/inventory";
import { inventoryText } from "./proxmox-test-inventory";

const ROUTE = "/v1/owner/proxmox-api/setup";
const HOST = "pve-host";
const URL = "https://pve.example:8006";
const ENTRY = "homectl-pve-token";
const TOKEN = "PVEAPIToken=fixture@pve!api=SYNTHETIC-SECRET";

test("sets up the Proxmox HTTPS provider from pinned SSH and a vault entry", async () => {
  const dir = await mkdtemp(join(tmpdir(), "homectl-pve-setup-"));
  try {
    const inventoryPath = join(dir, "inventory.yaml");
    const original = inventoryText("unused.pem").replace(
      /^ {4}api:[\s\S]*$/m,
      "",
    );
    await writeFile(inventoryPath, original);
    const pem = rootCertificates.find((value) => {
      const certificate = new X509Certificate(value);
      return certificate.ca && certificate.verify(certificate.publicKey);
    });
    if (!pem) throw new Error("No test trust anchor available");
    const reads: string[] = [];
    const activated: [string, string][] = [];
    let verified = 0;
    let allow = false;
    const setup = proxmoxApiSetup({
      inventoryPath,
      authorization: (entry) => {
        expect(entry).toBe(ENTRY);
        return TOKEN;
      },
      activate: async (provider, entry) => {
        activated.push([provider, entry]);
      },
      runner: async ({ stdin }) => {
        const { argv } = JSON.parse(stdin ?? "") as { argv: string[] };
        expect(argv).toContain("StrictHostKeyChecking=yes");
        expect(argv).toContain("GlobalKnownHostsFile=none");
        const command = argv.at(-1);
        if (!command) throw new Error("No remote command");
        reads.push(command);
        if (command.includes("'/cluster/status'"))
          return {
            exitCode: 0,
            stderr: "",
            stdout: JSON.stringify([
              { type: "node", local: 1, name: "pve-test" },
            ]),
          };
        expect(command).toBe("'sudo' '-n' 'cat' '/etc/pve/pve-root-ca.pem'");
        return { exitCode: 0, stderr: "", stdout: pem };
      },
      fetcher: async (url, init) => {
        verified += 1;
        expect(url).toBe(`${URL}/api2/json/nodes/pve-test/status`);
        expect(init.method).toBe("GET");
        expect(init.redirect).toBe("error");
        expect(new Headers(init.headers).get("authorization")).toBe(TOKEN);
        expect(new X509Certificate(init.tls?.ca ?? "").fingerprint256).toBe(
          new X509Certificate(pem).fingerprint256,
        );
        return allow
          ? Response.json({ data: { pveversion: "pve-manager/9" } })
          : new Response(null, { status: 401 });
      },
    });
    const input = {
      host: HOST,
      url: URL,
      tokenEntry: ENTRY,
      password: "owner fixture",
    };
    const call = (changes: Record<string, unknown> = {}) =>
      setup.owner?.(ROUTE, { ...input, ...changes }, async (password) => {
        expect(password).toBe("owner fixture");
      });

    await expect(call({ url: "http://pve.example:8006" })).rejects.toThrow(
      "HTTPS origin",
    );
    expect(reads).toHaveLength(0);
    const preview = (await call()) as { fingerprint: string; caFile: string };
    expect(preview).toMatchObject({
      host: HOST,
      node: "pve-test",
      operations: "full",
      configured: false,
    });
    expect(verified).toBe(0);
    expect(await Bun.file(preview.caFile).exists()).toBe(false);
    await expect(
      call({
        approval: preview.fingerprint,
        url: "https://other.example:8006",
      }),
    ).rejects.toThrow("fresh preview");
    expect(verified).toBe(0);
    await expect(call({ approval: preview.fingerprint })).rejects.toThrow(
      "HTTPS verification failed",
    );
    expect(await Bun.file(preview.caFile).exists()).toBe(false);
    expect(
      (await loadInventory(inventoryPath)).providers?.["pve-test"]?.api,
    ).toBeUndefined();
    expect(activated).toEqual([]);

    allow = true;
    const applied = await call({ approval: preview.fingerprint });
    expect(applied).toMatchObject({ configured: true, active: true });
    expect(activated).toEqual([["pve-test", ENTRY]]);
    expect(
      (await loadInventory(inventoryPath)).providers?.["pve-test"],
    ).toMatchObject({
      operations: "full",
      vmid_range: [9001, 9010],
      api: { url: URL, ca_file: preview.caFile, token_entry: ENTRY },
    });
    expect(await Bun.file(preview.caFile).exists()).toBe(true);
    expect(await Bun.file(inventoryPath).text()).not.toContain(TOKEN);
    expect(JSON.stringify(applied)).not.toContain(TOKEN);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
