// Secret-like material detection and argv redaction. Pattern-based and
// deliberately conservative: a detection refuses the request or the write.
const SECRET_NAME_SOURCE = `(?:api[_-]?key|access[_-]?key|secret[_-]?key|client[_-]?secret|authorization|auth|password|passwd|pass|token|secret|key)`;

const SECRET_PATTERNS: RegExp[] = [
  /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/,
  new RegExp(String.raw`\b${SECRET_NAME_SOURCE}\b\s*[=:]\s*\S+`, "i"),
  /\bbearer\s+[A-Za-z0-9._~+/-]{8,}/i,
  /\bhct_[A-Za-z0-9_-]{16,}/,
];

const SECRET_PLACEHOLDER_ASSIGNMENT = new RegExp(
  String.raw`\b${SECRET_NAME_SOURCE}\b\s*[=:]\s*(?:\{\{[a-z][a-z0-9_-]{0,31}\}\}|\[REDACTED\])(?=["'\s,}\]]|$)`,
  "gi",
);

const SECRET_NAME = new RegExp(
  `(?:^|[^a-z0-9])${SECRET_NAME_SOURCE}(?:$|[^a-z0-9])`,
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
