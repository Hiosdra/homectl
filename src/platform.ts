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
  const script = `$ErrorActionPreference='Stop'
try {
  $p=$env:HOMECTL_PROTECT_PATH
  $identity=[System.Security.Principal.WindowsIdentity]::GetCurrent()
  $sid=$identity.User
  $old=if(${directory ? "$true" : "$false"}){[System.IO.Directory]::GetAccessControl($p)}else{[System.IO.File]::GetAccessControl($p)}
  $owner=$old.GetOwner([System.Security.Principal.SecurityIdentifier]).Value
  if($owner -ne $sid.Value -and $owner -ne $identity.Owner.Value){exit 13}
  $acl=if(${directory ? "$true" : "$false"}){[System.Security.AccessControl.DirectorySecurity]::new()}else{[System.Security.AccessControl.FileSecurity]::new()}
  $acl.SetOwner($sid)
  $acl.SetAccessRuleProtection($true,$false)
  $inherit=if(${directory ? "$true" : "$false"}){[System.Security.AccessControl.InheritanceFlags]3}else{[System.Security.AccessControl.InheritanceFlags]0}
  $identities=@($sid; [System.Security.Principal.SecurityIdentifier]::new('S-1-5-18'))
  foreach($identity in $identities){
    $rule=[System.Security.AccessControl.FileSystemAccessRule]::new($identity,[System.Security.AccessControl.FileSystemRights]::FullControl,$inherit,[System.Security.AccessControl.PropagationFlags]::None,[System.Security.AccessControl.AccessControlType]::Allow)
    $acl.AddAccessRule($rule)
  }
  if(${directory ? "$true" : "$false"}){[System.IO.Directory]::SetAccessControl($p,$acl)}else{[System.IO.File]::SetAccessControl($p,$acl)}
} catch { [Console]::Out.Write($_.Exception.GetType().Name); exit 1 }
`;
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
      stdout: "pipe",
      stderr: "ignore",
    },
  );
  const [code, diagnostic] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
  ]);
  if (code)
    throw new HomectlError(
      3,
      code === 13
        ? "Private path is owned by another Windows account"
        : `Cannot secure Windows permissions (PowerShell ACL operation failed: ${/^[A-Za-z]+Exception$/.test(diagnostic) ? diagnostic : "unknown error"})`,
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
