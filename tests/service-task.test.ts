import { describe, expect, test } from "bun:test";
import {
  createTaskArgv,
  deleteTaskArgv,
  queryTaskArgv,
  TASK_NAME,
  taskCommand,
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
