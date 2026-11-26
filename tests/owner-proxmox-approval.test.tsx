import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { PendingOperation } from "../src/web/owner/api";
import {
  OwnerOnlyNote,
  ProxmoxDetailRows,
  proxmoxParamRows,
  proxmoxRequestLine,
  proxmoxTitle,
} from "../src/web/owner/proxmox";

function pending(overrides: Partial<PendingOperation>): PendingOperation {
  return {
    id: "op_test",
    state: "awaiting-approval",
    client: "codex-pc",
    host: "pve-host",
    argv: ["proxmox-api", "POST", "/nodes/pve-test/qemu/9001/status/reboot"],
    impact: "Reboot VM 9001",
    classification: "mutation",
    risk: "R2",
    fingerprint: "f".repeat(64),
    decision: {
      verdict: "ask",
      source: "default",
      reason: "Needs the owner's approval",
      humanOnly: false,
      stepUp: false,
    },
    createdAt: 1_800_000_000_000,
    expiresAt: 1_800_000_900_000,
    ...overrides,
  } as PendingOperation;
}

describe("Proxmox approvals in Needs you", () => {
  test("the title says what will happen, in plain words", () => {
    expect(proxmoxTitle(pending({}))).toBe("Reboot VM 9001 on pve-host?");
  });

  test("Details show the area, the exact request and the parameters", () => {
    const html = renderToStaticMarkup(
      <dl>
        <ProxmoxDetailRows
          operation={pending({
            area: "Virtual machines and containers",
            proxmox: {
              api: {
                method: "PUT",
                path: "/nodes/pve-test/qemu/9001/config",
                params: { memory: "4096", cipassword: "not-shown" },
              },
            },
          })}
        />
      </dl>,
    );
    expect(html).toContain("Virtual machines and containers");
    expect(html).toContain("PUT /nodes/pve-test/qemu/9001/config");
    expect(html).toContain("memory=4096");
    expect(html).toContain("cipassword=[hidden]");
    expect(html).not.toContain("not-shown");
  });

  test("owner-only changes say so under the title", () => {
    const note = renderToStaticMarkup(
      <OwnerOnlyNote operation={pending({ ownerOnly: true, risk: "R4" })} />,
    );
    expect(note).toContain("Only you can approve this");
    expect(note).toContain("owner password");
    expect(
      renderToStaticMarkup(<OwnerOnlyNote operation={pending({})} />),
    ).toBe("");
  });

  test("a catalogue request has a readable line and no parameters", () => {
    expect(
      proxmoxRequestLine({
        catalogue: { kind: "qemu", action: "start", vmid: 9001 },
      }),
    ).toBe("start qemu 9001");
    expect(proxmoxParamRows(undefined)).toEqual([]);
  });

  test("nothing in the Proxmox rows is inline-styled (the panel CSP forbids it)", () => {
    const html = renderToStaticMarkup(
      <div>
        <ProxmoxDetailRows
          operation={pending({
            proxmox: {
              api: { method: "GET", path: "/version", params: { a: "b" } },
            },
          })}
        />
        <OwnerOnlyNote operation={pending({ ownerOnly: true })} />
      </div>,
    );
    expect(html).not.toContain("style=");
  });
});
