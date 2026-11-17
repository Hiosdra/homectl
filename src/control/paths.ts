import { dirname, join, resolve } from "node:path";

export function controlStateDirectory(inventoryPath: string): string {
  return join(dirname(resolve(inventoryPath)), "control-plane");
}
