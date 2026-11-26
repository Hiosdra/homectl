// The Needs-you badge says what an action does (0.3 acceptance). The risk tier
// (R1-R4) still sets the colour and stays in Details, and no approval rule changes
// with the words. Pure: the mapping is tested without rendering.
import { describe, expect, test } from "bun:test";
import { actionLabel, actionView, riskView } from "../src/web/owner/risk";

const setup = (kind: string, risk: string) => ({
  risk,
  classification: "mutation",
  setup: { kind },
});

describe("setup requests: the badge names the action", () => {
  test("adding a machine reads as giving access, not as destructive", () => {
    const view = actionView(setup("enroll", "R4"));
    expect(view.label).toBe("Gives access");
    expect(view.label).not.toContain("Destructive");
    expect(view.icon).toBe("key");
  });

  test("access level and permission setting read as changing permissions", () => {
    expect(actionView(setup("access", "R3")).label).toBe("Changes permissions");
    expect(actionView(setup("access", "R4")).label).toBe("Changes permissions");
    expect(actionView(setup("preset", "R3")).label).toBe("Changes permissions");
  });

  test("removing a machine reads as removing it", () => {
    expect(
      actionView({
        risk: "R4",
        classification: "destructive",
        setup: { kind: "remove" },
      }).label,
    ).toBe("Removes");
  });

  test("scan and probe read as just looking", () => {
    expect(actionView(setup("scan", "R1")).label).toBe("Just looks");
    expect(actionView(setup("probe", "R1")).label).toBe("Just looks");
    expect(actionView(setup("scan", "R1")).stripe).toBe("look");
  });
});

describe("commands and Proxmox: the badge follows the class of the action", () => {
  test("each classification has a plain label", () => {
    expect(actionLabel({ risk: "R0", classification: "inspect" })).toBe(
      "Just looks",
    );
    expect(actionLabel({ risk: "R2", classification: "mutation" })).toBe(
      "Changes things",
    );
    expect(actionLabel({ risk: "R4", classification: "destructive" })).toBe(
      "Deletes",
    );
    expect(actionLabel({ risk: "R3", classification: "opaque" })).toBe(
      "Needs a look",
    );
  });

  test("a card with no class falls back to its tier, still in plain words", () => {
    expect(actionLabel({ risk: "R1" })).toBe("Just looks");
    expect(actionLabel({ risk: "R3" })).toBe("Changes things");
    expect(actionLabel({ risk: "R4" })).toBe("Deletes");
    expect(actionLabel({ risk: "R9" })).toBe("Needs a look");
  });
});

describe("the tier is unchanged: colour and Details", () => {
  test("the stripe follows the risk tier, not the words", () => {
    expect(actionView(setup("enroll", "R4")).stripe).toBe("destructive");
    expect(actionView({ risk: "R2", classification: "mutation" }).stripe).toBe(
      "small",
    );
  });

  test("the technical tier label is still available for Details", () => {
    expect(riskView("R4").label).toBe("Destructive");
    expect(riskView("R3").label).toBe("Big change");
  });
});
