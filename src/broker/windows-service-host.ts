// Native Windows Service host (C#, compiled with the built-in .NET Framework
// 4.x csc.exe during `home-ctl daemon install`). Windows SCM requires the
// registered service binary to call StartServiceCtrlDispatcher; this small
// ServiceBase wrapper handles SCM lifecycle, runs the homectl broker as
// NT SERVICE\homectl with HOME/USERPROFILE pointed at the ACL'd state folder,
// logs stdout/stderr to state\service.log, and cleans up endpoint.json on stop.
import { join } from "node:path";

export const WINDOWS_SERVICE_NAME = "homectl";
export const WINDOWS_SERVICE_ACCOUNT = `NT SERVICE\\${WINDOWS_SERVICE_NAME}`;
export const WINDOWS_SERVICE_DISPLAY = "homectl broker";
export const WINDOWS_SERVICE_DESCRIPTION =
  "homectl broker (agent access and approvals)";
export const DEFAULT_WINDOWS_PANEL_ORIGIN = "http://127.0.0.1:7451";

export function windowsCscPath(
  systemRoot = process.env.SystemRoot ?? "C:\\Windows",
): string {
  return join(
    systemRoot,
    "Microsoft.NET",
    "Framework64",
    "v4.0.30319",
    "csc.exe",
  );
}

export interface WindowsServiceConfig {
  executable: string;
  args: string[];
  state: string;
  endpoint: string;
  panelOrigin?: string;
  log: string;
}

export function serializeWindowsServiceConfig(
  config: WindowsServiceConfig,
): string {
  const lines = [
    `executable=${config.executable}`,
    ...config.args.map((arg) => `arg=${arg}`),
    `state=${config.state}`,
    `endpoint=${config.endpoint}`,
    ...(config.panelOrigin ? [`panelOrigin=${config.panelOrigin}`] : []),
    `log=${config.log}`,
  ];
  return `${lines.join("\r\n")}\r\n`;
}

export const WINDOWS_SERVICE_HOST_CS = `using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.ServiceProcess;
using System.Text;

namespace HomectlServiceHost
{
    public sealed class HomectlService : ServiceBase
    {
        private Process _child;
        private readonly object _logLock = new object();
        private volatile bool _stopping;
        private string _logPath;
        private string _endpointPath;

        public HomectlService()
        {
            ServiceName = "${WINDOWS_SERVICE_NAME}";
            CanStop = true;
            CanShutdown = true;
            AutoLog = true;
        }

        protected override void OnStart(string[] args)
        {
            _stopping = false;
            var configPath = Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "service.conf");
            if (!File.Exists(configPath))
                throw new FileNotFoundException("Missing service.conf", configPath);

            string executable = null;
            string stateDir = null;
            string panelOrigin = null;
            var argList = new List<string>();

            foreach (var rawLine in File.ReadAllLines(configPath, Encoding.UTF8))
            {
                var line = rawLine.Trim();
                if (line.Length == 0 || line.StartsWith("#")) continue;
                var idx = line.IndexOf('=');
                if (idx <= 0) continue;
                var key = line.Substring(0, idx).Trim();
                var value = line.Substring(idx + 1).Trim();
                if (key == "executable") executable = value;
                else if (key == "arg") argList.Add(value);
                else if (key == "state") stateDir = value;
                else if (key == "endpoint") _endpointPath = value;
                else if (key == "panelOrigin") panelOrigin = value;
                else if (key == "log") _logPath = value;
            }

            if (string.IsNullOrEmpty(executable) || string.IsNullOrEmpty(stateDir))
                throw new InvalidOperationException("service.conf must specify executable and state");

            var psi = new ProcessStartInfo
            {
                FileName = executable,
                Arguments = JoinArguments(argList),
                WorkingDirectory = stateDir,
                UseShellExecute = false,
                CreateNoWindow = true,
                RedirectStandardOutput = true,
                RedirectStandardError = true
            };
            psi.EnvironmentVariables["HOME"] = stateDir;
            psi.EnvironmentVariables["USERPROFILE"] = stateDir;
            if (!string.IsNullOrEmpty(panelOrigin))
                psi.EnvironmentVariables["HOMECTL_PANEL_ORIGIN"] = panelOrigin;

            var child = new Process { StartInfo = psi, EnableRaisingEvents = true };
            child.OutputDataReceived += (s, e) => { if (e.Data != null) WriteLog("OUT", e.Data); };
            child.ErrorDataReceived += (s, e) => { if (e.Data != null) WriteLog("ERR", e.Data); };
            child.Exited += (s, e) =>
            {
                if (_stopping) return;
                WriteLog("SVC", "Broker process exited unexpectedly with code " + child.ExitCode);
                ExitCode = child.ExitCode != 0 ? child.ExitCode : 1;
                Stop();
            };

            if (!child.Start())
                throw new InvalidOperationException("Failed to start homectl broker process");

            _child = child;
            child.BeginOutputReadLine();
            child.BeginErrorReadLine();
            WriteLog("SVC", "Started homectl broker pid=" + child.Id);
        }

        protected override void OnStop()
        {
            ShutdownChild();
        }

        protected override void OnShutdown()
        {
            ShutdownChild();
        }

        private void ShutdownChild()
        {
            _stopping = true;
            var child = _child;
            _child = null;
            if (child != null)
            {
                try
                {
                    if (!child.HasExited)
                    {
                        child.Kill();
                        child.WaitForExit(5000);
                    }
                }
                catch (Exception ex)
                {
                    WriteLog("SVC", "Stop error: " + ex.Message);
                }
                finally
                {
                    child.Dispose();
                }
            }
            if (!string.IsNullOrEmpty(_endpointPath))
            {
                try
                {
                    if (File.Exists(_endpointPath)) File.Delete(_endpointPath);
                }
                catch { }
            }
            WriteLog("SVC", "Stopped homectl broker");
        }

        private void WriteLog(string stream, string message)
        {
            if (string.IsNullOrEmpty(_logPath)) return;
            try
            {
                lock (_logLock)
                {
                    var line = DateTime.UtcNow.ToString("o") + " [" + stream + "] " + message + Environment.NewLine;
                    File.AppendAllText(_logPath, line, Encoding.UTF8);
                }
            }
            catch { }
        }

        private static string JoinArguments(List<string> args)
        {
            var sb = new StringBuilder();
            for (var i = 0; i < args.Count; i++)
            {
                if (i > 0) sb.Append(' ');
                sb.Append(QuoteArgument(args[i]));
            }
            return sb.ToString();
        }

        private static string QuoteArgument(string arg)
        {
            if (arg.Length == 0) return "\\"\\"";
            var needsQuote = false;
            for (var i = 0; i < arg.Length; i++)
            {
                if (arg[i] == ' ' || arg[i] == '\\t' || arg[i] == '"') { needsQuote = true; break; }
            }
            if (!needsQuote) return arg;
            var sb = new StringBuilder();
            sb.Append('"');
            var backslashes = 0;
            foreach (var ch in arg)
            {
                if (ch == '\\\\') { backslashes++; }
                else if (ch == '"') { sb.Append('\\\\', backslashes * 2 + 1); sb.Append('"'); backslashes = 0; }
                else { if (backslashes > 0) { sb.Append('\\\\', backslashes); backslashes = 0; } sb.Append(ch); }
            }
            if (backslashes > 0) sb.Append('\\\\', backslashes * 2);
            sb.Append('"');
            return sb.ToString();
        }

        public static void Main()
        {
            ServiceBase.Run(new HomectlService());
        }
    }
}
`;
