import { describe, expect, test } from "bun:test";
import { PanelGate } from "../src/web/unlock-gate";
import { newServerKeys } from "../src/web/unlock-seal";

const COOKIE = "B".repeat(43);

function gateWith(onLock: () => void = () => undefined) {
  let clock = 0;
  const gate = new PanelGate({
    keys: newServerKeys(),
    cookie: COOKIE,
    idleMs: 60_000,
    onLock,
    now: () => clock,
  });
  return {
    gate,
    advance: (ms: number) => {
      clock += ms;
    },
  };
}

describe("local launch opens the panel, not the vault", () => {
  test("a granted panel authorizes its cookie without any vault unlock", () => {
    const { gate } = gateWith();
    const header = gate.grantPanel();
    expect(header).toContain(`homectl=${COOKIE}`);
    expect(gate.authorize(`homectl=${COOKIE}`)).toBe(true);
  });

  test("no cookie means no access, even after a grant elsewhere", () => {
    const { gate } = gateWith();
    gate.grantPanel();
    expect(gate.authorize(null)).toBe(false);
    expect(gate.authorize("homectl=other")).toBe(false);
  });

  test("an idle granted panel closes and reports the lock once", () => {
    let locks = 0;
    const { gate, advance } = gateWith(() => {
      locks += 1;
    });
    gate.grantPanel();
    advance(61_000);
    expect(gate.authorize(`homectl=${COOKIE}`)).toBe(false);
    expect(locks).toBe(1);
  });
});
