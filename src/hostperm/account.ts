// Account model planning. Pure: returns argv for the owner to approve; never
// sets passwords and never touches sshd_config.
import type { AccountModel, AccountPlan, Platform } from "./types";
import { USER_RE } from "./util";

export function planAccount(
  model: AccountModel,
  platform: Platform,
  options: { user: string },
): AccountPlan {
  const { user } = options;
  if (!USER_RE.test(user))
    return {
      supported: false,
      steps: [],
      reasons: [
        "invalid account name: use lowercase letters, digits, '_' or '-'",
      ],
    };
  if (user === "root")
    return {
      supported: false,
      steps: [],
      reasons: [
        "root is not managed: a root SSH account already has root authority",
      ],
    };

  if (model === "existing-admin") {
    const reasons = [
      "uses an existing administrative account; no account changes",
    ];
    const supported = platform.os !== "unknown" && platform.canSudo;
    if (!platform.canSudo)
      reasons.push(
        "sudo -n is unavailable for this account; privileged steps cannot run",
      );
    return { supported, steps: [], reasons };
  }

  if (model === "existing-restricted") {
    const reasons = [
      "uses an existing restricted account; any administrative access needs a separately approved sudoers drop-in",
    ];
    const supported = platform.supports.authorizedKeys;
    if (!supported)
      reasons.push(
        "authorized_keys management is unavailable on this platform",
      );
    return { supported, steps: [], reasons };
  }

  if (!platform.supports.dedicatedAccount)
    return {
      supported: false,
      steps: [],
      reasons: [
        "dedicated accounts are unsupported here (requires a recognised Linux distribution with useradd, sudo -n and no appliance restrictions)",
        ...platform.reasons,
      ],
    };
  return {
    supported: true,
    steps: [
      {
        id: "create-account",
        argv: [
          "sudo",
          "-n",
          "useradd",
          "--create-home",
          "--shell",
          "/bin/sh",
          user,
        ],
        purpose: "create a dedicated account without a password",
      },
    ],
    reasons: [
      "the account must not already exist; check before running the step",
      "no password is set and sshd_config is not changed",
    ],
  };
}
