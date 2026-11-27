// Hardened Windows service installation plan (Virtual Service Account
// NT SERVICE\homectl + ACL'd %ProgramData%\homectl\state + native ServiceBase
// host compiled with built-in csc.exe). All ACLs use well-known SIDs so they
// work identically on non-English Windows installations.
import { join } from "node:path";
import type { InstallPlan, InstallStep } from "./install";
import { CUSTODY_FILES } from "./install";
import { hardenedPaths } from "./paths";
import {
  DEFAULT_WINDOWS_PANEL_ORIGIN,
  serializeWindowsServiceConfig,
  WINDOWS_SERVICE_ACCOUNT,
  WINDOWS_SERVICE_DESCRIPTION,
  WINDOWS_SERVICE_DISPLAY,
  WINDOWS_SERVICE_HOST_CS,
  WINDOWS_SERVICE_NAME,
  windowsCscPath,
} from "./windows-service-host";

const SID_SYSTEM = "*S-1-5-18";
const SID_ADMINS = "*S-1-5-32-544";
const SID_USERS = "*S-1-5-32-545";

function psEncoded(script: string): string[] {
  return [
    "powershell.exe",
    "-NoProfile",
    "-NonInteractive",
    "-EncodedCommand",
    Buffer.from(script, "utf16le").toString("base64"),
  ];
}

