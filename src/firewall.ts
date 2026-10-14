import { isIP } from "node:net";
import { networkInterfaces } from "node:os";
import { windows } from "./platform";
import { privileged, windowsAdministrator } from "./privileged";
import { run } from "./process";
import { HomectlError } from "./types";
export function selectedLAN(ip: string) {
  if (
    isIP(ip) !== 4 ||
    !/^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(ip)
  )
    throw new HomectlError(2, "Select a private LAN IPv4 address");
  for (const [name, addresses] of Object.entries(networkInterfaces()))
    for (const address of addresses ?? [])
      if (
        address.address === ip &&
        address.family === "IPv4" &&
        !address.internal
      ) {
        const mask = address.netmask.split(".").map(Number);
        const prefix = mask
          .map((n) => n.toString(2))
          .join("")
          .replaceAll("0", "").length;
        if (prefix < 8 || prefix > 30)
          throw new HomectlError(
            2,
            "Unsupported LAN subnet for firewall setup",
          );
        return {
          ip,
          name,
          subnet: `${ip
            .split(".")
            .map((n, i) => Number(n) & (mask[i] ?? 0))
            .join(".")}/${prefix}`,
        };
      }
  throw new HomectlError(
    2,
    "Selected LAN address is not assigned to this computer",
  );
}
export function firewallRules(subnet: string, ip: string) {
  return [
    `rule family="ipv4" source address="${subnet}" destination address="224.0.0.251" port port="5353" protocol="udp" accept`,
    `rule family="ipv4" source address="${subnet}" destination address="${ip}" port port="7448" protocol="tcp" accept`,
  ];
}
export async function firewallPlan(ip: string) {
  const lan = selectedLAN(ip);
  if (windows)
    return {
      ...lan,
      backend: "windows",
      actions: [
        `Allow Bun UDP 5353 and TCP 7448 from ${lan.subnet}, Private profile only`,
      ],
      commands: [] as string[][],
    };
  if (Bun.which("firewall-cmd")) {
    const active = await run({
      argv: ["firewall-cmd", "--state"],
      timeoutMs: 5000,
    });
    if (
      active.exitCode !== 0 &&
      active.stdout.trim() !== "not running" &&
      !active.stderr.includes("not running")
    )
      throw new HomectlError(
        5,
        "Cannot inspect firewalld (access denied or timeout). Run setup in a local terminal with access to the system D-Bus; no firewall rules were changed.",
      );
    if (active.exitCode === 0) {
      const zoneResult = await run({
        argv: ["firewall-cmd", "--get-zone-of-interface", lan.name],
        timeoutMs: 5000,
      });
      let zone = zoneResult.stdout.trim();
      if (!zone || zone === "no zone")
        zone = (
          await run({ argv: ["firewall-cmd", "--get-default-zone"] })
        ).stdout.trim();
      if (!/^[\w-]+$/.test(zone))
        throw new HomectlError(5, "Cannot determine the firewalld zone");
      const commands = firewallRules(lan.subnet, ip).flatMap((rule) => [
        ["firewall-cmd", `--zone=${zone}`, `--add-rich-rule=${rule}`],
        [
          "firewall-cmd",
          "--permanent",
          `--zone=${zone}`,
          `--add-rich-rule=${rule}`,
        ],
      ]);
      return {
        ...lan,
        backend: "firewalld",
        actions: [
          `Allow multicast UDP 5353 and peer TCP 7448 from ${lan.subnet} in zone ${zone} (runtime and permanent)`,
        ],
        commands,
      };
    }
  }
  if (Bun.which("ufw"))
    return {
      ...lan,
      backend: "ufw",
      actions: [
        `Add scoped UFW rules for ${lan.name}; do not enable or disable the firewall`,
      ],
      commands: [
        [
          "ufw",
          "allow",
          "in",
          "on",
          lan.name,
          "from",
          lan.subnet,
          "to",
          "224.0.0.251",
          "port",
          "5353",
          "proto",
          "udp",
        ],
        [
          "ufw",
          "allow",
          "in",
          "on",
          lan.name,
          "from",
          lan.subnet,
          "to",
          ip,
          "port",
          "7448",
          "proto",
          "tcp",
        ],
      ],
    };
  return {
    ...lan,
    backend: "unsupported",
    actions: [
      "No supported active firewalld or installed UFW detected; firewall rules were not changed",
    ],
    commands: [] as string[][],
  };
}
export async function configureFirewall(
  plan: Awaited<ReturnType<typeof firewallPlan>>,
  interactive: boolean,
) {
  if (plan.backend === "unsupported")
    throw new HomectlError(5, plan.actions[0] ?? "Unsupported firewall");
  if (plan.backend === "windows") {
    const quote = (value: string) => `'${value.replaceAll("'", "''")}'`;
    const script = `$ErrorActionPreference='Stop';try{Import-Module NetSecurity;foreach($proto in @('UDP','TCP')){$port=if($proto -eq 'UDP'){5353}else{7448};$name='homectl-'+${quote(plan.ip)}+'-'+$proto;Get-NetFirewallRule -Name $name -ErrorAction SilentlyContinue | Remove-NetFirewallRule;New-NetFirewallRule -Name $name -DisplayName $name -Direction Inbound -Action Allow -Enabled True -Profile Private -Program ${quote(process.execPath)} -Protocol $proto -LocalPort $port -LocalAddress $(if($proto -eq 'UDP'){'224.0.0.251'}else{${quote(plan.ip)}}) -RemoteAddress ${quote(plan.subnet)} | Out-Null};exit 0}catch{exit 1}`;
    await windowsAdministrator(script, interactive);
  } else
    for (const command of plan.commands) await privileged(command, interactive);
  return {
    configured: true,
    interface: plan.ip,
    backend: plan.backend,
    actions: plan.actions,
  };
}
