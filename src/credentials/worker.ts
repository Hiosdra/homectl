// Private process boundary. Never invoke through an agent with secret literals.
import { resolve } from "node:path";
import { run } from "../process";
import { type ProvisionPlan, proxmox } from "../provisioners";
import { proxmoxAPI } from "../provisioners/api";
import { HomectlError, type ProcessSpec, type ProviderConfig } from "../types";
import { cleanEnv, redactor } from "./index";

const mode = process.argv[2];
const secret =
  process.env[mode === "ssh" ? "HOMECTL_SSH_PASSWORD" : "HOMECTL_API_TOKEN"] ??
  "";
const redact = redactor([secret]);
try {
  if (!secret) throw new HomectlError(5, "Credential was not injected");
  const payload = JSON.parse(await Bun.stdin.text());
  if (mode === "ssh") {
    const spec = payload as ProcessSpec;
    if (spec.argv[0] !== "ssh")
      throw new HomectlError(2, "Credential worker only supports OpenSSH");
    const args = spec.argv.map((a) =>
      a === "BatchMode=yes" ? "BatchMode=no" : a,
    );
    args.splice(
      1,
      0,
      "-o",
      "PreferredAuthentications=password",
      "-o",
      "PubkeyAuthentication=no",
      "-o",
      "NumberOfPasswordPrompts=1",
    );
    const result = await run({
      ...spec,
      argv: args,
      env: {
        ...cleanEnv(),
        HOMECTL_SSH_PASSWORD: secret,
        SSH_ASKPASS: resolve(import.meta.dir, "askpass.sh"),
        SSH_ASKPASS_REQUIRE: "force",
        DISPLAY: "homectl-askpass",
      },
    });
    process.stdout.write(redact(result.stdout));
    process.stderr.write(redact(result.stderr));
    process.exitCode = result.exitCode;
  } else if (mode === "proxmox") {
    const { config, plan, stateDir } = payload as {
      config: ProviderConfig;
      plan: ProvisionPlan;
      stateDir: string;
    };
    await proxmox.apply(plan, proxmoxAPI(config, secret), stateDir);
    console.log(JSON.stringify({ ok: true, vmid: plan.request.vmid }));
  } else throw new HomectlError(2, "Unknown credential worker mode");
} catch (e) {
  console.error(
    redact(
      e instanceof HomectlError
        ? e.message
        : "Credential worker failed; diagnostic details suppressed",
    ),
  );
  process.exitCode = e instanceof HomectlError ? e.code : 5;
}
