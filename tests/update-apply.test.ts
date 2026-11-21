import { describe, expect, test } from "bun:test";
import { handleUpdateRoute } from "../src/web/update-status";

// The route answers only for the panel on this computer, and only from its own origin.
describe("update apply route", () => {
  const checker = {
    status: async () => ({
      current: "0.2.0",
      latest: "0.2.1",
      available: true,
    }),
  } as never;
  const post = (address: string, origin?: string) =>
    handleUpdateRoute(
      new Request(`${address}/api/update/apply`, {
        method: "POST",
        headers: origin ? { Origin: origin } : {},
      }),
      new URL(`${address}/api/update/apply`),
      checker,
    );

  test("refuses the apply from a LAN address, as a container or LAN panel would be", async () => {
    const response = await post(
      "http://192.0.2.10:7447",
      "http://192.0.2.10:7447",
    );
    expect(response?.status).toBe(403);
    expect(await response?.text()).toContain("redeploying its image");
  });

  test("refuses a cross-origin apply on this computer", async () => {
    const response = await post("http://127.0.0.1:7447", "http://evil.example");
    expect(response?.status).toBe(403);
  });

  test("says so when no newer release is available", async () => {
    const none = {
      status: async () => ({ current: "0.2.0", available: false }),
    } as never;
    const response = await handleUpdateRoute(
      new Request("http://127.0.0.1:7447/api/update/apply", {
        method: "POST",
        headers: { Origin: "http://127.0.0.1:7447" },
      }),
      new URL("http://127.0.0.1:7447/api/update/apply"),
      none,
    );
    expect(response?.status).toBe(409);
  });

  test("leaves other requests alone", async () => {
    const response = await handleUpdateRoute(
      new Request("http://127.0.0.1:7447/api/state"),
      new URL("http://127.0.0.1:7447/api/state"),
      checker,
    );
    expect(response).toBeUndefined();
  });
});
