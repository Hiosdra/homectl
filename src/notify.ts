// Desktop notifications for requests that wait for approval or are about to expire.
// Each platform gets an argv array, never a shell string. Text reaches Windows
// PowerShell only base64-encoded, so quotes in a request cannot inject code.
import { run } from "./process";

export type Notice = { title: string; body: string };

// AppleScript string literal: escape backslashes and double quotes.
function appleString(value: string): string {
  return `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

export function notifyArgv(
  platform: NodeJS.Platform,
  notice: Notice,
): string[] | undefined {
  if (platform === "darwin")
    return [
      "osascript",
      "-e",
      `display notification ${appleString(notice.body)} with title ${appleString(notice.title)}`,
    ];
  if (platform === "linux")
    return ["notify-send", "--app-name=homectl", notice.title, notice.body];
  if (platform === "win32") {
    const encode = (value: string) =>
      Buffer.from(value, "utf8").toString("base64");
    const script = [
      `$t = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encode(notice.title)}'))`,
      `$b = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encode(notice.body)}'))`,
      "[Windows.UI.Notifications.ToastNotificationManager,Windows.UI.Notifications,ContentType=WindowsRuntime] > $null",
      "$xml = [Windows.UI.Notifications.ToastNotificationManager]::GetTemplateContent([Windows.UI.Notifications.ToastTemplateType]::ToastText02)",
      "$xml.GetElementsByTagName('text')[0].AppendChild($xml.CreateTextNode($t)) > $null",
      "$xml.GetElementsByTagName('text')[1].AppendChild($xml.CreateTextNode($b)) > $null",
      "$toast = [Windows.UI.Notifications.ToastNotification]::new($xml)",
      "[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('homectl').Show($toast)",
    ].join("; ");
    const encoded = Buffer.from(script, "utf16le").toString("base64");
    return [
      "powershell",
      "-NoProfile",
      "-NonInteractive",
      "-EncodedCommand",
      encoded,
    ];
  }
  return undefined;
}

// Best effort: a missing notifier or a refused notification never breaks the panel.
export async function notify(
  notice: Notice,
  platform: NodeJS.Platform = process.platform,
) {
  const argv = notifyArgv(platform, notice);
  if (!argv) return { sent: false, reason: "no notifier on this platform" };
  try {
    const result = await run({ argv });
    return { sent: result.exitCode === 0 };
  } catch {
    return { sent: false, reason: "notifier unavailable" };
  }
}
