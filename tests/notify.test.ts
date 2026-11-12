import { describe, expect, test } from "bun:test";
import { notifyArgv } from "../src/notify";

const notice = {
  title: 'homectl "approval"',
  body: 'Run lab-printer\'s "restart" \\ now',
};

describe("notification commands", () => {
  test("macOS escapes quotes and backslashes for AppleScript", () => {
    const argv = notifyArgv("darwin", notice);
    expect(argv?.[0]).toBe("osascript");
    expect(argv?.[2]).toBe(
      'display notification "Run lab-printer\'s \\"restart\\" \\\\ now" with title "homectl \\"approval\\""',
    );
  });

  test("Linux passes text as separate arguments, never through a shell", () => {
    expect(notifyArgv("linux", notice)).toEqual([
      "notify-send",
      "--app-name=homectl",
      notice.title,
      notice.body,
    ]);
  });

  test("Windows names a registered application id, so the toast is shown", () => {
    const argv = notifyArgv("win32", notice);
    const script = Buffer.from(argv?.at(-1) ?? "", "base64").toString(
      "utf16le",
    );
    expect(script).toContain("WindowsPowerShell");
    expect(script).toContain(
      "CreateToastNotifier('{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}",
    );
    expect(script).not.toContain("CreateToastNotifier('homectl')");
  });

  test("Windows fills both text lines from one snapshot of the live template list", () => {
    const argv = notifyArgv("win32", notice);
    const script = Buffer.from(argv?.at(-1) ?? "", "base64").toString(
      "utf16le",
    );
    expect(script).toContain("$texts = @($xml.GetElementsByTagName('text'))");
    expect(script).toContain("$texts[1].AppendChild");
    expect(script).not.toContain("GetElementsByTagName('text')[1]");
  });

  test("Windows sends the text base64-encoded, so it cannot break out of the script", () => {
    const argv = notifyArgv("win32", {
      title: "x'); Remove-Item C:\\ -Recurse; ('",
      body: "$(calc)",
    });
    expect(argv?.[0]).toBe("powershell");
    const script = Buffer.from(argv?.at(-1) ?? "", "base64").toString(
      "utf16le",
    );
    expect(script).not.toContain("Remove-Item");
    expect(script).not.toContain("calc");
    const titleB64 = /FromBase64String\('([A-Za-z0-9+/=]+)'\)/.exec(
      script,
    )?.[1];
    expect(Buffer.from(titleB64 ?? "", "base64").toString("utf8")).toBe(
      "x'); Remove-Item C:\\ -Recurse; ('",
    );
  });

  test("other platforms have no notifier", () => {
    expect(notifyArgv("freebsd", notice)).toBeUndefined();
  });
});
