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
  const script = `$ErrorActionPreference='Stop'; $p=[Console]::In.ReadToEnd(); $sid=[Security.Principal.WindowsIdentity]::GetCurrent().User; $acl=Get-Acl -LiteralPath $p; if($acl.GetOwner([Security.Principal.SecurityIdentifier]).Value -ne $sid.Value){exit 3}; $acl.SetAccessRuleProtection($true,$false); foreach($r in @($acl.Access)){$acl.RemoveAccessRuleSpecific($r)}; $inherit=if(${directory ? "$true" : "$false"}){[Security.AccessControl.InheritanceFlags]'ContainerInherit,ObjectInherit'}else{[Security.AccessControl.InheritanceFlags]::None}; foreach($owner in @($sid,[Security.Principal.SecurityIdentifier]'S-1-5-18')){$r=New-Object Security.AccessControl.FileSystemAccessRule($owner,'FullControl',$inherit,[Security.AccessControl.PropagationFlags]::None,[Security.AccessControl.AccessControlType]::Allow);$acl.AddAccessRule($r)};Set-Acl -LiteralPath $p -AclObject $acl`;
  const child = Bun.spawn(
    ["powershell.exe", "-NoProfile", "-NonInteractive", "-Command", script],
    { stdin: new Blob([path]), stdout: "ignore", stderr: "ignore" },
  );
  if (await child.exited)
    throw new HomectlError(
      3,
      "Cannot secure Windows permissions or path is owned by another account",
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
