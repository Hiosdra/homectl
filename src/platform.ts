import { chmod, lstat, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { HomectlError } from "./types";
export const windows = process.platform === "win32";
export function executable(name: string): string {
  if (!windows) return name;
  if (["ssh", "ssh-add", "ssh-keygen"].includes(name))
    return join(
      process.env.SystemRoot ?? "C:\\Windows",
      "System32",
      "OpenSSH",
      `${name}.exe`,
    );
  if (name === "keepassxc-cli")
    return (
      Bun.which(name) ??
      join(
        process.env.ProgramFiles ?? "C:\\Program Files",
        "KeePassXC",
        "keepassxc-cli.exe",
      )
    );
  return name;
}
export function available(name: string) {
  return Boolean(Bun.which(executable(name)));
}
export async function protect(path: string, directory = false) {
  if (!windows) {
    await chmod(path, directory ? 0o700 : 0o600);
    return;
  }
  const script = `$ErrorActionPreference='Stop'; $p=$env:HOMECTL_PROTECT_PATH; $sid=[Security.Principal.WindowsIdentity]::GetCurrent().User; $acl=Get-Acl -LiteralPath $p; if($acl.GetOwner([Security.Principal.SecurityIdentifier]).Value -ne $sid.Value){exit 13}; $acl.SetAccessRuleProtection($true,$false); foreach($r in @($acl.Access)){$acl.RemoveAccessRuleSpecific($r)}; $inherit=if(${directory ? "$true" : "$false"}){[Security.AccessControl.InheritanceFlags]'ContainerInherit,ObjectInherit'}else{[Security.AccessControl.InheritanceFlags]::None}; foreach($owner in @($sid,[Security.Principal.SecurityIdentifier]'S-1-5-18')){$r=[Security.AccessControl.FileSystemAccessRule]::new($owner,'FullControl',$inherit,[Security.AccessControl.PropagationFlags]::None,[Security.AccessControl.AccessControlType]::Allow);$acl.AddAccessRule($r)};Set-Acl -LiteralPath $p -AclObject $acl`;
  const child = Bun.spawn(
    [
      "powershell.exe",
      "-NoProfile",
      "-NonInteractive",
      "-EncodedCommand",
      Buffer.from(script, "utf16le").toString("base64"),
    ],
    {
      env: { ...process.env, HOMECTL_PROTECT_PATH: path },
      stdin: "ignore",
      stdout: "ignore",
      stderr: "ignore",
    },
  );
  const code = await child.exited;
  if (code)
    throw new HomectlError(
      3,
      code === 13
        ? "Private path is owned by another Windows account"
        : "Cannot secure Windows permissions (PowerShell ACL operation failed)",
    );
}
export async function privateDirectory(path: string) {
  await mkdir(path, { recursive: true, mode: 0o700 });
  const s = await lstat(path);
  if (
    !s.isDirectory() ||
    s.isSymbolicLink() ||
    (!windows && s.uid !== process.getuid?.())
  )
    throw new HomectlError(
      3,
      "Private directory must be owned by this user and cannot be a symlink",
    );
  await protect(path, true);
}
