// Terminal questions during `owner init` (homelab #21 A1). End of input must
// answer like Enter, so a closed terminal keeps the default instead of hanging.
import { describe, expect, test } from "bun:test";
import { PassThrough } from "node:stream";
import { readTerminalLine } from "../src/cli/owner-commands";

function streams() {
  const input = new PassThrough();
  const output = new PassThrough();
  output.resume();
  return { input, output };
}

describe("readTerminalLine", () => {
  test("returns the typed answer", async () => {
    const { input, output } = streams();
    const answer = readTerminalLine(input, output, "Reviewer authority: ");
    input.write("delegated\n");
    expect(await answer).toBe("delegated");
  });

  test("end of input answers empty, like Enter", async () => {
    const { input, output } = streams();
    const answer = readTerminalLine(input, output, "Reviewer authority: ");
    input.end();
    expect(await answer).toBe("");
  });
});
