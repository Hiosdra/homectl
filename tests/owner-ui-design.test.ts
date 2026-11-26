// Owner panel design system: the colour pairs meet WCAG AA in both themes, the
// human time and risk words are right, the remembered section never holds more
// than a section name, and the stylesheet and markup keep to the panel's CSP
// (no external resource, no inline style attribute, no injected HTML).
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { canApproveFromList, riskView } from "../src/web/owner/risk";
import {
  readLastSection,
  writeLastSection,
} from "../src/web/owner/last-section";
import { OWNER_CSS, OWNER_HTML } from "../src/web/owner/shell";
import { TOKENS_CSS } from "../src/web/owner/design-tokens";
import {
  expiresIn,
  relativeTime,
  spanOf,
  toEpoch,
} from "../src/web/owner/time";

// Parses "--name: #rrggbb" declarations from one block of the tokens stylesheet.
function tokensFrom(block: string): Record<string, string> {
  const tokens: Record<string, string> = {};
  for (const match of block.matchAll(/--([a-z0-9-]+):\s*(#[0-9a-fA-F]{6})/g))
    tokens[match[1] ?? ""] = match[2] ?? "";
  return tokens;
}

const LIGHT = tokensFrom(TOKENS_CSS.split("@media")[0] ?? "");
const DARK = tokensFrom(
  TOKENS_CSS.slice(TOKENS_CSS.indexOf(':root[data-theme="dark"]')),
);

function luminance(hex: string): number {
  const channel = (offset: number) => {
    const value = Number.parseInt(hex.slice(offset, offset + 2), 16) / 255;
    return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(1) + 0.7152 * channel(3) + 0.0722 * channel(5);
}

function contrast(a: string, b: string): number {
  const [light, dark] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [
    number,
    number,
  ];
  return (light + 0.05) / (dark + 0.05);
}

// Text on a background must reach WCAG AA (4.5:1). Each pair is one a screen shows.
const PAIRS: [string, string][] = [
  ["ink", "bg"],
  ["ink", "surface"],
  ["ink", "surface-2"],
  ["ink-2", "bg"],
  ["ink-2", "surface"],
  ["ink-2", "surface-2"],
  ["accent", "surface"],
  ["accent", "bg"],
  ["accent-ink", "accent"],
  ["accent-soft-ink", "accent-soft"],
  ["ok", "surface"],
  ["ok", "ok-bg"],
  ["warn", "surface"],
  ["warn", "warn-bg"],
  ["bad", "surface"],
  ["bad", "bad-bg"],
  ["untrusted", "untrusted-bg"],
];

describe("owner panel colour tokens", () => {
  for (const [name, tokens] of [
    ["light", LIGHT],
    ["dark", DARK],
  ] as const) {
    test(`${name} theme text pairs meet WCAG AA`, () => {
      for (const [text, background] of PAIRS) {
        const ratio = contrast(tokens[text] ?? "", tokens[background] ?? "");
        expect(
          ratio,
          `${text} on ${background} (${name}) is ${ratio.toFixed(2)}:1`,
        ).toBeGreaterThanOrEqual(4.5);
      }
    });
  }

  test("both themes define the same token names", () => {
    expect(Object.keys(DARK).sort()).toEqual(
      expect.arrayContaining(Object.keys(LIGHT).sort()),
    );
  });
});

describe("human time", () => {
  const now = Date.parse("2026-11-20T12:00:00Z");

  test("spans read in the largest sensible unit", () => {
    expect(spanOf(20_000)).toBe("less than a minute");
    expect(spanOf(60_000)).toBe("1 minute");
    expect(spanOf(12 * 60_000)).toBe("12 minutes");
    expect(spanOf(2 * 3_600_000)).toBe("2 hours");
    expect(spanOf(3 * 24 * 3_600_000)).toBe("3 days");
  });

  test("past and future times", () => {
    expect(relativeTime(now - 2 * 3_600_000, now)).toBe("2 hours ago");
    expect(relativeTime(now + 12 * 60_000, now)).toBe("in 12 minutes");
    expect(relativeTime(now + 5_000, now)).toBe("just now");
  });

  test("expiry says expired once the time has passed", () => {
    expect(expiresIn(now + 9 * 60_000, now)).toBe("expires in 9 minutes");
    expect(expiresIn(now - 1, now)).toBe("expired");
  });

  test("readable epoch or ISO values; anything else is undefined", () => {
    expect(toEpoch(now)).toBe(now);
    expect(toEpoch("2026-11-20T12:00:00Z")).toBe(now);
    expect(toEpoch("not a time")).toBeUndefined();
    expect(toEpoch(undefined)).toBeUndefined();
  });
});

describe("risk words", () => {
  test("every broker level has a word, a tone and an icon", () => {
    expect(riskView("R0").label).toBe("Looks around");
    expect(riskView("R1").label).toBe("Looks around");
    expect(riskView("R2").label).toBe("Small change");
    expect(riskView("R3").label).toBe("Big change");
    expect(riskView("R4").label).toBe("Destructive");
    expect(riskView(undefined).label).toBe("Needs a look");
    for (const level of ["R0", "R2", "R3", "R4"]) {
      const view = riskView(level);
      expect(view.icon.length).toBeGreaterThan(0);
      expect(view.tone.length).toBeGreaterThan(0);
    }
  });

  test("one tap from the list only for small, password-free requests", () => {
    const plain = { risk: "R2", decision: {} };
    expect(canApproveFromList(plain)).toBe(true);
    expect(canApproveFromList({ risk: "R1", decision: {} })).toBe(true);
    expect(canApproveFromList({ risk: "R3", decision: {} })).toBe(false);
    expect(canApproveFromList({ risk: "R4", decision: {} })).toBe(false);
    expect(canApproveFromList({ risk: "R2", decision: { stepUp: true } })).toBe(
      false,
    );
  });
});

describe("remembered section", () => {
  const KEY = "homectl.owner.lastSection";
  type Store = Record<string, string>;
  const install = (store: Store | undefined) => {
    if (store === undefined) {
      Reflect.deleteProperty(globalThis, "localStorage");
      return;
    }
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      value: {
        getItem: (key: string) => store[key] ?? null,
        setItem: (key: string, value: string) => {
          store[key] = value;
        },
      },
    });
  };

  test("stores a section name and reopens its hash", () => {
    const store: Store = {};
    install(store);
    writeLastSection("policy");
    expect(store[KEY]).toBe("policy");
    expect(readLastSection()).toBe("#/policy");
    install(undefined);
  });

  test("ignores unknown names, including prototype keys", () => {
    const store: Store = { [KEY]: "constructor" };
    install(store);
    expect(readLastSection()).toBeUndefined();
    writeLastSection("toString");
    expect(store[KEY]).toBe("constructor");
    install(undefined);
  });

  test("a missing or blocked store changes nothing", () => {
    install(undefined);
    expect(readLastSection()).toBeUndefined();
    expect(() => writeLastSection("system")).not.toThrow();
  });
});

describe("content security policy", () => {
  const webOwner = join(import.meta.dir, "../src/web/owner");
  const sources = readdirSync(webOwner).filter((name) =>
    /\.(ts|tsx)$/.test(name),
  );

  test("the stylesheet loads nothing external and no fonts", () => {
    expect(OWNER_CSS).not.toMatch(/@import|url\(\s*["']?(?!data:)/);
  });

  test("the document has no inline script or style", () => {
    expect(OWNER_HTML).not.toMatch(/<style|style=|<script(?![^>]*src=)/);
  });

  test("no owner source sets an inline style attribute or raw HTML", () => {
    for (const name of sources) {
      const text = readFileSync(join(webOwner, name), "utf8");
      expect(text, name).not.toMatch(/style=\{\{/);
      expect(text, name).not.toMatch(/dangerouslySetInnerHTML/);
    }
  });

  test("every owner source file is under the 500-line limit", () => {
    for (const name of sources) {
      const lines = readFileSync(join(webOwner, name), "utf8").split(
        "\n",
      ).length;
      expect(lines, name).toBeLessThanOrEqual(500);
    }
  });
});
