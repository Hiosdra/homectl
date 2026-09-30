import { cleanEnv, redactor } from "./credentials";
import { HomectlError, type ProcessSpec, type Runner } from "./types";
export const run: Runner = async (spec: ProcessSpec) => {
  const env = { ...cleanEnv(), ...spec.env };
  const redact = redactor(
    Object.entries(spec.env ?? {})
      .filter(([k]) => /PASSWORD|SECRET|TOKEN/.test(k))
      .map(([, v]) => v),
  );
  try {
    const child = Bun.spawn(spec.argv, {
      env,
      stdin: spec.stdin === undefined ? "ignore" : new Blob([spec.stdin]),
      stdout: "pipe",
      stderr: "pipe",
    });
    const timer = setTimeout(
      () => child.kill("SIGKILL"),
      spec.timeoutMs ?? 120_000,
    );
    try {
      const [stdout, stderr, exitCode] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ]);
      return { stdout: redact(stdout), stderr: redact(stderr), exitCode };
    } finally {
      clearTimeout(timer);
    }
  } catch {
    throw new HomectlError(
      5,
      "Process could not start; run homectl doctor (details suppressed to protect credentials)",
    );
  }
};
