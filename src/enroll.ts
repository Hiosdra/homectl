import { readFile } from "node:fs/promises";
import { credentialSpec } from "./credentials";
import { loadInventory, parseInventory, saveInventory } from "./inventory";
import { workerPath, writeSSHConfig } from "./operations";
import { sudoers } from "./policies";
import { run } from "./process";
import { transportSpec } from "./transports";
import { HomectlError, type Machine, type Runner } from "./types";
export async function installSudo(
  host: string,
  m: Machine,
  configPath: string,
  runner: Runner = run,
) {
  if (m.transport !== "ssh" || !m.user)
    throw new HomectlError(
      2,
      "Sudo installation requires an existing SSH user",
    );
  const content = sudoers(m.user, m);
  const target = `/etc/sudoers.d/homectl-${host}`;
  if (!/^[a-z][a-z0-9-]{0,62}$/.test(host))
    throw new HomectlError(2, "Invalid host");
  // Built-in non-destructive operation. Existing different configuration is never overwritten.
  const script = `set -eu\ntarget='${target}'\nif test -e "$target"; then cmp -s "$target" - && exit 0; echo 'Existing sudoers differs; reset requires explicit confirmation' >&2; exit 3; fi\ntemp=$(mktemp /tmp/homectl-sudoers.XXXXXX)\ncat > "$temp"\nchmod 600 "$temp"\nvisudo -cf "$temp" >/dev/null\ninstall -m 0440 "$temp" "$target"\nvisudo -c >/dev/null\n`;
  const result = await runner(
    credentialSpec(
      m.auth,
      {
        ...transportSpec(m, ["sudo", "-n", "sh", "-c", script], configPath),
        stdin: content,
      },
      workerPath,
    ),
  );
  if (result.exitCode !== 0)
    throw new HomectlError(
      5,
      "Sudo setup failed; use initial trusted interactive sudo access, or inspect existing sudoers. No passwords are requested by homectl.",
    );
  return { installed: target };
}
export async function enroll(
  name: string,
  m: Machine,
  inventoryPath: string,
  configPath: string,
  options: { dryRun?: boolean; configureSudo?: boolean; runner?: Runner } = {},
) {
  const before = await readFile(inventoryPath, "utf8");
  const inv = await loadInventory(inventoryPath);
  if (!/^[a-z][a-z0-9-]{0,62}$/.test(name))
    throw new HomectlError(2, "Invalid machine name");
  if (
    inv.machines[name] &&
    JSON.stringify(inv.machines[name]) !== JSON.stringify(m)
  )
    throw new HomectlError(
      3,
      "Existing inventory entry differs; resetting it requires a separately approved operation",
    );
  inv.machines[name] = m;
  parseInventory(JSON.stringify(inv));
  if (options.configureSudo) sudoers(m.user ?? "", m);
  if (options.dryRun)
    return { name, machine: m, configureSudo: options.configureSudo ?? false };
  await writeSSHConfig(configPath, inv.machines);
  const runner = options.runner ?? run;
  const probe = await runner(
    credentialSpec(
      m.auth,
      transportSpec(m, ["uname", "-s"], configPath),
      workerPath,
    ),
  );
  if (probe.exitCode !== 0)
    throw new HomectlError(
      5,
      "Enrollment connectivity failed; check known_hosts, provider approval and network. Inventory was not changed.",
    );
  if (options.configureSudo) await installSudo(name, m, configPath, runner);
  if ((await readFile(inventoryPath, "utf8")) !== before)
    throw new HomectlError(
      3,
      "Inventory changed concurrently; retry enrollment",
    );
  await saveInventory(inventoryPath, inv);
  return { name, machine: m, os: probe.stdout.trim() };
}
