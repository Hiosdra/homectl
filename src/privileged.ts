import { cleanEnv } from "./credentials";
import { run } from "./process";
import { HomectlError } from "./types";
export async function privileged(argv: string[], interactive: boolean) {
  const command =
    process.getuid?.() === 0
      ? argv
      : ["sudo", ...(interactive ? [] : ["-n"]), ...argv];
  if (!interactive) {
    const result = await run({ argv: command, timeoutMs: 900_000 });
    if (result.exitCode)
      throw new HomectlError(
        5,
        "Administrator operation failed; run with the required privileges. No password prompt is used in JSON mode.",
      );
    return;
  }
  const child = Bun.spawn(command, {
    env: cleanEnv(),
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  });
  if (await child.exited)
    throw new HomectlError(
      5,
      "Administrator operation failed or was cancelled",
    );
}
export async function windowsAdministrator(
  script: string,
  interactive: boolean,
) {
  const encoded = Buffer.from(script, "utf16le").toString("base64");
  const outer = interactive
    ? `$ErrorActionPreference='Stop';try{$p=Start-Process "$env:SystemRoot\\System32\\WindowsPowerShell\\v1.0\\powershell.exe" -Verb RunAs -ArgumentList '-NoProfile','-NonInteractive','-EncodedCommand','${encoded}' -Wait -PassThru;exit $p.ExitCode}catch{exit 1}`
    : script;
  const child = Bun.spawn(
    [
      "powershell.exe",
      "-NoProfile",
      "-NonInteractive",
      "-EncodedCommand",
      Buffer.from(outer, "utf16le").toString("base64"),
    ],
    { env: cleanEnv(), stdin: "ignore", stdout: "ignore", stderr: "ignore" },
  );
  if (await child.exited)
    throw new HomectlError(
      5,
      "Windows administrator operation failed or UAC was cancelled; JSON mode requires an already elevated terminal",
    );
}
