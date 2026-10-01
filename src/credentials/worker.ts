// Managed SSH boundary: checks session expiry; never opens the password database.
import { run } from "../process";
import { sessionStatus } from "../session";
import { HomectlError, type ProcessSpec } from "../types";

try {
  const spec = JSON.parse(await Bun.stdin.text()) as ProcessSpec;
  const socket = spec.env?.SSH_AUTH_SOCK;
  if (spec.argv[0] !== "ssh" || !socket?.endsWith(".session/agent.sock"))
    throw new HomectlError(
      2,
      "Managed key worker only supports OpenSSH with the dedicated session socket",
    );
  const inventoryPath = socket.slice(0, -".session/agent.sock".length);
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
