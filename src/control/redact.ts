// Secret-like material detection and argv redaction. Pattern-based and
// deliberately conservative.
//
// containsSecretMaterial is a refusal check (control-plane plans, reasons,
// replicated values, journal writes). Its patterns are exactly the 0.2.1 set
// and must not grow: a broader match would refuse operations already accepted.
// Broader name matching lives only in redactArgv, which redacts and never refuses.
const SECRET_PATTERNS: RegExp[] = [
  /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/,
  /\b(?:password|passwd|pass|token|secret|api[_-]?key|authorization)\b\s*[=:]\s*\S+/i,
  /\bbearer\s+[A-Za-z0-9._~+/-]{8,}/i,
  /\bhct_[A-Za-z0-9_-]{16,}/,
];

const SECRET_PLACEHOLDER_ASSIGNMENT =
  /\b(?:password|passwd|pass|token|secret|api[_-]?key|authorization)\b\s*[=:]\s*(?:\{\{[a-z][a-z0-9_-]{0,31}\}\}|\[REDACTED\])(?=["'\s,}\]]|$)/gi;

// Name fragments for argv redaction. Substring match for the master names
// (so `--dbpassword`, `--authtoken`, `PGPASSWORD` stay redacted); whole-word
// match for the short names (so `--author` is not redacted).
const SECRET_NAME_SUBSTRING_SOURCE =
  "password|passwd|passphrase|token|secret|api[_-]?key|authorization";
const SECRET_NAME_WORD_SOURCE =
  "(?:^|[^a-z0-9])(?:pass|auth|key|access[_-]?key)(?![a-z0-9])";

const SECRET_NAME = new RegExp(
  `(?:${SECRET_NAME_SUBSTRING_SOURCE})|${SECRET_NAME_WORD_SOURCE}`,
  "i",
);

const SECRET_NAME_ASSIGNMENT = new RegExp(
  `(?:${SECRET_NAME_SUBSTRING_SOURCE})[a-z0-9_-]*\\s*[=:]\\s*\\S+|${SECRET_NAME_WORD_SOURCE}\\s*[=:]\\s*\\S+`,
  "i",
);

export const AUDIT_NORMALIZATION_MARKERS = {
  redacted: "[REDACTED]",
  emptyArgument: "[empty argument]",
  truncatedArgument: "...[truncated]",
  noArguments: "[no arguments]",
  truncatedArgumentsPrefix: "[truncated ",
  truncatedArgumentsSuffix: " arguments]",
} as const;

export function containsSecretMaterial(text: string): boolean {
  return SECRET_PATTERNS.some((pattern) => pattern.test(text));
}

export function containsSecretMaterialAllowingTemplatePlaceholders(
  text: string,
): boolean {
  const withoutPlaceholders = text.replace(SECRET_PLACEHOLDER_ASSIGNMENT, " ");
  return SECRET_PATTERNS.some((pattern) => pattern.test(withoutPlaceholders));
}

// Whether an option or variable name is one redactArgv treats as secret-carrying.
export function isSecretOptionName(name: string): boolean {
  return SECRET_NAME.test(name);
}

export function containsRedactionMarker(argv: readonly string[]): boolean {
  return argv.some(
    (arg) =>
      Object.values(AUDIT_NORMALIZATION_MARKERS).some(
        (marker) => marker && arg.includes(marker),
      ) || /\[truncated \d+ arguments\]/i.test(arg),
  );
}

// Redacts values that follow secret-looking option names, in both
// `--name=value` and `--name value` forms, and any element that itself looks
// like secret material. Exactly the 0.2.1 behaviour: this is what approvers,
// MCP clients and replicas see, so it must never hide more of a command than
// planning would refuse (a hidden `KEY=1; curl … | sh` would be approved blind).
const CONTROL_PLANE_SECRET_NAME =
  /(?:password|passwd|token|secret|api[_-]?key|authorization)/i;
export function redactArgv(argv: string[]): string[] {
  const out: string[] = [];
  let redactNext = false;
  for (const arg of argv) {
    if (redactNext) {
      out.push(AUDIT_NORMALIZATION_MARKERS.redacted);
      redactNext = false;
      continue;
    }
    const equals = arg.indexOf("=");
    if (equals > 0 && CONTROL_PLANE_SECRET_NAME.test(arg.slice(0, equals))) {
      out.push(
        `${arg.slice(0, equals)}=${AUDIT_NORMALIZATION_MARKERS.redacted}`,
      );
      continue;
    }
    if (containsSecretMaterial(arg)) {
      out.push(AUDIT_NORMALIZATION_MARKERS.redacted);
      continue;
    }
    if (arg.startsWith("-") && CONTROL_PLANE_SECRET_NAME.test(arg)) {
      out.push(arg);
      redactNext = true;
      continue;
    }
    out.push(arg);
  }
  return out;
}

// Broader redaction for local command history and saved-command screening: a
// superset of redactArgv. Never use it for anything an approver reviews.
export function redactArgvBroad(argv: string[]): string[] {
  const out: string[] = [];
  let redactNext = false;
  for (const arg of argv) {
    if (redactNext) {
      out.push(AUDIT_NORMALIZATION_MARKERS.redacted);
      redactNext = false;
      continue;
    }
    const equals = arg.indexOf("=");
    if (equals > 0 && SECRET_NAME.test(arg.slice(0, equals))) {
      out.push(
        `${arg.slice(0, equals)}=${AUDIT_NORMALIZATION_MARKERS.redacted}`,
      );
      continue;
    }
    if (containsSecretMaterial(arg) || SECRET_NAME_ASSIGNMENT.test(arg)) {
      out.push(AUDIT_NORMALIZATION_MARKERS.redacted);
      continue;
    }
    if (/[=:]\s*$/.test(arg) && SECRET_NAME.test(arg)) {
      out.push(arg);
      redactNext = true;
      continue;
    }
    if (arg.startsWith("-") && SECRET_NAME.test(arg)) {
      out.push(arg);
      redactNext = true;
      continue;
    }
    out.push(arg);
  }
  return out;
}
