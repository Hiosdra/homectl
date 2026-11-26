import { describe, expect, test } from "bun:test";
import { passwordNoun, readPassword } from "../src/session";

describe("the password a command asks for is named correctly", () => {
  test("owner prompts say owner password", () => {
    expect(passwordNoun("Owner password: ")).toBe("owner password");
    expect(passwordNoun("New owner password: ")).toBe("owner password");
  });

  test("vault and database prompts say vault password", () => {
    expect(
      passwordNoun("New vault password (this is also your owner password): "),
    ).toBe("vault password");
    expect(passwordNoun("KeePassXC database password: ")).toBe(
      "vault password",
    );
  });

  test("anything else is just password", () => {
    expect(passwordNoun("Something else: ")).toBe("password");
  });

  test("without a terminal, the error names the owner password, not the database password", async () => {
    // bun test runs without a terminal on stdin, so the terminal check refuses.
    const error = await readPassword("Owner password: ").catch((e) => e);
    expect((error as Error).message).toContain("never send the owner password");
    expect((error as Error).message).not.toContain("database password");
  });
});