function psQuote(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

export function isWindowsAdmin(): boolean {
  const check = Bun.spawnSync(
    [
      "powershell.exe",
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      "exit ([int](-not ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)))",
    ],
    { stdin: "ignore", stdout: "ignore", stderr: "ignore", windowsHide: true },
  );
  return check.exitCode === 0;
}

export function windowsElevationNotice(
  action: "install" | "uninstall",
): string {
  if (action === "uninstall")
    return [
      "Administrator permission is needed once to stop and remove the homectl Windows service.",
      "Your vault and workspace data under %ProgramData%\\homectl\\state will be kept.",
    ].join("\n");
  return [
    `Hardened mode runs homectl as an isolated Windows service (${WINDOWS_SERVICE_ACCOUNT})`,
    "so AI agents running under your user account cannot read your vault, keys, or state.",
    "",
    "Administrator permission is needed once to:",
    `  1. Register the ${WINDOWS_SERVICE_NAME} Windows service under ${WINDOWS_SERVICE_ACCOUNT}`,
    "  2. Lock down %ProgramData%\\homectl\\state so only the service account can read it",
    "  3. Copy your workspace files into service custody (your originals stay untouched)",
    "",
    "After installation, homectl runs under the unprivileged virtual service account — not as an administrator.",
  ].join("\n");
}

export function buildWindowsElevationScript(argv: string[]): string {
  const [exe = process.execPath, ...rest] = argv;
  const argArray = rest.map(psQuote).join(", ");
  return `$ErrorActionPreference='Continue'
$exe = ${psQuote(exe)}
$argsList = @(${argArray})
& $exe @argsList
$code = $LASTEXITCODE
if ($code -ne 0) {
  Write-Host ''
  Read-Host 'Press Enter to close'
}
exit $code`;
}

export function runElevatedWindows(argv: string[]): {
  exitCode: number;
  cancelled: boolean;
} {
  const inner = Buffer.from(
    buildWindowsElevationScript(argv),
    "utf16le",
  ).toString("base64");
  const launcher = `$ErrorActionPreference='Stop'
try {
  $p = Start-Process -FilePath 'powershell.exe' -ArgumentList @('-NoProfile','-EncodedCommand',${psQuote(inner)}) -Verb RunAs -Wait -PassThru
  exit $p.ExitCode
} catch [System.ComponentModel.Win32Exception] {
  if ($_.Exception.NativeErrorCode -eq 1223) { exit 1223 }
  [Console]::Error.WriteLine($_.Exception.Message)
  exit 1
} catch {
  [Console]::Error.WriteLine($_.Exception.Message)
  exit 1
}`;
  const result = Bun.spawnSync(psEncoded(launcher), {
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  });
  return {
    exitCode: result.exitCode,
    cancelled: result.exitCode === 1223,
  };
}

function writeTextStep(
  description: string,
  targetPath: string,
  content: string,
): InstallStep {
  return {
    description,
    argv: psEncoded(
      `$ErrorActionPreference='Stop'; [System.IO.File]::WriteAllText(${psQuote(targetPath)}, [Console]::In.ReadToEnd(), [System.Text.UTF8Encoding]::new($false))`,
    ),
    stdin: content,
  };
}

export function windowsOwnershipStep(
  targetPath: string,
  recursive = false,
): InstallStep {
  return {
    description: `Give ${WINDOWS_SERVICE_ACCOUNT} ownership of ${targetPath}`,
    argv: [
      "icacls.exe",
      targetPath,
      "/setowner",
      WINDOWS_SERVICE_ACCOUNT,
      ...(recursive ? ["/T", "/C"] : []),
    ],
  };
}

export function windowsStartStep(): InstallStep {
  return {
    description: `Start the ${WINDOWS_SERVICE_NAME} Windows service`,
    argv: ["sc.exe", "start", WINDOWS_SERVICE_NAME],
  };
}

export function windowsPlan(options: {
  executable: string[];
  workspace: string;
  cscPath?: string;
  panelOrigin?: string;
}): InstallPlan {
  const paths = hardenedPaths("win32");
  const runtime = paths.runtime;
  const binDir = join(runtime, "bin");
  const state = paths.state;
  const workspace = join(state, "workspace");
  const csc = options.cscPath ?? windowsCscPath();
  const serviceCs = join(binDir, "homectl-service.cs");
  const serviceExe = join(binDir, "homectl-service.exe");
  const serviceConf = join(binDir, "service.conf");

  // Compiled release binary: copy into admin-only binDir so the service never
  // executes from a user-writable folder. Source checkout: run bun + main.ts.
  const isCompiled = options.executable.length === 1;
  const installedExe = isCompiled
    ? join(binDir, "home-ctl.exe")
    : (options.executable[0] ?? process.execPath);
  const serviceArgs = [
    ...options.executable.slice(1),
    "daemon",
    "run",
    "--mode",
    "hardened",
  ];
  const confText = serializeWindowsServiceConfig({
    executable: installedExe,
    args: serviceArgs,
    state,
    endpoint: paths.endpoint,
    panelOrigin: options.panelOrigin ?? DEFAULT_WINDOWS_PANEL_ORIGIN,
    log: join(state, "service.log"),
  });

  const steps: InstallStep[] = [
    {
      description: `Stop existing ${WINDOWS_SERVICE_NAME} service if running`,
      argv: ["sc.exe", "stop", WINDOWS_SERVICE_NAME],
      ignoreFailure: true,
    },
    {
      description: `Create hardened broker directories under ${runtime}`,
      argv: psEncoded(
        `$ErrorActionPreference='Stop'; foreach ($d in @(${psQuote(runtime)}, ${psQuote(binDir)}, ${psQuote(state)}, ${psQuote(workspace)})) { New-Item -ItemType Directory -Force -Path $d | Out-Null }`,
      ),
    },
    ...(isCompiled
      ? [
          {
            description: `Copy homectl binary into admin-only ${binDir}`,
            argv: psEncoded(
              `$ErrorActionPreference='Stop'; Copy-Item -LiteralPath ${psQuote(options.executable[0] ?? process.execPath)} -Destination ${psQuote(installedExe)} -Force`,
            ),
          },
        ]
      : []),
    writeTextStep(
      `Write Windows service host source (${serviceCs})`,
      serviceCs,
      WINDOWS_SERVICE_HOST_CS,
    ),
    writeTextStep(
      `Write Windows service configuration (${serviceConf})`,
      serviceConf,
      confText,
    ),
    {
      description: `Compile ${serviceExe} with .NET csc.exe`,
      argv: [
        csc,
        "/nologo",
        "/target:exe",
        "/optimize+",
        "/reference:System.ServiceProcess.dll",
        `/out:${serviceExe}`,
        serviceCs,
      ],
    },
    {
      description: `Register Windows service ${WINDOWS_SERVICE_NAME} as ${WINDOWS_SERVICE_ACCOUNT}`,
      argv: [
        "sc.exe",
        "create",
        WINDOWS_SERVICE_NAME,
        "binPath=",
        `"${serviceExe}"`,
        "start=",
        "auto",
        "obj=",
        WINDOWS_SERVICE_ACCOUNT,
        "DisplayName=",
        WINDOWS_SERVICE_DISPLAY,
      ],
      skipIf: ["sc.exe", "query", WINDOWS_SERVICE_NAME],
    },
    {
      description: `Configure ${WINDOWS_SERVICE_NAME} service binary and virtual service account`,
      argv: [
        "sc.exe",
        "config",
        WINDOWS_SERVICE_NAME,
        "binPath=",
        `"${serviceExe}"`,
        "start=",
        "auto",
        "obj=",
        WINDOWS_SERVICE_ACCOUNT,
        "DisplayName=",
        WINDOWS_SERVICE_DISPLAY,
      ],
    },
    {
      description: `Set ${WINDOWS_SERVICE_NAME} service description`,
      argv: [
        "sc.exe",
        "description",
        WINDOWS_SERVICE_NAME,
        WINDOWS_SERVICE_DESCRIPTION,
      ],
    },
    {
      description: `Enable unrestricted Service SID for ${WINDOWS_SERVICE_ACCOUNT}`,
      argv: ["sc.exe", "sidtype", WINDOWS_SERVICE_NAME, "unrestricted"],
    },
    {
      description: `Configure automatic restart on failure for ${WINDOWS_SERVICE_NAME}`,
      argv: [
        "sc.exe",
        "failure",
        WINDOWS_SERVICE_NAME,
        "reset=",
        "86400",
        "actions=",
        "restart/5000/restart/5000/restart/5000",
      ],
    },
    ...CUSTODY_FILES.map((name) => {
      const src = join(options.workspace, name);
      const dst = join(workspace, name);
      return {
        description: `Copy ${name} into broker custody`,
        argv: psEncoded(
          `$ErrorActionPreference='Stop'; if ((Test-Path -LiteralPath ${psQuote(src)}) -and -not (Test-Path -LiteralPath ${psQuote(dst)})) { Copy-Item -LiteralPath ${psQuote(src)} -Destination ${psQuote(dst)} -Recurse }`,
        ),
      };
    }),
    {
      description: `Restrict ${runtime} (public endpoint read, service + admins write)`,
      argv: [
        "icacls.exe",
        runtime,
        "/inheritance:r",
        "/grant:r",
        `${SID_SYSTEM}:(OI)(CI)F`,
        `${SID_ADMINS}:(OI)(CI)F`,
        `${WINDOWS_SERVICE_ACCOUNT}:(OI)(CI)F`,
        `${SID_USERS}:(OI)(CI)RX`,
      ],
    },
    {
      description: `Lock down ${binDir} (admins write, ${WINDOWS_SERVICE_ACCOUNT} read/execute)`,
      argv: [
        "icacls.exe",
        binDir,
        "/inheritance:r",
        "/grant:r",
        `${SID_SYSTEM}:(OI)(CI)F`,
        `${SID_ADMINS}:(OI)(CI)F`,
        `${WINDOWS_SERVICE_ACCOUNT}:(OI)(CI)RX`,
      ],
    },
    {
      description: `Lock down ${state} (${WINDOWS_SERVICE_ACCOUNT}, SYSTEM and Administrators only)`,
      argv: [
        "icacls.exe",
        state,
        "/inheritance:r",
        "/grant:r",
        `${WINDOWS_SERVICE_ACCOUNT}:(OI)(CI)F`,
        `${SID_SYSTEM}:(OI)(CI)F`,
        `${SID_ADMINS}:(OI)(CI)F`,
      ],
    },
    windowsOwnershipStep(state, true),
    windowsStartStep(),
  ];

  return {
    platform: "win32",
    supported: true,
    reasons: [],
    steps,
    imports: CUSTODY_FILES.map((name) => join(options.workspace, name)),
  };
}

export function windowsUninstallPlan(): InstallStep[] {
  const paths = hardenedPaths("win32");
  const binDir = join(paths.runtime, "bin");
  return [
    {
      description: `Stop the ${WINDOWS_SERVICE_NAME} Windows service`,
      argv: ["sc.exe", "stop", WINDOWS_SERVICE_NAME],
      ignoreFailure: true,
    },
    {
      description: `Delete the ${WINDOWS_SERVICE_NAME} Windows service`,
      argv: ["sc.exe", "delete", WINDOWS_SERVICE_NAME],
      ignoreFailure: true,
    },
    {
      description: `Remove ${binDir} and ${paths.endpoint} (broker state is preserved)`,
      argv: psEncoded(
        `$ErrorActionPreference='Stop'; Remove-Item -LiteralPath ${psQuote(binDir)} -Recurse -Force -ErrorAction SilentlyContinue; Remove-Item -LiteralPath ${psQuote(paths.endpoint)} -Force -ErrorAction SilentlyContinue`,
      ),
    },
  ];
}
