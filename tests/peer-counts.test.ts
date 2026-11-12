import { describe, expect, test } from "bun:test";
import { previewCounts } from "../src/peer/sync";

// Device ids in clocks are UUIDs, as the peer protocol requires.
const LOCAL = "11111111-1111-4111-8111-111111111111";
const REMOTE = "22222222-2222-4222-8222-222222222222";

// The dashboard shows these numbers for a pending comparison; they must match the preview.
describe("pending comparison counts", () => {
  test("a new entry on the other side is one change and no conflict", () => {
    const counts = previewCounts(
      {},
      {
        "machine:lab-web": {
          clock: { [REMOTE]: 1 },
          value: { name: "lab-web" },
        },
      },
      LOCAL,
    );
    expect(counts).toEqual({ changes: 1, conflicts: 0 });
  });

  test("the same entry changed on both sides, concurrently, is one conflict", () => {
    const counts = previewCounts(
      {
        "machine:lab-web": {
          clock: { [LOCAL]: 1 },
          value: { address: "192.0.2.1" },
        },
      },
      {
        "machine:lab-web": {
          clock: { [REMOTE]: 1 },
          value: { address: "192.0.2.2" },
        },
      },
      LOCAL,
    );
    expect(counts).toEqual({ changes: 1, conflicts: 1 });
  });

  test("identical entries are not counted", () => {
    const entry = { clock: { [LOCAL]: 1 }, value: { name: "lab-web" } };
    expect(
      previewCounts(
        { "machine:lab-web": entry },
        { "machine:lab-web": entry },
        LOCAL,
      ),
    ).toEqual({ changes: 0, conflicts: 0 });
  });
});
