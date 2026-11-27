import { X509Certificate } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fingerprint } from "../control/canonical";
import { withFileLock } from "../control/file-lock";
import { providerEntry } from "../control/proxmox-full";
import { loadInventory, saveInventory } from "../inventory";
import { protect } from "../platform";
import { type ApiFetch, runProxmoxApi } from "../proxmox/api";
import { HomectlError, type ProviderConfig, type Runner } from "../types";
import { localProxmoxNode, proxmoxSsh } from "./proxmox-ssh";
import type { RouteExtension } from "./server";
import { rebindMachine } from "./vault-wiring";

const ROUTE = "/v1/owner/proxmox-api/setup";
const CA_PATH = "/etc/pve/pve-root-ca.pem";
const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,62}$/;

function httpsOrigin(value: unknown): string {
  if (typeof value !== "string" || value.length > 300)
    throw new HomectlError(2, "Provide the Proxmox HTTPS origin");
  try {
    const url = new URL(value);
    if (
      url.protocol === "https:" &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash &&
      url.pathname === "/"
    )
      return url.origin;
  } catch {
    // Report only the shape, never the supplied URL.
  }
  throw new HomectlError(
    2,
    "Use an HTTPS origin without credentials, a path, query or fragment",
  );
}

function clusterCa(value: string): X509Certificate {
  try {
    if (
      !/^-----BEGIN CERTIFICATE-----\s+[A-Za-z0-9+/=\s]+-----END CERTIFICATE-----$/.test(
        value.trim(),
      ) ||
      value.length > 16_384
    )
      throw new Error();
    const cert = new X509Certificate(value);
    if (cert.ca && cert.checkIssued(cert) && cert.verify(cert.publicKey))
      return cert;
  } catch {
    // Raw SSH output is not part of the approval or CLI diagnostic.
  }
  throw new HomectlError(
    5,
    "Proxmox did not return a valid cluster CA certificate",
  );
}

interface Options {
  inventoryPath: string;
  authorization(entry: string): string;
  activate(provider: string, entry: string): Promise<void>;
  runner?: Runner;
  fetcher?: ApiFetch;
}

export function proxmoxApiSetup(options: Options): RouteExtension {
  const inventoryPath = resolve(options.inventoryPath);
  return {
    async owner(path, input, stepUp) {
      if (path !== ROUTE) return undefined;
      if (
        Object.keys(input).some(
          (key) =>
            !["host", "url", "tokenEntry", "approval", "password"].includes(
              key,
            ),
        )
      )
        throw new HomectlError(2, "Unknown Proxmox API setup field");
      const { host, tokenEntry, approval } = input;
      if (typeof host !== "string" || !NAME.test(host))
        throw new HomectlError(2, "Provide an inventory host");
      if (
        typeof tokenEntry !== "string" ||
        !/^[\w .-]{1,128}$/.test(tokenEntry) ||
        tokenEntry.trim() !== tokenEntry
      )
        throw new HomectlError(
          2,
          "Provide the name of an existing vault entry",
        );
      if (
        approval !== undefined &&
        (typeof approval !== "string" || !/^[a-f0-9]{64}$/.test(approval))
      )
        throw new HomectlError(2, "Provide the reviewed setup fingerprint");
      const url = httpsOrigin(input.url);
      await stepUp(input.password);
      const inventory = await loadInventory(inventoryPath);
      const machine = inventory.machines[host];
      if (!machine) throw new HomectlError(3, "Host is not in the inventory");
      const existing = providerEntry(inventory, host);
      const providerName = existing?.[0] ?? host;
      if (!existing && Object.hasOwn(inventory.providers ?? {}, providerName))
        throw new HomectlError(
          3,
          "The provider name is already used by another host",
        );
      const ssh = proxmoxSsh(
        inventoryPath,
        rebindMachine(machine, inventoryPath),
        options.runner,
      );
      const node = await localProxmoxNode(ssh);
      if (existing && existing[1].node !== node)
        throw new HomectlError(
          3,
          "SSH reached a different node than the configured provider",
        );
      const ca = await ssh(["cat", CA_PATH]);
      if (ca.exitCode !== 0)
        throw new HomectlError(
          5,
          "Could not read the public Proxmox cluster CA over SSH",
        );
      const cert = clusterCa(ca.stdout);
      const digest = cert.fingerprint256.replaceAll(":", "").toLowerCase();
      const caFile = join(dirname(inventoryPath), `proxmox-ca-${digest}.pem`);
      const api = { url, ca_file: caFile, token_entry: tokenEntry };
      if (
        existing?.[1].api &&
        fingerprint(existing[1].api) !== fingerprint(api)
      )
        throw new HomectlError(
          3,
          "This provider already has different HTTPS settings",
        );
      const current = fingerprint(inventory);
      const details = {
        host,
        node,
        provider: providerName,
        operations: "full" as const,
        url,
        tokenEntry,
        caFingerprint: cert.fingerprint256,
        caFile,
      };
      const preview = {
        ...details,
        fingerprint: fingerprint({ details, current }),
      };
      if (approval === undefined) return { ...preview, configured: false };
      if (approval !== preview.fingerprint)
        throw new HomectlError(
          3,
          "The Proxmox API setup changed. Review a fresh preview",
        );

      try {
        const check = await runProxmoxApi(
          {
            baseUrl: url,
            caPem: cert.toString(),
            authorization: options.authorization(tokenEntry),
          },
          node,
          {
            method: "GET",
            path: `/nodes/${encodeURIComponent(node)}/status`,
            params: {},
            task: false,
            inspect: true,
          },
          options.fetcher ? { fetcher: options.fetcher } : {},
        );
        if (
          check.exitCode !== 0 ||
          typeof JSON.parse(check.stdout)?.pveversion !== "string"
        )
          throw new Error();
      } catch (error) {
        if (error instanceof HomectlError) throw error;
        throw new HomectlError(
          5,
          "Proxmox HTTPS verification failed. Check the URL, certificate name and token permissions",
        );
      }

      return withFileLock(
        `${inventoryPath}.proxmox-setup.lock`,
        "Proxmox API setup",
        async () => {
          if (fingerprint(await loadInventory(inventoryPath)) !== current)
            throw new HomectlError(
              3,
              "The inventory changed during verification. Review a fresh preview",
            );
          const pem = cert.toString();
          try {
            await writeFile(caFile, pem, { flag: "wx", mode: 0o600 });
          } catch (error) {
            if (
              (error as NodeJS.ErrnoException).code !== "EEXIST" ||
              (await readFile(caFile, "utf8")) !== pem
            )
              throw new HomectlError(
                5,
                "Could not store the Proxmox cluster CA",
              );
          }
          await protect(caFile);
          const provider: ProviderConfig = {
            ...existing?.[1],
            type: "proxmox",
            host,
            node,
            operations: "full",
            api,
          };
          inventory.providers = {
            ...inventory.providers,
            [providerName]: provider,
          };
          await saveInventory(inventoryPath, inventory);
          const active = await options.activate(providerName, tokenEntry).then(
            () => true,
            () => false,
          );
          return { ...preview, configured: true, active };
        },
      );
    },
  };
}
