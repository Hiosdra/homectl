// The four words an owner sees for a command's risk. The broker's codes (R0-R4)
// stay in Details; the words are shown with colour and an icon, never colour alone.
import type { IconName } from "./icons";
import type { Tone } from "./ui";

export interface RiskView {
  // "look", "small", "big" or "destructive": the request card's stripe.
  stripe: "look" | "small" | "big" | "destructive";
  label: string;
  tone: Tone;
  icon: IconName;
  // A short phrase for a sentence, such as "small, undoable changes".
  phrase: string;
}

export function riskView(level: string | undefined): RiskView {
  switch (level) {
    case "R0":
    case "R1":
      return {
        stripe: "look",
        label: "Looks around",
        tone: "info",
        icon: "eye",
        phrase: "looking around, with no changes",
      };
    case "R2":
      return {
        stripe: "small",
        label: "Small change",
        tone: "good",
        icon: "pencil",
        phrase: "a small, undoable change",
      };
    case "R3":
      return {
        stripe: "big",
        label: "Big change",
        tone: "warn",
        icon: "alert",
        phrase: "a big or risky change",
      };
    case "R4":
      return {
        stripe: "destructive",
        label: "Destructive",
        tone: "bad",
        icon: "trash",
        phrase: "a destructive change",
      };
    default:
      return {
        stripe: "big",
        label: "Needs a look",
        tone: "warn",
        icon: "info",
        phrase: "a change homectl could not classify",
      };
  }
}

// The badge on a Needs-you card says what the action does, in plain words. The
// risk tier (R1-R4) still sets the card's colour and the approval rules, and it stays
// in Details under "Risk level".
export type ActionLabel =
  | "Just looks"
  | "Changes things"
  | "Changes permissions"
  | "Gives access"
  | "Removes"
  | "Deletes"
  | "Needs a look";

const SETUP_ACTION: Record<string, ActionLabel> = {
  scan: "Just looks",
  probe: "Just looks",
  enroll: "Gives access",
  access: "Changes permissions",
  preset: "Changes permissions",
  "ai-helper": "Changes permissions",
  "sudo-grant": "Gives access",
  remove: "Removes",
};

const CLASS_ACTION: Record<string, ActionLabel> = {
  inspect: "Just looks",
  mutation: "Changes things",
  destructive: "Deletes",
  opaque: "Needs a look",
};

const ACTION_ICON: Record<ActionLabel, IconName> = {
  "Just looks": "eye",
  "Changes things": "pencil",
  "Changes permissions": "key",
  "Gives access": "key",
  Removes: "trash",
  Deletes: "trash",
  "Needs a look": "info",
};

// The action's label: a setup request by its kind, anything else by its class. A
// card with no class (a linked client's request) falls back to its risk tier.
const TIER_ACTION: Record<string, ActionLabel> = {
  R0: "Just looks",
  R1: "Just looks",
  R2: "Changes things",
  R3: "Changes things",
  R4: "Deletes",
};

export function actionLabel(operation: {
  risk: string;
  classification?: string;
  setup?: { kind: string };
}): ActionLabel {
  const kind = operation.setup?.kind;
  if (kind !== undefined && SETUP_ACTION[kind] !== undefined)
    return SETUP_ACTION[kind];
  if (operation.classification !== undefined)
    return CLASS_ACTION[operation.classification] ?? "Needs a look";
  return TIER_ACTION[operation.risk] ?? "Needs a look";
}

// The card's badge: the action's words and icon, with the tier's colour.
export function actionView(operation: {
  risk: string;
  classification?: string;
  setup?: { kind: string };
}): RiskView {
  const label = actionLabel(operation);
  return { ...riskView(operation.risk), label, icon: ACTION_ICON[label] };
}

// Whether one tap may approve a request straight from the list. Only small or
// lower-risk requests that need no owner password qualify. Everything else is
// approved on its detail screen, where the exact command is shown first.
export function canApproveFromList(request: {
  risk: string;
  decision: { stepUp?: boolean };
}): boolean {
  return (
    request.decision.stepUp !== true &&
    (request.risk === "R0" || request.risk === "R1" || request.risk === "R2")
  );
}
