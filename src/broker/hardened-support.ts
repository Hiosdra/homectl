// What hardened broker mode means on each platform, for status output (homelab #21, P1).
// Only Linux with systemd is built and verified (see install.ts and the B1 check); the other
// platforms say so plainly and keep running the broker in compatibility mode.
export interface HardenedSupport {
  platform: NodeJS.Platform;
  supported: boolean;
  statement: string;
}

export function hardenedSupport(
  platform: NodeJS.Platform,
  systemd: boolean,
): HardenedSupport {
  if (platform === "linux")
    return systemd
      ? {
          platform,
          supported: true,
          statement:
            "Hardened mode is supported: a systemd service under a dedicated homectl account. Verified by the Linux CI check (real OS users).",
        }
      : {
          platform,
          supported: false,
          statement:
            "Hardened mode needs systemd, which is not running here. Compatibility mode runs as your user and is weaker.",
        };
  if (platform === "win32")
    return {
      platform,
      supported: false,
      statement:
        "Hardened mode is not available on Windows yet (a dedicated service account is planned). Compatibility mode runs as your user and is weaker.",
    };
  if (platform === "darwin")
    return {
      platform,
      supported: false,
      statement:
        "Hardened mode is not available on macOS yet (a launchd daemon is planned). Compatibility mode runs as your user and is weaker.",
    };
  return {
    platform,
    supported: false,
    statement: `Hardened mode is not available on ${platform}.`,
  };
}
