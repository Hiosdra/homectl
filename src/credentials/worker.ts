// Managed SSH boundary: checks session expiry; never opens the password database.
import { executable } from "../platform";
import { run } from "../process";
import { sessionStatus } from "../session";
import { sessionPaths } from "../session/config";
import { HomectlError, type ProcessSpec } from "../types";

try {
  const spec = JSON.parse(await Bun.stdin.text()) as ProcessSpec & {
    managedInventory?: string;
  };
  const socket = spec.env?.SSH_AUTH_SOCK;
  const inventoryPath =
    spec.managedInventory ??
    (socket?.endsWith(".session/agent.sock")
      ? socket.slice(0, -".session/agent.sock".length)
      : "");
  if (
    spec.argv[0] !== executable("ssh") ||
    !inventoryPath ||
    socket !== sessionPaths(inventoryPath).socket
  )
    throw new HomectlError(
      2,
      "Managed worker only supports OpenSSH with the inventory's dedicated SSH agent",
    );
  if (!(await sessionStatus(inventoryPath)).unlocked)
    throw new HomectlError(
      5,
      "homectl SSH session is locked; run homectl session unlock privately",
    );
  const result = await run(spec);
  process.stdout.write(result.stdout);
  process.stderr.write(result.stderr);
  process.exitCode = result.exitCode;
} catch (e) {
  console.error(
    e instanceof HomectlError
      ? e.message
      : "SSH worker failed; diagnostic details suppressed",
  );
  process.exitCode = e instanceof HomectlError ? e.code : 5;
}
