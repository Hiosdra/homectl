// Secret-like material detection and argv redaction. Pattern-based and
// deliberately conservative: a detection refuses the request or the write.
const SECRET_PATTERNS: RegExp[] = [
  /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/,
  /\b(?:password|passwd|pass|token|secret|api[_-]?key|authorization)\b\s*[=:]\s*\S+/i,
  /\bbearer\s+[A-Za-z0-9._~+/-]{8,}/i,
  /\bhct_[A-Za-z0-9_-]{16,}/,
];

const SECRET_NAME =
  /(?:password|passwd|token|secret|api[_-]?key|authorization)/i;

export function containsSecretMaterial(text: string): boolean {
  return SECRET_PATTERNS.some((pattern) => pattern.test(text));
}

// Redacts values that follow secret-looking option names, in both
// `--name=value` and `--name value` forms, and any element that itself looks
// like secret material.
export function redactArgv(argv: string[]): string[] {
  const out: string[] = [];
  let redactNext = false;
  for (const arg of argv) {
    if (redactNext) {
      out.push("[REDACTED]");
      redactNext = false;
      continue;
    }
    const equals = arg.indexOf("=");
    if (equals > 0 && SECRET_NAME.test(arg.slice(0, equals))) {
      out.push(`${arg.slice(0, equals)}=[REDACTED]`);
      continue;
    }
    if (containsSecretMaterial(arg)) {
      out.push("[REDACTED]");
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
