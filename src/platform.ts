import { chmod, lstat, mkdir, rename, unlink } from "node:fs/promises";
import { join } from "node:path";
import { HomectlError } from "./types";
export const windows = process.platform === "win32";

export async function atomicReplace(source: string, destination: string) {
  for (let attempt = 0; ; attempt++) {
    try {
      await rename(source, destination);
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      const retryable =
        windows && ["EPERM", "EACCES", "EBUSY"].includes(code ?? "");
      if (!retryable || attempt >= 10) {
        await unlink(source).catch(() => undefined);
        throw error;
      }
      await Bun.sleep(Math.min(25 * (attempt + 1), 200));
    }
  }
}

export function executable(name: string): string {
  if (!windows) return name;
  if (["ssh", "ssh-add", "ssh-keygen", "ssh-keyscan"].includes(name))
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
$pp=$env:HOMECTL_PROTECT_PATH
try {
  $p=$pp
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
} catch {
  # The .NET exception under PowerShell's wrapper: its type, HRESULT and message.
  # The private path is replaced first, so no path leaves the script.
  $e=$_.Exception
  if($e.InnerException){$e=$e.InnerException}
  $m=[string]$e.Message
  if($pp){$m=$m.Replace($pp,'<private path>')}
  if($m.Length -gt 300){$m=$m.Substring(0,300)}
  [Console]::Out.Write($e.GetType().Name + '|' + ('0x{0:X8}' -f $e.HResult) + '|' + $m)
  exit 1
}
`;
  let attempt = await runAclScript(script, path);
  for (const delay of ACL_RETRY_MS) {
    if (attempt.code === 0 || !aclFailure(attempt.diagnostic).transient) break;
    await Bun.sleep(delay);
    attempt = await runAclScript(script, path);
  }
  if (attempt.code)
    throw new HomectlError(
      3,
      attempt.code === 13
        ? "Private path is owned by another Windows account"
        : `Cannot secure Windows permissions (PowerShell ACL operation failed: ${aclFailure(attempt.diagnostic).message})`,
    );
}

// Bounded retries for a sharing or lock violation: another PowerShell run may hold
// the file for a moment. Any other failure is reported at once.
const ACL_RETRY_MS = [150, 400];
const TRANSIENT_HRESULTS = new Set(["0x80070020", "0x80070021"]);

// C0 control characters and DEL, which a diagnostic must not carry into a message.
function isControl(char: string): boolean {
  const code = char.charCodeAt(0);
  return code < 32 || code === 127;
}

// One run of an ACL script. The diagnostic is what the script wrote on stdout.
async function runAclScript(
  script: string,
  path: string,
): Promise<{ code: number; diagnostic: string }> {
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
      windowsHide: true,
    },
  );
  const [code, diagnostic] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
  ]);
  return { code, diagnostic };
}

// Reads the script's diagnostic, "Type|0xHRESULT|message". The message is kept
// (the private path was replaced inside the script), with control characters and
// extra spaces removed and a length cap. Text that is not an exception type name
// is "unknown error".
export function aclFailure(diagnostic: string): {
  message: string;
  transient: boolean;
} {
  const [type = "", hresult = "", ...rest] = diagnostic.split("|");
  if (!/^[A-Za-z]+Exception$/.test(type))
    return { message: "unknown error", transient: false };
  const text = rest
    .join("|")
    .split("")
    .map((char) => (isControl(char) ? " " : char))
    .join("")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 200);
  return {
    message: text ? `${type}: ${text}` : type,
    transient: TRANSIENT_HRESULTS.has(hresult),
  };
}

export async function ownedByCurrentUser(path: string): Promise<boolean> {
  try {
    const metadata = await lstat(path);
    if (metadata.isSymbolicLink()) return false;
    if (!windows) return metadata.uid === process.getuid?.();
  } catch {
    return false;
  }
  const script = `$ErrorActionPreference='Stop'
try {
  $p=$env:HOMECTL_PROTECT_PATH
  $identity=[System.Security.Principal.WindowsIdentity]::GetCurrent()
  $sid=$identity.User
  $acl=Get-Acl -LiteralPath $p
  $owner=$acl.GetOwner([System.Security.Principal.SecurityIdentifier]).Value
  if($owner -eq $sid.Value -or $owner -eq $identity.Owner.Value){exit 0}else{exit 13}
} catch { exit 1 }
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
      stdout: "ignore",
      stderr: "ignore",
      windowsHide: true,
    },
  );
  return (await child.exited) === 0;
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
