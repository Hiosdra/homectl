// The choice between the two ways to set homectl up (0.3 acceptance): click through the
// steps here, or let the owner's AI agent do the setup work. The choice is saved by the
// broker, so it survives a reload, and either card can be picked again at any time.
// Choosing a card changes no step and grants nothing.
import { useState } from "react";
import { setupHash } from "./route";
import { markSetup, type SetupPath, type SetupStatus } from "./setup-api";
import { manualTarget } from "./setup-agent-copy";
import { Badge } from "./ui";

export const PATH_CARDS: readonly {
  path: SetupPath;
  title: string;
  line: string;
}[] = [
  {
    path: "manual",
    title: "Set it up step by step",
    line: "You go through each step here. Each one shows what to do, and you do it yourself.",
  },
  {
    path: "agent",
    title: "Let your AI agent set it up for you",
    line: "Your assistant does the work through homectl. Every change it asks for waits for your approval in Needs you.",
  },
];

// Where a path leads: the agent page, or the first open step of the wizard.
export function pathTarget(path: SetupPath, status: SetupStatus | undefined) {
  return path === "agent" ? setupHash("agent") : manualTarget(status);
}

interface PathProps {
  status: SetupStatus;
  onChanged: (next: SetupStatus) => void;
  onGo: (hash: string) => void;
  onError: (error: unknown) => unknown;
}

// Saves the path and goes there. A failed save keeps the page as it was.
function useChoose({ onChanged, onGo, onError }: PathProps) {
  const [busy, setBusy] = useState<SetupPath | undefined>();
  const choose = async (path: SetupPath) => {
    setBusy(path);
    try {
      const next = await markSetup({ action: "path", path });
      onChanged(next);
      onGo(pathTarget(path, next));
    } catch (failure) {
      onError(failure);
    } finally {
      setBusy(undefined);
    }
  };
  return { busy, choose };
}

// The two cards on Welcome. The chosen one is marked; both stay clickable.
export function PathChoice(props: PathProps) {
  const { busy, choose } = useChoose(props);
  const chosen = props.status.path;
  return (
    <section className="path-choice" aria-labelledby="path-choice-title">
      <h3 id="path-choice-title">How do you want to set up homectl?</h3>
      <p className="small muted">
        You can switch at any time. Picking one does not change any step.
      </p>
      <div className="path-cards">
        {PATH_CARDS.map((card) => (
          <button
            key={card.path}
            type="button"
            className={`path-card${chosen === card.path ? " is-chosen" : ""}`}
            aria-pressed={chosen === card.path}
            disabled={busy !== undefined}
            onClick={() => void choose(card.path)}
          >
            <span className="path-card-title">{card.title}</span>
            <span className="small muted">{card.line}</span>
            {chosen === card.path ? (
              <Badge tone="neutral">Your choice</Badge>
            ) : null}
          </button>
        ))}
      </div>
    </section>
  );
}

// A link-style switch to the other path, shown on every page of its own path.
export function PathSwitch(props: PathProps & { to: SetupPath }) {
  const { busy, choose } = useChoose(props);
  const label =
    props.to === "agent"
      ? "Let your AI agent set it up instead"
      : "Set it up step by step instead";
  return (
    <button
      type="button"
      className="setup-link-button"
      disabled={busy !== undefined}
      onClick={() => void choose(props.to)}
    >
      {label}
    </button>
  );
}
