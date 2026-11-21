// Reading a password from the private terminal: never echoed, never put in an
// argument or a log, and refused without a terminal, so an agent cannot ask for it.
import { cleanEnv } from "../credentials";
import { windows } from "../platform";
import { HomectlError } from "../types";

// The name of the password a prompt asks for, so an error names the right one:
// the owner password and the vault password are different prompts in the CLI.
export function passwordNoun(prompt: string): string {
  // The vault prompt also says "your owner password", so vault is checked first.
  if (/vault|database/i.test(prompt)) return "vault password";
  if (/owner/i.test(prompt)) return "owner password";
  return "password";
}

export async function readPassword(
  prompt = "KeePassXC database password: ",
): Promise<string> {
  if (!process.stdin.isTTY)
    throw new HomectlError(
      5,
      `Run this command yourself in a private interactive terminal; never send the ${passwordNoun(prompt)} to the agent`,
    );
  const child = Bun.spawn(
    windows
      ? [
          "powershell.exe",
          "-NoProfile",
          "-Command",
          "$p=Read-Host -Prompt $env:HOMECTL_PROMPT -AsSecureString; $b=[Runtime.InteropServices.Marshal]::SecureStringToBSTR($p); try {[Console]::Out.Write([Runtime.InteropServices.Marshal]::PtrToStringBSTR($b))} finally {[Runtime.InteropServices.Marshal]::ZeroFreeBSTR($b)}",
        ]
      : [
          "bash",
          "-c",
          'IFS= read -r -s -p "$1" password </dev/tty || exit 1; printf "\\n" >/dev/tty; printf "%s" "$password"',
          "homectl-password",
          prompt,
        ],
    {
      env: { ...cleanEnv(), HOMECTL_PROMPT: prompt },
      stdin: "inherit",
      stdout: "pipe",
      stderr: "inherit",
    },
  );
  const result = await new Response(child.stdout).text();
  if (
    (await child.exited) ||
    !result ||
    result.includes("\n") ||
    result.includes("\r")
  )
    throw new HomectlError(
      2,
      "Password entry cancelled or unsupported newline",
    );
  return result;
}
