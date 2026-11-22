// Setup requests in Needs you (0.3 acceptance): the plain title, the body, the
// Details rows and the typed fingerprint confirmation. Rendered to markup, so the
// tests read what the owner sees. The panel's CSP forbids inline styles, so no
// markup here may carry a style attribute.
import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { PendingOperation } from "../src/web/owner/api";
import {
  FingerprintConfirm,
  fingerprintConfirmed,
  isSetupOperation,
  SetupDetailRows,
  SetupRequestBody,
  setupBodyText,
  setupTitle,
} from "../src/web/owner/setup-request";

const FP = `SHA256:${"D".repeat(43)}`;
const FP_OTHER = `SHA256:${"E".repeat(43)}`;

function pending(overrides: Partial<PendingOperation>): PendingOperation {
  return {
    id: "op_setup",
    state: "awaiting-approval",
    client: "codex-pc",
    host: "new-box",
    argv: ["homectl", "setup", "enroll", "new-box"],
    impact: "Add a machine to homectl",
    classification: "mutation",
    risk: "R4",
    fingerprint: "f".repeat(64),
    decision: {
      verdict: "ask",
      source: "hard-gate",
      reason: "Only the owner can approve this kind of request",
      humanOnly: true,
      stepUp: true,
    },
    createdAt: 1_800_000_000_000,
    expiresAt: 1_800_000_900_000,
    ownerOnly: true,
    area: "Machines",
    ...overrides,
  } as PendingOperation;
}

const enroll = pending({
  setup: {
    kind: "enroll",
    input: {
      name: "new-box",
      address: "192.0.2.45",
      port: 2222,
      user: "ops",
      access: "user",
    },
    presented: [{ type: "ssh-ed25519", fingerprint: FP }],
  },
});

describe("setup requests: titles and body text", () => {
  test("each kind reads as a plain question", () => {
    expect(setupTitle(enroll)).toBe("Add new-box to homectl?");
    expect(
      setupTitle(pending({ setup: { kind: "probe", input: { name: "nas" } } })),
    ).toBe("Check that nas answers?");
    expect(
      setupTitle(
        pending({
          setup: { kind: "access", input: { name: "nas", access: "full" } },
        }),
      ),
    ).toBe("Give nas full admin?");
    expect(
      setupTitle(
        pending({
          setup: { kind: "preset", input: { preset: "delegated" } },
        }),
      ),
    ).toBe("Change the AI permission setting to AI decides more?");
    expect(
      setupTitle(
        pending({ setup: { kind: "remove", input: { name: "nas" } } }),
      ),
    ).toBe("Remove nas from homectl?");
    expect(
      setupTitle(
        pending({
          setup: { kind: "scan", input: { address: "192.0.2.44" } },
        }),
      ),
    ).toBe("Look for the SSH key at 192.0.2.44?");
  });

  test("the body says what changes and what does not", () => {
    expect(setupBodyText(enroll)).toContain("Compare the key");
    expect(
      setupBodyText(
        pending({ setup: { kind: "probe", input: { name: "nas" } } }),
      ),
    ).toContain("Nothing changes");
    expect(isSetupOperation(enroll)).toBe(true);
    expect(isSetupOperation(pending({}))).toBe(false);
  });
});

describe("setup requests: Details and the typed fingerprint", () => {
  test("Details show the fields and the presented key, as technical detail", () => {
    const html = renderToStaticMarkup(
      <dl>
        <SetupDetailRows operation={enroll} />
      </dl>,
    );
    expect(html).toContain("Key the machine presented");
    expect(html).toContain(FP);
    expect(html).toContain("192.0.2.45:2222");
    expect(html).toContain("Login");
    expect(html).toContain("Access level");
    expect(html).not.toContain("style=");
  });

  test("the body renders in plain words with no inline style", () => {
    const html = renderToStaticMarkup(<SetupRequestBody operation={enroll} />);
    expect(html).toContain("Add a machine to homectl");
    expect(html).not.toContain("style=");
  });

  test("the typed value must match a fingerprint the machine presented", () => {
    expect(fingerprintConfirmed(enroll, FP)).toBe(true);
    expect(fingerprintConfirmed(enroll, `  ${FP}  `)).toBe(true);
    expect(fingerprintConfirmed(enroll, FP_OTHER)).toBe(false);
    expect(fingerprintConfirmed(enroll, "")).toBe(false);
  });

  test("the confirmation field is a labelled input that shows its mismatch", () => {
    const empty = renderToStaticMarkup(
      <FingerprintConfirm operation={enroll} value="" onChange={() => {}} />,
    );
    expect(empty).toContain("Type the fingerprint to confirm");
    expect(empty).toContain("Compare it with a trusted source");
    expect(empty).toContain(FP);
    expect(empty).not.toContain('role="alert"');
    expect(empty).not.toContain("style=");

    const wrong = renderToStaticMarkup(
      <FingerprintConfirm
        operation={enroll}
        value={FP_OTHER}
        onChange={() => {}}
      />,
    );
    expect(wrong).toContain(
      "That is not the fingerprint the machine presented.",
    );
  });
});
