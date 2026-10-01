import type { ProcessResult } from "./types";

const ansiColor = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g");

function stripAnsi(value: string) {
  return value.replace(ansiColor, "");
}

export function unameValue(stdout: string) {
  const values = stripAnsi(stdout)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => /^[A-Za-z][A-Za-z0-9._+/-]{0,63}$/.test(line));
  return values.at(-1);
}

export function probeFailureMessage(result?: ProcessResult) {
  if (!result)
    return "Could not start the connectivity probe. Check that the required local client is installed, then run homectl doctor again. No credentials or raw diagnostics are shown.";

  const output = stripAnsi(`${result.stderr}\n${result.stdout}`).toLowerCase();

  if (
    /could not chdir to home directory.*no such file or directory/.test(output)
  )
    return "The SSH account has no home directory. On UGREEN UGOS Pro, enable Personal Folder in Control Panel > User; do not remove immutable protection from /home. Have the administrator verify home ownership and permissions before installing the public key.";

  if (/homectl ssh session (?:is locked|expired)/.test(output))
    return "The homectl SSH session is locked or expired. Run `homectl session unlock` in your private terminal, then retry.";

  if (
    /remote host identification has changed|host key verification failed|offending .* key/.test(
      output,
    )
  )
    return "SSH rejected the host key. Verify its fingerprint through a trusted console or source before changing known_hosts; do not trust a keyscan result by itself. No credentials or raw diagnostics are shown.";

  if (
    /could not resolve hostname|name or service not known|temporary failure in name resolution|getaddrinfo/.test(
      output,
    )
  )
    return "The host name did not resolve. Check the inventory address and the agent host's DNS/network. No credentials or raw diagnostics are shown.";

  if (
    /connection timed out|operation timed out|no route to host|network is unreachable|connection refused/.test(
      output,
    )
  )
    return "The SSH host could not be reached. Verify the inventory address, port and network. No credentials or raw diagnostics are shown.";

  if (
    /permission denied \(|permission denied, please try again|authentication failed|too many authentication failures/.test(
      output,
    )
  )
    return "SSH authentication was rejected. Check the inventory username, managed session and installed public key; run session unlock privately if needed. No credentials or raw diagnostics are shown.";

  return "Connectivity failed. Check the SSH alias, address, username, pinned known_hosts fingerprint, managed SSH session and network. Inventory was not changed, though the generated SSH config may have been refreshed. No credentials or raw diagnostics are shown.";
}

export function provisioningFailureMessage(result: ProcessResult) {
  return `Proxmox SSH operation failed. ${probeFailureMessage(result)} Inspect the provisioning journal and provider tasks before retrying. No rollback was performed.`;
}
