// Secret-like material detection and argv redaction. Pattern-based and
// deliberately conservative: a detection refuses the request or the write.
const SECRET_PATTERNS: RegExp[] = [
  /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/,
  /\b(?:password|passwd|pass|token|secret|api[_-]?key|authorization)\b\s*[=:]\s*\S+/i,
  /\bbearer\s+[A-Za-z0-9._~+/-]{8,}/i,
  /\bhct_[A-Za-z0-9_-]{16,}/,
];

const SECRET_PLACEHOLDER_ASSIGNMENT =
  /\b(?:password|passwd|pass|token|secret|api[_-]?key|authorization)\b\s*[=:]\s*(?:\{\{[a-z][a-z0-9_-]{0,31}\}\}|\[REDACTED\])(?=["'\s,}\]]|$)/gi;

const SECRET_NAME =
  /(?:password|passwd|token|secret|api[_-]?key|authorization)/i;

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
// like secret material.
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
    if (equals > 0 && SECRET_NAME.test(arg.slice(0, equals))) {
      out.push(
        `${arg.slice(0, equals)}=${AUDIT_NORMALIZATION_MARKERS.redacted}`,
      );
      continue;
    }
    if (containsSecretMaterial(arg)) {
      out.push(AUDIT_NORMALIZATION_MARKERS.redacted);
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

export function normalizeAuditArgv(argv: string[]): string[] {
  const redacted = redactArgv(argv).map((arg) => {
    if (!arg) return AUDIT_NORMALIZATION_MARKERS.emptyArgument;
    const marker = AUDIT_NORMALIZATION_MARKERS.truncatedArgument;
    return arg.length > 4096
      ? `${arg.slice(0, 4096 - marker.length)}${marker}`
      : arg;
  });
  if (!redacted.length) return [AUDIT_NORMALIZATION_MARKERS.noArguments];
  if (redacted.length <= 64) return redacted;
  return [
    ...redacted.slice(0, 63),
    `${AUDIT_NORMALIZATION_MARKERS.truncatedArgumentsPrefix}${redacted.length - 63}${AUDIT_NORMALIZATION_MARKERS.truncatedArgumentsSuffix}`,
  ];
}
