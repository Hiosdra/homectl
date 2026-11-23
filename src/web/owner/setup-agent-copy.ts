// Plain words, commands and the setup prompt for the "Let your AI agent set it up"
// path (0.3 acceptance). Pure, so the rules can be tested without a browser. The
// owner's password is never part of anything here: the connect command is run in the
// owner's own terminal, and the prompt asks the agent for nothing it may not have.
import type { ClientView } from "./api";
import { setupHash } from "./route";
import type { SetupStatus } from "./setup-api";

export type AgentKind = "claude" | "codex" | "other";

export const AGENT_KINDS: readonly {
  kind: AgentKind;
  label: string;
  line: string;
}[] = [
  {
    kind: "claude",
    label: "Claude Code",
    line: "Anthropic's assistant, used from a terminal.",
  },
  {
    kind: "codex",
    label: "Codex",
    line: "OpenAI's assistant, used from a terminal.",
  },
  {
    kind: "other",
    label: "Another assistant",
    line: "Any assistant that can use MCP tools.",
  },
];

// The one-time command. An assistant the owner already has (same id as its kind)
// is reconnected with --client, which makes a new key. Otherwise a new assistant is
// named after its kind. The CLI plans the change and asks the owner before it runs.
export function connectCommandFor(
  kind: AgentKind,
  clients: ClientView[],
  hosts: string[],
): string {
  const list = hosts.length > 0 ? hosts.join(",") : "<machine>";
  const existing = clients.find(
    (client) => !client.revoked && client.id === kind,
  );
  const target = existing ? `--client ${existing.id}` : `--name ${kind}`;
  return `home-ctl agent connect ${kind} ${target} --hosts ${list}`;
}

// The prompt the owner pastes into the assistant. It names the MCP tools and the
// skills, says what waits for the owner, and forbids asking for secrets.
export const AGENT_PROMPT =
  "Set up homectl for me through its tools. Use the homelab-setup and homelab-enroll skills. Start with setup_status: it lists what is left and the requests you can make. Then call setup_machines and tell me what each machine still needs. To change something, make one request with a setup_ tool (setup_scan, setup_probe, setup_create_key, setup_enroll, setup_access, setup_preset or setup_remove), tell me it is waiting in Needs you, and poll its status until it is final before you make the next one. If a new machine needs its own key, ask with setup_create_key and have me install the public key before scanning. To add a machine, make a setup_scan of its address and wait until I have approved it in Needs you; then make setup_enroll within 30 minutes. Without a recent approved scan the broker refuses setup_enroll, so do not skip the scan. Do not ask me for my vault or owner password, a key or a fingerprint, and do not look for them. Steps marked owner, and what setup_status lists as owner-only, are mine: tell me exactly what to do in the homectl panel and wait for me. When a machine's key has to be checked, tell me to compare it in Needs you; I type it there. When you finish, call setup_status again and tell me what is still open.";

// One line above the checklist, saying what happens next.
export function agentProgressLine(status: SetupStatus): string {
  if (status.completed) return "homectl is set up.";
  if (status.facts.assistants === 0)
    return "Waiting for your assistant. Run the command in your terminal first. This page updates by itself.";
  if (status.facts.connectedAssistants === 0)
    return "Waiting for your assistant to reach homectl. Paste the prompt into it. This page updates by itself.";
  return "Your assistant is connected. Each change it asks for waits in Needs you.";
}

// Where the owner lands when they choose the step-by-step path: the first step that is
// still open, or the finished page once every required step is done.
export function manualTarget(status: SetupStatus | undefined): string {
  if (status?.completed) return setupHash("done");
  return setupHash(status?.next ?? "vault");
}

export function requestsWaitingLine(count: number): string {
  if (count === 0) return "Nothing is waiting for you.";
  if (count === 1) return "One request is waiting for you.";
  return `${count} requests are waiting for you.`;
}
