// The "Let your AI agent set it up" path in the owner panel (0.3 acceptance): the two
// cards on Welcome, the path switch, the agent page's four stages, the Needs you link,
// the done state, and the connect command and prompt. Rendered to static markup, so
// the page is checked without a browser: no inline styles, and no owner password.
import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { PendingOperation } from "../src/web/owner/api";
import { AGENT_SETUP_CSS } from "../src/web/owner/css-agent-setup";
import { OWNER_CSS } from "../src/web/owner/shell";
import { AgentSetupPage } from "../src/web/owner/setup-agent";
import {
  AGENT_PROMPT,
  agentProgressLine,
  connectCommandFor,
  manualTarget,
  requestsWaitingLine,
} from "../src/web/owner/setup-agent-copy";
import type { SetupStatus } from "../src/web/owner/setup-api";
import {
  pathTarget,
  PATH_CARDS,
  PathChoice,
} from "../src/web/owner/setup-path";
import { SetupScreen } from "../src/web/owner/setup-screen";

const facts = {
  vault: false,
  machines: 0,
  readyMachines: 0,
  assistants: 0,
  connectedAssistants: 0,
  requests: 0,
  resolvedApprovals: 0,
  permissionsRevision: 0,
  workspaceServer: false,
  pairedDevices: 0,
};

function status(over: Partial<SetupStatus> = {}): SetupStatus {
  return {
    welcomed: true,
    completed: false,
    dismissed: false,
    path: null,
    steps: [],
    next: "vault",
    counts: { required: 5, requiredDone: 0, optional: 2, optionalDone: 0 },
    facts,
    ...over,
  };
}

function pending(): PendingOperation {
  return {
    id: "op_test",
    state: "awaiting-approval",
    client: "codex",
    host: "nas",
    argv: ["uname", "-a"],
    impact: "Read the system name",
    classification: "read",
    risk: "R1",
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
  } as PendingOperation;
}

const noop = () => undefined;

describe("the two paths on Welcome", () => {
  test("the choice offers both cards, with their plain names", () => {
    expect(PATH_CARDS.map((card) => card.title)).toEqual([
      "Set it up step by step",
      "Let your AI agent set it up for you",
    ]);
    const html = renderToStaticMarkup(
      <PathChoice
        status={status()}
        onChanged={noop}
        onGo={noop}
        onError={noop}
      />,
    );
    expect(html).toContain("Set it up step by step");
    expect(html).toContain("Let your AI agent set it up for you");
    expect(html).toContain("How do you want to set up homectl?");
  });

  test("the saved choice is marked and the other card is not", () => {
    const html = renderToStaticMarkup(
      <PathChoice
        status={status({ path: "agent" })}
        onChanged={noop}
        onGo={noop}
        onError={noop}
      />,
    );
    expect(html).toContain("Your choice");
    expect(html.match(/aria-pressed="true"/g)?.length).toBe(1);
    expect(html).toContain('aria-pressed="false"');
  });

  test("the Welcome page shows the choice and no longer a bare Start button", () => {
    const html = renderToStaticMarkup(
      <SetupScreen
        step="welcome"
        status={status({ welcomed: false, path: null })}
        operations={[]}
        onGo={noop}
        onChanged={noop}
        onError={noop}
      />,
    );
    expect(html).toContain("Let your AI agent set it up for you");
    expect(html).toContain("Set it up step by step");
    expect(html).not.toContain(">Start setup<");
  });

  test("picking a card goes to the agent page, or to the first open step", () => {
    expect(pathTarget("agent", status())).toBe("#/setup/agent");
    expect(pathTarget("manual", status({ next: "machine" }))).toBe(
      "#/setup/machine",
    );
  });
});

describe("the path switch", () => {
  test("a wizard step offers the agent path without losing the step", () => {
    const html = renderToStaticMarkup(
      <SetupScreen
        step="machine"
        status={status({ welcomed: true, next: "machine" })}
        operations={[]}
        onGo={noop}
        onChanged={noop}
        onError={noop}
      />,
    );
    expect(html).toContain("Let your AI agent set it up instead");
    expect(html).toContain("Add your first machine");
  });

  test("manual target is the first open step, or the finished page when complete", () => {
    expect(manualTarget(undefined)).toBe("#/setup/vault");
    expect(manualTarget(status({ next: "machine" }))).toBe("#/setup/machine");
    expect(manualTarget(status({ completed: true, next: null }))).toBe(
      "#/setup/done",
    );
  });
});

