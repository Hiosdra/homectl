// Option checks for `exec` when no broker is connected. The command then runs
// locally, which cannot wait for an owner or use a task, so those options are
// refused or checked here with a plain message instead of an "Unknown option".
import { parseArgs } from "node:util";
import { HomectlError } from "../types";

export function checkLocalExecOptions(cliArgs: string[]): void {
  if (cliArgs.includes("--task"))
    throw new HomectlError(
      2,
      "--task needs the homectl broker. Start it with `home-ctl daemon run` and connect this agent with `home-ctl agent connect`.",
    );
  const { values } = parseArgs({
    args: cliArgs.slice(1),
    allowPositionals: true,
    strict: false,
    options: { wait: { type: "string" } },
  });
  if (values.wait === undefined) return;
  const seconds = Number(values.wait);
  if (!Number.isFinite(seconds) || seconds < 0 || seconds > 600)
    throw new HomectlError(2, "--wait takes 0 to 600 seconds");
}
