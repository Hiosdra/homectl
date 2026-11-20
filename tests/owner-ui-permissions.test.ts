// Owner panel: the Permissions screen speaks plain words by default. Risk levels,
// scopes, endpoints and identifiers stay available under Details, each with a
// short plain explanation. The browser check (scripts/owner-ui-permissions.ts)
// proves the same on the rendered page; these rules keep the copy honest.
import { describe, expect, test } from "bun:test";
import type { EffectiveView, PolicyRule } from "../src/web/owner/api";
import {
  authorityHint,
  authorityLabel,
  effectLabel,
  modeHint,
  modeLabel,
  PRESETS,
  presetLabel,
  RISK_LEVELS,
  riskPhrase,
  WORDS,
} from "../src/web/owner/permissions-copy";
import {
  pairSentence,
  ruleCovers,
  ruleFacts,
} from "../src/web/owner/policy-sentences";

// Words that must not appear in the default view. Each one is explained under
// Details instead.
const JARGON = [
  /\bR[0-4]\b/,
  /\bscopes?\b/i,
  /\bendpoints?\b/i,
  /\bidentifiers?\b/i,
  /\breviewer\b/i,
  /\bpresets?\b/i,
  /\brevision\b/i,
  /\bargv/i,
  /\bhard gates?\b/i,
  /\bbudgets?\b/i,
  /\bkinds?\b/i,
  /\bclients?\b/i,
  /\bhosts?\b/i,
  /\bclassifications?\b/i,
  /\bmaxRisk\b/,
  /\bexec\b/i,
];

const defaultRule: PolicyRule = {
  id: "default-inspect",
  effect: "allow",
  match: {
    kinds: ["exec"],
    classifications: ["inspect"],
    maxRisk: "R1",
    sudo: false,
  },
  note: "Built-in: read-only inspection without a prompt",
  createdBy: "owner",
  createdAt: 0,
};

const exactRule: PolicyRule = {
  id: "rule-restart",
  effect: "allow",
  match: {
    clients: ["codex-pc"],
    hosts: ["nas"],
    kinds: ["exec"],
    argvExact: [["docker", "restart", "app"]],
    maxRisk: "R2",
  },
  createdBy: "owner",
  createdAt: 1,
};

const names = { "codex-pc": "Codex" };

function view(
  overrides: Partial<EffectiveView>,
  applies: string[] = ["default-inspect"],
): EffectiveView {
  return {
    revision: 3,
    mode: "rules",
    reviewerAuthority: "recommend",
    rules: applies.map((ruleId) => ({
      ruleId,
      effect: "allow",
      applies: true,
      reasons: [],
    })),
    ...overrides,
  };
}

function defaultCopy(): string[] {
  return [
    ...PRESETS.flatMap((preset) => [preset.label, preset.hint]),
    ...(["manual", "rules", "auto"] as const).flatMap((mode) => [
      modeLabel(mode),
      modeHint(mode),
    ]),
    ...(["recommend", "routine", "delegated"] as const).flatMap((authority) => [
      authorityLabel(authority),
      authorityHint(authority),
    ]),
    effectLabel("allow"),
    effectLabel("deny"),
    effectLabel("ask"),
    ...["R0", "R1", "R2", "R3", "R4"].map(riskPhrase),
    ruleCovers(defaultRule, names),
    ruleCovers(exactRule, names),
    pairSentence({
      name: "Claude",
      machine: "nas",
      view: view({}),
      rules: [defaultRule],
      reviewerReady: false,
    }),
  ];
}

describe("the default view has no technical words", () => {
  test("labels, hints, sentences and rule summaries avoid the jargon list", () => {
    for (const text of defaultCopy())
      for (const word of JARGON)
        expect({ text, matched: word.test(text) }).toEqual({
          text,
          matched: false,
        });
  });

  test("the preset names read as everyday choices", () => {
    expect(PRESETS.map((preset) => preset.label)).toEqual([
      "Ask me first",
      "Small fixes on their own",
      "Let the AI helper decide more (advanced)",
    ]);
    expect(presetLabel(undefined)).toBe("Custom");
  });
});

