import type { ProcessResult } from "./types";

const ansiColor = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g");

function stripAnsi(value: string) {
  return value.replace(ansiColor, "");
}

function isAacCredentialFailure(value: string) {
  return /mismatched request_id|timeout waiting for credential response|timed out waiting for credential|credential was not injected|vault (?:is )?locked|provider (?:is )?locked|(?:request|approval).*(?:denied|rejected)|user (?:denied|rejected)|(?:credential )?item (?:was )?not found|invalid item id|no such item/i.test(
    stripAnsi(value),
  );
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

  if (isAacCredentialFailure(output))
    return "AAC did not return a credential. In the private provider terminal, make sure the paired `aac listen` is running, unlock it with `/unlock`, and approve this request. A temporary accept-all window may have expired; `bw status` does not confirm AAC's listener state. If the vault item is missing, look it up by its exact name and check the configured item reference before creating another copy. Resolve that state before retrying. No credentials or raw diagnostics are shown.";

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
    return "The host or credential provider could not be reached. Check that the relevant listener/service is available, then verify the inventory address, port and network. No credentials or raw diagnostics are shown.";

  if (
    /permission denied \(|permission denied, please try again|authentication failed|too many authentication failures/.test(
      output,
    )
  )
    return "SSH authentication was rejected. Check the inventory username, selected credential backend and vault item reference; do not print or paste the password. No credentials or raw diagnostics are shown.";

  return "Connectivity failed. Check the SSH alias, address, username, pinned known_hosts fingerprint, credential-provider approval and network. Inventory was not changed, though the generated SSH config may have been refreshed. No credentials or raw diagnostics are shown.";
}

export function provisioningFailureMessage(result: ProcessResult) {
  const output = `${result.stderr}\n${result.stdout}`;
  if (isAacCredentialFailure(output))
    return "AAC did not provide the Proxmox credential. Unlock the paired listener with `/unlock` and approve the request in its private terminal; `bw status` does not confirm AAC readiness. If the vault item is missing, check its exact name and configured reference before creating another copy. Then inspect the provisioning journal and Proxmox tasks before retrying. No rollback was performed and raw provider output is suppressed.";

  return "Proxmox API worker failed; inspect the provisioning journal and provider tasks before retrying. No rollback was performed and raw worker output is suppressed.";
}
