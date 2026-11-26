// The owner panel's machine words and checks (0.3 guided setup, part 2): plain
// sentences for bad input, the exact fingerprint rule, the probe wording, and
// the Details fields. The broker checks the same things again.
import { expect, test } from "bun:test";
import type { MachineRow } from "../src/web/owner/machine-api";
import {
  accessLabel,
  addressLine,
  assistantLine,
  commandProblem,
  factsFor,
  fingerprintMatch,
  identityWords,
  isRootLogin,
  loginProblem,
  nameProblem,
  parseCommandLines,
  probeLine,
  removalNote,
} from "../src/web/owner/machine-words";

const FP = "SHA256:+exPBSzcOhk18LlhQreDbf6JhUVoULHtaGciwhiinYI";
const OTHER = "SHA256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const NOW = Date.UTC(2026, 10, 21, 9, 0, 0);

function machine(overrides: Partial<MachineRow> = {}): MachineRow {
  return {
    name: "nas",
    description: "",
    address: "192.0.2.20",
    port: 22,
    user: "operator",
    access: "user",
    sudoAllow: [],
    enforcement: "advisory",
    caution: [],
    pinned: FP,
    probe: null,
    assistants: [],
    ...overrides,
  };
}

test("the access levels read in plain words", () => {
  expect(accessLabel("observe")).toBe("Look only");
  expect(accessLabel("user")).toBe("Everyday account");
  expect(accessLabel("sudo-approved")).toBe("Admin with your approval");
  expect(accessLabel("full")).toBe("Full admin");
  expect(accessLabel("unknown")).toBe("unknown");
});

test("names, addresses and logins get a plain sentence when wrong", () => {
  expect(nameProblem("")).toContain("Give the machine a name");
  expect(nameProblem("NAS Office")).toContain("lowercase letters");
  expect(nameProblem("nas-office")).toBeUndefined();
  expect(loginProblem("")).toContain("login name");
  expect(loginProblem("two words")).toContain("one word");
  expect(loginProblem("operator")).toBeUndefined();
  expect(isRootLogin(" root ")).toBe(true);
  expect(isRootLogin("operator")).toBe(false);
});

test("allowed commands are full paths, one per line", () => {
  expect(
    parseCommandLines("  /usr/bin/systemctl restart nas \n\n/bin/ls\n"),
  ).toEqual([["/usr/bin/systemctl", "restart", "nas"], ["/bin/ls"]]);
  expect(commandProblem([])).toContain("at least one allowed command");
  expect(commandProblem([["systemctl", "restart"]])).toContain("full path");
  expect(commandProblem([["/bin/ls"]])).toBeUndefined();
});

test("a fingerprint matches only when it is exactly a presented key", () => {
  const keys = [
    { type: "ssh-ed25519", fingerprint: FP, pinned: false, revoked: false },
    { type: "ssh-rsa", fingerprint: OTHER, pinned: false, revoked: true },
  ];
  expect(fingerprintMatch(FP, keys)?.type).toBe("ssh-ed25519");
  // Surrounding spaces are forgiven; anything else is not a match.
  expect(fingerprintMatch(`  ${FP}\n`, keys)?.type).toBe("ssh-ed25519");
  expect(fingerprintMatch(FP.slice(0, -1), keys)).toBeUndefined();
  expect(fingerprintMatch(FP.toLowerCase(), keys)).toBeUndefined();
  expect(fingerprintMatch("", keys)).toBeUndefined();
  // A revoked key is never accepted, even when typed exactly.
  expect(fingerprintMatch(OTHER, keys)).toBeUndefined();
});

test("identity is checked only once a key is pinned", () => {
  expect(identityWords(FP)).toEqual({
    label: "Identity checked",
    tone: "good",
  });
  expect(identityWords(null)).toEqual({
    label: "Not checked yet",
    tone: "neutral",
  });
});

test("the last check reads in human time, with the reason when it failed", () => {
  expect(probeLine(null, NOW)).toBe("No check has run yet.");
  expect(
    probeLine({ checkedAt: NOW, ok: true, os: "Linux", okAt: NOW }, NOW),
  ).toBe("Last check worked just now (Linux).");
  expect(
    probeLine(
      {
        checkedAt: NOW,
        ok: false,
        reason: "The SSH host could not be reached.",
        okAt: NOW - 3 * 3_600_000,
        os: "Linux",
      },
      NOW,
    ),
  ).toBe(
    "The last check failed just now: The SSH host could not be reached. Last check worked 3 hours ago (Linux).",
  );
  expect(probeLine({ checkedAt: NOW, ok: false, reason: "Denied." }, NOW)).toBe(
    "The last check failed just now: Denied. No check has worked yet.",
  );
});

test("assistants that can reach a machine are named", () => {
  expect(assistantLine([])).toBe("No assistant can reach it yet.");
  expect(assistantLine([{ id: "claude", name: "Claude" }])).toBe(
    "Claude can reach it.",
  );
  expect(
    assistantLine([
      { id: "claude", name: "Claude" },
      { id: "codex", name: "Codex" },
    ]),
  ).toBe("Claude and Codex can reach it.");
});

test("the address shows its port only when it is not 22", () => {
  expect(addressLine(machine())).toBe("192.0.2.20");
  expect(addressLine(machine({ port: 2222 }))).toBe("192.0.2.20 · port 2222");
});

test("Details lists the tier id, login, pin and inventory fields", () => {
  const facts = factsFor(
    machine({
      access: "sudo-approved",
      sudoAllow: ["/usr/bin/systemctl restart nas"],
      caution: ["Check it is idle first"],
    }),
  );
  const values = Object.fromEntries(facts);
  expect(values["Access level (id)"]).toBe("sudo-approved");
  expect(values["Login name"]).toBe("operator");
  expect(values["Pinned fingerprint"]).toBe(FP);
  expect(values["Allowed commands"]).toBe("/usr/bin/systemctl restart nas");
  expect(values.Caution).toBe("Check it is idle first");
  expect(factsFor(machine({ pinned: null }))[2]).toEqual([
    "Pinned fingerprint",
    "Not pinned yet",
  ]);
});

test("the removal note says who loses access and what stays behind", () => {
  expect(removalNote(0)).toContain("No assistant reached it.");
  expect(removalNote(1)).toContain("1 assistant loses access");
  expect(removalNote(2)).toContain("2 assistants lose access");
  expect(removalNote(0)).toContain("Its pinned identity is removed");
});
