import { describe, expect, test } from "bun:test";
import { parseProxmoxArgs } from "../src/cli/proxmox-commands";
import { HomectlError } from "../src/types";

describe("home-ctl proxmox parsing", () => {
  test("a guest catalogue action becomes one typed catalogue request", () => {
    const parsed = parseProxmoxArgs([
      "pve-host",
      "start",
      "--kind",
      "lxc",
      "--vmid",
      "9002",
      "--wait",
      "30",
    ]);
    expect(parsed.host).toBe("pve-host");
    expect(parsed.waitMs).toBe(30_000);
    expect(parsed.body).toEqual({
      catalogue: { kind: "lxc", action: "start", vmid: 9002 },
    });
  });

  test("the default kind is qemu and numbers must be whole", () => {
    const parsed = parseProxmoxArgs(["pve-host", "status", "--vmid", "9001"]);
    expect(parsed.body).toEqual({
      catalogue: { kind: "qemu", action: "status", vmid: 9001 },
    });
    expect(() =>
      parseProxmoxArgs(["pve-host", "status", "--vmid", "9001.5"]),
    ).toThrow("--vmid must be a whole number");
  });

  test("a template given as a number is sent as a number", () => {
    const parsed = parseProxmoxArgs([
      "pve-host",
      "clone",
      "--vmid",
      "9002",
      "--template",
      "9001",
      "--name",
      "web-copy",
    ]);
    expect(parsed.body).toEqual({
      catalogue: {
        kind: "qemu",
        action: "clone",
        vmid: 9002,
        template: 9001,
        name: "web-copy",
      },
    });
  });

  test("restore and unknown actions are refused by the parser", () => {
    expect(() => parseProxmoxArgs(["pve-host", "restore"])).toThrow("disabled");
    expect(() => parseProxmoxArgs(["pve-host", "migrate"])).toThrow(
      "Unknown Proxmox action",
    );
  });

  test("the api form takes a method, a path and key=value parameters", () => {
    const parsed = parseProxmoxArgs([
      "pve-host",
      "api",
      "POST",
      "/nodes/pve-test/qemu/9001/config",
      "--param",
      "memory=4096",
      "--param",
      "name=web",
      "--task",
      "tsk_abcdefgh",
    ]);
    expect(parsed.task).toBe("tsk_abcdefgh");
    expect(parsed.body).toEqual({
      method: "POST",
      path: "/nodes/pve-test/qemu/9001/config",
      params: { memory: "4096", name: "web" },
    });
  });

  test("the api form needs a known method and key=value parameters", () => {
    expect(() =>
      parseProxmoxArgs(["pve-host", "api", "PATCH", "/version"]),
    ).toThrow("Method must be GET, POST, PUT or DELETE");
    expect(() =>
      parseProxmoxArgs([
        "pve-host",
        "api",
        "GET",
        "/version",
        "--param",
        "novalue",
      ]),
    ).toThrow("--param takes key=value");
    expect(() =>
      parseProxmoxArgs(["pve-host", "start", "--param", "a=b"]),
    ).toThrow("--param goes with the api form");
  });

  test("usage errors are homectl errors with exit code 2", () => {
    try {
      parseProxmoxArgs(["pve-host"]);
      throw new Error("expected a usage error");
    } catch (error) {
      expect(error).toBeInstanceOf(HomectlError);
      expect((error as HomectlError).code).toBe(2);
    }
    expect(() =>
      parseProxmoxArgs(["pve-host", "start", "--wait", "900"]),
    ).toThrow("--wait takes 0 to 600 seconds");
  });
});
