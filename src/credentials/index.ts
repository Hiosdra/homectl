import { type Auth, HomectlError, type ProcessSpec } from "../types";
export function credentialSpec(
  auth: Auth | undefined,
  spec: ProcessSpec,
  workerPath: string,
): ProcessSpec {
  if (!auth) return spec;
  if (auth.type !== "keepassxc" || !auth.socket)
    throw new HomectlError(2, "SSH requires a managed KeePassXC key reference");
  return {
    argv: [process.execPath, workerPath],
    stdin: JSON.stringify({
      ...spec,
      env: { ...spec.env, SSH_AUTH_SOCK: auth.socket },
    }),
    timeoutMs: (spec.timeoutMs ?? 120_000) + 5000,
  };
}

export function redactor(secrets: string[]) {
  const values = secrets
    .filter(Boolean)
    .flatMap((v) => [
      v,
      encodeURIComponent(v),
      Buffer.from(v).toString("base64"),
    ])
    .sort((a, b) => b.length - a.length);
  return (text: string) => {
    let result = text;
    for (const secret of values)
      result = result.split(secret).join("[REDACTED]");
    return result
      .replace(
        /-----BEGIN [\w ]*PRIVATE KEY-----[\s\S]*?-----END [\w ]*PRIVATE KEY-----/g,
        "[REDACTED PRIVATE KEY]",
      )
      .replace(
        /((?:password|passwd|token|api[_-]?key|secret)\s*[=:]\s*)[^\s,;]+/gi,
        "$1[REDACTED]",
      );
  };
}
export function cleanEnv(
  source: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of [
    "PATH",
    "HOME",
    "USER",
    "LOGNAME",
    "LANG",
    "LC_ALL",
    "TMPDIR",
    "SSH_AUTH_SOCK",
    "XDG_CONFIG_HOME",
    "XDG_RUNTIME_DIR",
    "SSL_CERT_FILE",
    "SSL_CERT_DIR",
    "NODE_EXTRA_CA_CERTS",
  ])
    if (source[key]) env[key] = source[key];
  return env;
}
