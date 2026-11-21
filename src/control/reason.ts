// The reason written to the audit journal with a rejected request. The journal
// schema caps a reason at 120 characters, and verification rejects any entry
// over that cap. Engine error messages can be longer, so they are shortened here,
// at the point they are written, instead of breaking the chain later.
export const AUDIT_REASON_MAX = 120;

export function auditReason(message: string): string {
  const oneLine = message.replace(/\s+/g, " ").trim();
  if (oneLine.length === 0) return "request refused";
  if (oneLine.length <= AUDIT_REASON_MAX) return oneLine;
  const cut = oneLine.slice(0, AUDIT_REASON_MAX - 3);
  const space = cut.lastIndexOf(" ");
  const kept = space > AUDIT_REASON_MAX / 2 ? cut.slice(0, space) : cut;
  return `${kept}...`;
}
