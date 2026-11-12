import { describe, expect, test } from "bun:test";
import { autoApplies, partialCandidates } from "../src/web/format";
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

  test("a removal waits for a person, like a host key or credential", () => {
    const removal: Preview = {
      ...base,
      entries: [
        {
          id: "machine:lab-web",
          local: { value: { name: "lab-web" } },
          remote: { value: null },
        },
      ],
    };
    expect(autoApplies(removal)).toBe(false);
    expect(partialCandidates(removal)).toEqual([]);
  });

  test("a partial apply takes only clean machine and provider changes", () => {
    const preview: Preview = {
      ...base,
      changes: [
        "machine:lab-web",
        "provider:pve",
        "credential:lab",
        "hostkey:lab",
        "machine:old",
        "machine:busy",
      ],
      entries: [
        {
          id: "machine:lab-web",
          local: null,
          remote: { value: { name: "lab-web" } },
        },
        { id: "provider:pve", local: null, remote: { value: {} } },
        { id: "credential:lab", local: null, remote: { value: {} } },
        { id: "hostkey:lab", local: null, remote: { value: "ssh-ed25519" } },
        { id: "machine:old", local: { value: {} }, remote: { value: null } },
        { id: "machine:busy", local: null, remote: { value: {} } },
      ],
      conflicts: [
        {
          id: "machine:busy",
          local: { value: 1 },
          remote: { value: 2 },
        },
      ],
    };
    expect(partialCandidates(preview)).toEqual([
      "machine:lab-web",
      "provider:pve",
    ]);
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