describe("the technical names stay available under Details, explained", () => {
  test("every risk level has a plain meaning", () => {
    expect(RISK_LEVELS.map((risk) => risk.level)).toEqual([
      "R0",
      "R1",
      "R2",
      "R3",
      "R4",
    ]);
    for (const risk of RISK_LEVELS)
      expect(risk.meaning.length).toBeGreaterThan(20);
  });

  test("each technical term has a short explanation", () => {
    const terms = WORDS.map((word) => word.term);
    for (const term of [
      "Assistant",
      "Machine",
      "Address (endpoint)",
      "Limits (budgets)",
      "Task (scope)",
      "Revision",
      "AI helper",
    ])
      expect(terms).toContain(term);
    for (const word of WORDS) expect(word.meaning.length).toBeGreaterThan(20);
  });

  test("a stored key is explained where a rule is shown under Why?", () => {
    const facts = ruleFacts(exactRule, names);
    expect(facts.map((fact) => fact.key)).toEqual(
      expect.arrayContaining(["clients", "hosts", "argvExact", "maxRisk"]),
    );
    for (const fact of facts)
      expect(fact.meaning).not.toBe("Stored as this key.");
    expect(facts.find((fact) => fact.key === "clients")?.value).toBe("Codex");
  });
});

describe("sentences for one assistant on one machine", () => {
  test("looking around is allowed and changes ask, in the default setting", () => {
    expect(
      pairSentence({
        name: "Claude",
        machine: "nas",
        view: view({}),
        rules: [defaultRule],
        reviewerReady: false,
      }),
    ).toBe(
      "Claude can look around on nas without asking. It asks you before it changes anything.",
    );
  });

  test("no rule covering looking around means it asks first", () => {
    expect(
      pairSentence({
        name: "Claude",
        machine: "nas",
        view: view({}, []),
        rules: [defaultRule],
        reviewerReady: false,
      }),
    ).toBe(
      "Claude asks you before it looks around on nas. It asks you before it changes anything.",
    );
  });

  test("a block on looking around is said plainly", () => {
    const deny: PolicyRule = {
      id: "no-nas",
      effect: "deny",
      match: { kinds: ["exec"], hosts: ["nas"] },
      createdBy: "owner",
      createdAt: 2,
    };
    const sentence = pairSentence({
      name: "Claude",
      machine: "nas",
      view: view({}, ["no-nas", "default-inspect"]),
      rules: [defaultRule, deny],
      reviewerReady: false,
    });
    expect(sentence).toContain("Claude is blocked from looking around on nas.");
    expect(sentence).toContain("Some changes are blocked by your rules.");
  });

  test("a saved rule that covers small changes says so", () => {
    const sentence = pairSentence({
      name: "Codex",
      machine: "nas",
      view: view({}, ["default-inspect", "rule-restart"]),
      rules: [defaultRule, exactRule],
      reviewerReady: false,
    });
    expect(sentence).toContain(
      "Some changes run without asking, because of your saved rules.",
    );
  });

  test("the AI helper is only described as deciding when it is ready", () => {
    const auto = view({
      mode: "auto",
      reviewerAuthority: "routine",
    });
    const ready = pairSentence({
      name: "Claude",
      machine: "nas",
      view: auto,
      rules: [defaultRule],
      reviewerReady: true,
    });
    expect(ready).toContain(
      "The AI helper may approve small, undoable changes; big or risky ones still ask you.",
    );
    const notReady = pairSentence({
      name: "Claude",
      machine: "nas",
      view: auto,
      rules: [defaultRule],
      reviewerReady: false,
    });
    expect(notReady).toContain("It asks you before it changes anything.");
    expect(notReady).not.toContain("AI helper may");
  });

  test("a rule covers an exact command in plain words", () => {
    expect(ruleCovers(exactRule, names)).toBe(
      'the exact command "docker restart app" for Codex on nas, up to small, undoable changes',
    );
    expect(ruleCovers(defaultRule, names)).toBe(
      "looking around for any assistant on any machine",
    );
  });
});
