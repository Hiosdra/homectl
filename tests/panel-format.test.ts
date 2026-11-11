import { describe, expect, test } from "bun:test";
import { autoApplies } from "../src/web/format";
import type { Preview } from "../src/web/types";

const base: Preview = {
  id: "preview-1",
  localName: "Linux · demo",
  remoteName: "Windows · demo",
  changes: ["machine:lab-web"],
  entries: [
    {
      id: "machine:lab-web",
      local: null,
      remote: { value: { name: "lab-web" } },
    },
  ],
  conflicts: [],
};

describe("automatic apply of clean sync changes", () => {
  test("clean machine and provider changes apply on their own", () => {
    expect(autoApplies(base)).toBe(true);
    const provider: Preview = {
      ...base,
      changes: ["provider:pve"],
      entries: [{ id: "provider:pve", local: null, remote: { value: {} } }],
    };
    expect(autoApplies(provider)).toBe(true);
  });

  test("host keys and credentials always keep the preview for a person", () => {
    const hostkey: Preview = {
      ...base,
      changes: ["hostkey:lab-web"],
      entries: [
        {
          id: "hostkey:lab-web",
          local: null,
          remote: { value: "ssh-ed25519" },
        },
      ],
    };
    const credential: Preview = {
      ...base,
      changes: ["credential:lab-web"],
      entries: [
        { id: "credential:lab-web", local: null, remote: { value: {} } },
      ],
    };
    expect(autoApplies(hostkey)).toBe(false);
    expect(autoApplies(credential)).toBe(false);
  });

  test("conflicts, blockers, empty previews and unknown entries never auto-apply", () => {
    expect(
      autoApplies({
        ...base,
        conflicts: [
          { id: "machine:lab-web", local: { value: 1 }, remote: { value: 2 } },
        ],
      }),
    ).toBe(false);
    expect(
      autoApplies({ ...base, blocker: { type: "remote_vault_locked" } }),
    ).toBe(false);
    expect(autoApplies({ ...base, changes: [] })).toBe(false);
    expect(autoApplies({ ...base, entries: undefined })).toBe(false);
  });
});
