import { describe, expect, test } from "bun:test";
import {
  createTaskArgv,
  deleteTaskArgv,
  queryTaskArgv,
  serviceTask,
  TASK_NAME,
  taskCommand,
  taskPlan,
} from "../src/service-task";

describe("Windows scheduled task commands", () => {
  test("paths with spaces stay one quoted argument", () => {
    const command = taskCommand("C:\\Program Files\\homectl\\homectl.exe", [
      "serve",
      "--inventory",
      "C:\\Users\\me\\My Homelab\\inventory.yaml",
      "--interface",
      "192.168.1.20",
    ]);
    expect(command).toBe(
      '"C:\\Program Files\\homectl\\homectl.exe" "serve" "--inventory" "C:\\Users\\me\\My Homelab\\inventory.yaml" "--interface" "192.168.1.20"',
    );
  });

  test("inner quotes are escaped", () => {
    const command = taskCommand("C:\\bin\\homectl.exe", ['say "hi"']);
    expect(command).toContain('"say \\"hi\\""');
  });

  test("the task runs at logon for a limited user and is never overwritten", () => {
    const argv = createTaskArgv('"C:\\bin\\homectl.exe" serve');
    expect(argv.slice(0, 2)).toEqual(["schtasks", "/Create"]);
    expect(argv).toContain("ONLOGON");
    expect(argv).toContain("LIMITED");
    expect(argv).not.toContain("/F");
    expect(argv).toContain(TASK_NAME);
  });

  test("query and delete address the same task name", () => {
    expect(queryTaskArgv()).toEqual(["schtasks", "/Query", "/TN", TASK_NAME]);
    expect(deleteTaskArgv()).toEqual([
      "schtasks",
      "/Delete",
      "/TN",
      TASK_NAME,
      "/F",
    ]);
  });
});

describe("scheduled task plan", () => {
  test("the logon task serves the inventory on one interface, with a quoted path", () => {
    const plan = taskPlan("C:UsersmeMy Homelabinventory.yaml", "192.168.1.20");
    expect(plan.task).toBe(TASK_NAME);
    expect(plan.command).toContain(
      `"serve" "--inventory" "C:UsersmeMy Homelabinventory.yaml" "--interface" "192.168.1.20"`,
    );
    expect(plan.create).toContain(plan.command);
    expect(plan.create).not.toContain("/F");
  });

  test("a dry run returns the command and changes nothing", async () => {
    const result = await serviceTask("install", {
      inventory: "C:inv.yaml",
      interfaceIP: "127.0.0.1",
      dryRun: true,
    });
    expect(result).toMatchObject({ changed: false, credentialAccess: false });
    expect(JSON.stringify(result)).toContain("serve");
  });

  test("dry runs of removal and start do not touch the task", async () => {
    for (const action of ["uninstall", "start", "stop"]) {
      const result = await serviceTask(action, {
        inventory: "C:inv.yaml",
        interfaceIP: "127.0.0.1",
        dryRun: true,
      });
      expect(result).toMatchObject({ changed: false, action });
    }
  });

  test("actions without a task equivalent are refused before any command runs", async () => {
    await expect(
      serviceTask("logs", {
        inventory: "C:inv.yaml",
        interfaceIP: "127.0.0.1",
        dryRun: true,
      }),
    ).rejects.toMatchObject({ code: 2 });
  });
});
