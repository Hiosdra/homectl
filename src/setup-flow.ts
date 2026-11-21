import { writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline/promises";
import { installDependencies, installLinuxDependencies } from "./dependencies";
import { configureFirewall, firewallPlan } from "./firewall";
import { loadInventory } from "./inventory";
import { lanAddresses } from "./peer/interactive";
import { available, protect, windows } from "./platform";
import { readPassword } from "./session";
import { initDatabase } from "./session/database";
import { sessionConfig } from "./session/config";
import { doctor, paths, setup } from "./setup";
import { type GuidedResult, guidedSetup } from "./setup-guided";
import { HomectlError } from "./types";

export async function selectLanInterface(
  interfaceIP: string | undefined,
  addresses: string[],
  ask: (prompt: string) => Promise<string>,
  required = false,
): Promise<string | undefined> {
  if (interfaceIP) return interfaceIP;
  if (addresses.length === 0) {
    if (required)
      throw new HomectlError(
        2,
        "Choose a LAN interface before configuring the firewall; pass --interface <local-LAN-IP> or select an interface when prompted",
      );
    return undefined;
  }
  if (addresses.length === 1) return addresses[0];
  console.log("Choose the LAN used for pairing (Enter to skip):");
  addresses.forEach((address, index) => {
    console.log(`${index + 1}. ${address}`);
  });
  const choice = await ask("Interface number: ");
  if (!choice) {
    if (required)
      throw new HomectlError(
        2,
        "Choose a LAN interface before configuring the firewall; pass --interface <local-LAN-IP> or select an interface when prompted",
      );
    return undefined;
  }
  if (!/^\d+$/.test(choice) || !addresses[Number(choice) - 1])
    throw new HomectlError(2, "Invalid interface number");
  return addresses[Number(choice) - 1];
}

export async function setupFlow(options: {
  home: string;
  json: boolean;
  dryRun: boolean;
  installDeps: boolean;
  configureFirewall: boolean;
  interface?: string;
  interactive?: boolean;
  addresses?: string[];
  ask?: (prompt: string) => Promise<string>;
  // Guided setup seams (interactive only). Defaults: the terminal and the real vault.
  askSecret?: (prompt: string) => Promise<string>;
  createVault?: (password: string) => Promise<unknown>;
  start?: () => Promise<number>;
}) {
  const interactive =
    options.interactive ??
    (!options.json &&
      !options.dryRun &&
      Boolean(process.stdin.isTTY && process.stdout.isTTY));
  if (options.configureFirewall && !options.interface && !interactive)
    throw new HomectlError(
      2,
      "Noninteractive firewall configuration requires --interface <local-LAN-IP>",
    );
  const ask =
    options.ask ??
    (async (prompt: string) => {
      const input = createInterface({
        input: process.stdin,
        output: process.stdout,
      });
      try {
        return (await input.question(prompt)).trim();
      } finally {
        input.close();
      }
    });
  let ip = options.interface;
  if (interactive)
    ip = await selectLanInterface(
      ip,
      options.addresses ?? lanAddresses(),
      ask,
      options.configureFirewall,
    );
  let install = options.installDeps;
  const missing = ["ssh", "keepassxc-cli"].filter((name) => !available(name));
  if (interactive && missing.length && !install) {
    console.log(
      `Missing dependencies: ${missing.join(", ")}. Installation requires administrator privileges.`,
    );
    install = /^(y|yes)$/i.test(
      await ask("Install missing dependencies? [y/N]: "),
    );
  }
  const dependencies = install
    ? windows
      ? await installDependencies(
          options.dryRun,
          undefined,
          undefined,
          undefined,
          interactive,
        )
      : await installLinuxDependencies(options.dryRun, interactive)
    : { missing };
  const result = await setup(options.home, options.dryRun);
  let firewall: unknown;
  let configure = options.configureFirewall;
  if (ip) {
    const plan = await firewallPlan(ip);
    if (interactive && !configure && plan.backend !== "unsupported") {
      console.log(plan.actions.join("\n"));
      if (windows)
        console.log(
          "Rules apply only to Private network profiles. No network profile is changed.",
        );
      configure = /^(y|yes)$/i.test(
        await ask(
          "Configure these firewall rules with administrator privileges? [y/N]: ",
        ),
      );
    }
    firewall =
      configure && !options.dryRun
        ? await configureFirewall(plan, interactive)
        : {
            configured: false,
            interface: plan.ip,
            backend: plan.backend,
            actions: plan.actions,
          };
    if (!options.dryRun) {
      const file = join(
        dirname(paths(options.home).inventory),
        "setup-preferences.json",
      );
      await writeFile(file, JSON.stringify({ interface: ip }), { mode: 0o600 });
      await protect(file);
    }
  } else
    firewall = {
      configured: false,
      note: "LAN not selected; firewall not changed. Run setup interactively or pass --configure-firewall --interface in JSON mode.",
    };
  const inventoryPath = paths(options.home).inventory;
  const verification = options.dryRun
    ? undefined
    : await doctor(await loadInventory(inventoryPath), inventoryPath);
  // Interactive only: create the vault, print a summary, then offer to start homectl.
  const guided =
    interactive && !options.dryRun ? await runGuided(options, ask) : undefined;
  return {
    ...result,
    dependencies,
    firewall,
    ...(verification ? { doctor: verification } : {}),
    interactive,
    ...(guided ? { guided } : {}),
  };
}

async function runGuided(
  options: Parameters<typeof setupFlow>[0],
  ask: (prompt: string) => Promise<string>,
): Promise<GuidedResult> {
  const { home } = options;
  const inventoryPath = paths(home).inventory;
  const inventory = await loadInventory(inventoryPath);
  const database = sessionConfig(inventory, inventoryPath).database;
  return guidedSetup({
    say: (line) => console.log(line),
    ask,
    askSecret: options.askSecret ?? ((prompt) => readPassword(prompt)),
    vaultExists: async () => Bun.file(database).exists(),
    vaultPath: database,
    createVault:
      options.createVault ??
      ((password) => initDatabase(inventory, inventoryPath, password)),
    start:
      options.start ??
      (async () =>
        (await import("./cli/start-command")).startCommand({
          inventoryPath,
          sshConfigPath: paths(home).ssh,
          open: true,
        })),
  });
}
