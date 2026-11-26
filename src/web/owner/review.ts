// What the panel shows for an operation the Auto Mode reviewer is still deciding
// (decision source "review", homelab #21 §10). The reviewer has no verdict yet,
// so the owner may approve or deny it, but nothing is saved as a rule from it:
// "approve and remember" is not offered. The broker enforces the same rule; this
// only decides which buttons exist.

export const UNDER_REVIEW_SOURCE = "review";

export function isUnderReview(source: string | undefined): boolean {
  return source === UNDER_REVIEW_SOURCE;
}

// Whether "approve and remember" may be offered for an operation. Human-only
// operations never become rules, and an operation still under review does not
// yet have a verdict to remember. Deny-and-remember is not governed here.
export function approveRememberOffered(decision: {
  humanOnly?: boolean;
  source?: string;
}): boolean {
  return decision.humanOnly !== true && !isUnderReview(decision.source);
}

export const UNDER_REVIEW_NOTE =
  "Under review: the AI helper that checks requests has not decided yet. You can still decide it yourself; approving it does not save a rule.";
