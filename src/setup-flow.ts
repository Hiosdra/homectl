import { writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline/promises";
import { installDependencies, installLinuxDependencies } from "./dependencies";
import { configureFirewall, firewallPlan } from "./firewall";
import { loadInventory } from "./inventory";
import { lanAddresses } from "./peer/interactive";
import { available, protect, windows } from "./platform";
import { doctor, paths, setup } from "./setup";
import { HomectlError } from "./types";
export async function setupFlow(options: {
  home: string;
  json: boolean;
  dryRun: boolean;
  installDeps: boolean;
  configureFirewall: boolean;
  interface?: string;
}) {
  const interactive =
    !options.json &&
    !options.dryRun &&
    Boolean(process.stdin.isTTY && process.stdout.isTTY);
  const ask = async (prompt: string) => {
    const input = createInterface({
      input: process.stdin,
      output: process.stdout,
    });
    try {
      return (await input.question(prompt)).trim();
    } finally {
      input.close();
    }
  };
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
  let ip = options.interface;
  let firewall: unknown;
  let configure = options.configureFirewall;
  if (interactive) {
    const addresses = lanAddresses();
    if (!ip && addresses.length === 1) ip = addresses[0];
    else if (!ip && addresses.length > 1) {
      console.log("Choose the LAN used for pairing (Enter to skip):");
      addresses.forEach((address, i) => {
        console.log(`${i + 1}. ${address}`);
      });
      const choice = await ask("Interface number: ");
      if (choice) {
        if (!/^\d+$/.test(choice) || !addresses[Number(choice) - 1])
          throw new HomectlError(2, "Invalid interface number");
        ip = addresses[Number(choice) - 1];
      }
    }
  }
  if (configure && !ip)
    throw new HomectlError(
      2,
      "Noninteractive firewall configuration requires --interface <local-LAN-IP>",
    );
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
  const verification = options.dryRun
    ? undefined
    : await doctor(
        await loadInventory(paths(options.home).inventory),
        paths(options.home).inventory,
      );
  return {
    ...result,
    dependencies,
    firewall,
    ...(verification ? { doctor: verification } : {}),
    interactive,
  };
}
