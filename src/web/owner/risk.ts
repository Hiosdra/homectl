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