describe("the agent page", () => {
  test("it shows the four stages in order", () => {
    const html = renderToStaticMarkup(
      <AgentSetupPage
        status={status({ path: "agent" })}
        operations={[]}
        onChanged={noop}
        onGo={noop}
        onError={noop}
      />,
    );
    const order = [
      "1. Connect your assistant",
      "2. Give your assistant this prompt",
      "3. Follow the progress",
    ].map((title) => html.indexOf(title));
    for (const index of order) expect(index).toBeGreaterThan(-1);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(html).toContain("Copy setup prompt");
    expect(html).toContain("Copy connect command");
  });

  test("the connect command is the one-time command, with a placeholder until machines load", () => {
    const html = renderToStaticMarkup(
      <AgentSetupPage
        status={status({ path: "agent" })}
        operations={[]}
        onChanged={noop}
        onGo={noop}
        onError={noop}
      />,
    );
    expect(html).toContain(
      "home-ctl agent connect claude --name claude --hosts &lt;machine&gt;",
    );
    expect(html).toContain("You type your owner password there");
  });

  test("the prompt names the setup tools and never asks for a secret", () => {
    expect(AGENT_PROMPT).toContain("setup_status");
    expect(AGENT_PROMPT).toContain("setup_machines");
    expect(AGENT_PROMPT).toContain("Needs you");
    expect(AGENT_PROMPT).toContain(
      "Do not ask me for my vault or owner password",
    );
    const html = renderToStaticMarkup(
      <AgentSetupPage
        status={status({ path: "agent" })}
        operations={[]}
        onChanged={noop}
        onGo={noop}
        onError={noop}
      />,
    );
    expect(html).not.toContain("hc_owner");
    expect(html).not.toContain("passphrase");
  });

  test("a request waiting for the owner is linked to Needs you", () => {
    const html = renderToStaticMarkup(
      <AgentSetupPage
        status={status({ path: "agent" })}
        operations={[pending()]}
        onChanged={noop}
        onGo={noop}
        onError={noop}
      />,
    );
    expect(html).toContain("One request is waiting for you.");
    expect(html).toContain('href="#/"');
    expect(html).toContain("Open Needs you");
  });

  test("when nothing waits, no Needs you alert is shown", () => {
    const html = renderToStaticMarkup(
      <AgentSetupPage
        status={status({ path: "agent" })}
        operations={[]}
        onChanged={noop}
        onGo={noop}
        onError={noop}
      />,
    );
    expect(html).not.toContain("waiting for you");
  });

  test("the done state says so and still offers Needs you and the other path", () => {
    const html = renderToStaticMarkup(
      <AgentSetupPage
        status={status({
          path: "agent",
          completed: true,
          next: null,
          counts: {
            required: 5,
            requiredDone: 5,
            optional: 2,
            optionalDone: 0,
          },
        })}
        operations={[]}
        onChanged={noop}
        onGo={noop}
        onError={noop}
      />,
    );
    expect(html).toContain("You&#x27;re set up.");
    expect(html).toContain("Set it up step by step instead");
  });

  test("no inline styles reach the markup (the panel's CSP forbids them)", () => {
    const html = renderToStaticMarkup(
      <AgentSetupPage
        status={status({ path: "agent" })}
        operations={[pending()]}
        onChanged={noop}
        onGo={noop}
        onError={noop}
      />,
    );
    expect(html).not.toContain("style=");
  });
});

describe("the connect command", () => {
  const client = (id: string, revoked = false) => ({
    id,
    name: id,
    hosts: ["nas"],
    revoked,
    createdAt: 1,
  });

  test("a new assistant is named after its kind and given the machines", () => {
    expect(connectCommandFor("codex", [], ["nas", "pve"])).toBe(
      "home-ctl agent connect codex --name codex --hosts nas,pve",
    );
  });

  test("an assistant already connected under that id is reconnected, not duplicated", () => {
    expect(connectCommandFor("claude", [client("claude")], ["nas"])).toBe(
      "home-ctl agent connect claude --client claude --hosts nas",
    );
  });

  test("a revoked assistant is not reused", () => {
    expect(connectCommandFor("claude", [client("claude", true)], ["nas"])).toBe(
      "home-ctl agent connect claude --name claude --hosts nas",
    );
  });

  test("without machines a visible placeholder stands in", () => {
    expect(connectCommandFor("other", [], [])).toContain("--hosts <machine>");
  });
});

describe("progress wording", () => {
  test("it says what the owner is waiting on, in order", () => {
    expect(agentProgressLine(status({ completed: true }))).toBe(
      "homectl is set up.",
    );
    expect(agentProgressLine(status())).toContain("Run the command");
    expect(
      agentProgressLine(
        status({ facts: { ...facts, assistants: 1, connectedAssistants: 0 } }),
      ),
    ).toContain("Paste the prompt");
    expect(
      agentProgressLine(
        status({ facts: { ...facts, assistants: 1, connectedAssistants: 1 } }),
      ),
    ).toContain("waits in Needs you");
  });

  test("the waiting count reads plainly", () => {
    expect(requestsWaitingLine(0)).toBe("Nothing is waiting for you.");
    expect(requestsWaitingLine(1)).toBe("One request is waiting for you.");
    expect(requestsWaitingLine(3)).toBe("3 requests are waiting for you.");
  });
});

describe("the stylesheet", () => {
  test("the agent path styles load with the panel and reference no outside resource", () => {
    expect(OWNER_CSS).toContain(".path-card");
    expect(AGENT_SETUP_CSS).not.toContain("url(");
    expect(AGENT_SETUP_CSS).not.toContain("@import");
  });
});
