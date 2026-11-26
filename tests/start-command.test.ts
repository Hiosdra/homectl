import { describe, expect, test } from "bun:test";
import {
  hasDisplay,
  openCommand,
  PANEL_PORT_FIRST,
  planPanel,
} from "../src/cli/start-command";
import { HomectlError } from "../src/types";

// Ports listed as busy are not free; everything else is.
function busy(...ports: number[]) {
  return async (port: number) => !ports.includes(port);
}

describe("home-ctl start: panel address", () => {
  test("the default is http://127.0.0.1:7451 when that port is free", async () => {
    expect(await planPanel({}, busy())).toEqual({
      port: PANEL_PORT_FIRST,
      origin: "http://127.0.0.1:7451",
    });
  });

  test("the next free port is used when 7451 is taken", async () => {
    expect(await planPanel({}, busy(7451, 7452))).toEqual({
      port: 7453,
      origin: "http://127.0.0.1:7453",
    });
  });

  test("with every port in range taken it says what to set", async () => {
    const taken = Array.from({ length: 20 }, (_, i) => 7451 + i);
    const error = await planPanel({}, busy(...taken)).catch((e) => e);
    expect(error).toBeInstanceOf(HomectlError);
    expect((error as HomectlError).message).toContain(
      "HOMECTL_OWNER_PANEL_PORT",
    );
  });

  test("HOMECTL_OWNER_PANEL_PORT picks the port", async () => {
    expect(
      await planPanel({ HOMECTL_OWNER_PANEL_PORT: "9000" }, busy()),
    ).toEqual({ port: 9000, origin: "http://127.0.0.1:9000" });
  });

  test("a bad HOMECTL_OWNER_PANEL_PORT is refused", async () => {
    await expect(
      planPanel({ HOMECTL_OWNER_PANEL_PORT: "lots" }, busy()),
    ).rejects.toThrow("HOMECTL_OWNER_PANEL_PORT must be a port number");
  });

  test("a loopback HOMECTL_PANEL_ORIGIN sets the port and origin exactly", async () => {
    expect(
      await planPanel(
        { HOMECTL_PANEL_ORIGIN: "http://127.0.0.1:7460" },
        busy(),
      ),
    ).toEqual({ port: 7460, origin: "http://127.0.0.1:7460" });
  });

  test("localhost is refused, because the panel answers only as 127.0.0.1", async () => {
    await expect(
      planPanel({ HOMECTL_PANEL_ORIGIN: "http://localhost:7451" }, busy()),
    ).rejects.toThrow("must use 127.0.0.1, not localhost");
  });

  test("a loopback origin without a port is refused", async () => {
    await expect(
      planPanel({ HOMECTL_PANEL_ORIGIN: "http://127.0.0.1" }, busy()),
    ).rejects.toThrow("needs a port");
  });

  test("a LAN or https origin needs HOMECTL_PANEL_LISTEN too", async () => {
    await expect(
      planPanel(
        { HOMECTL_PANEL_ORIGIN: "https://homectl.lan.example.test" },
        busy(),
      ),
    ).rejects.toThrow("HOMECTL_PANEL_LISTEN must also be set");
  });

  test("a LAN origin with HOMECTL_PANEL_LISTEN keeps the exact origin", async () => {
    expect(
      await planPanel(
        {
          HOMECTL_PANEL_ORIGIN: "https://homectl.lan.example.test",
          HOMECTL_PANEL_LISTEN: "10.0.0.5",
          HOMECTL_OWNER_PANEL_PORT: "8443",
        },
        busy(),
      ),
    ).toEqual({ port: 8443, origin: "https://homectl.lan.example.test" });
  });

  test("a value that is not a URL is refused", async () => {
    await expect(
      planPanel({ HOMECTL_PANEL_ORIGIN: "not a url" }, busy()),
    ).rejects.toThrow("must be a web address");
  });
});

describe("home-ctl start: opening the browser", () => {
  test("Windows uses the same opener as home-ctl panel, with no token in the URL", () => {
    expect(openCommand("win32", "http://127.0.0.1:7451")).toEqual([
      "rundll32.exe",
      "url.dll,FileProtocolHandler",
      "http://127.0.0.1:7451",
    ]);
  });

  test("macOS and Linux use open and xdg-open", () => {
    expect(openCommand("darwin", "http://x")[0]).toBe("open");
    expect(openCommand("linux", "http://x")[0]).toBe("xdg-open");
  });

  test("Linux without a display does not try to open a browser", () => {
    expect(hasDisplay("linux", {})).toBe(false);
    expect(hasDisplay("linux", { DISPLAY: ":0" })).toBe(true);
    expect(hasDisplay("linux", { WAYLAND_DISPLAY: "wayland-0" })).toBe(true);
    expect(hasDisplay("win32", {})).toBe(true);
  });
});
