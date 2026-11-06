// Health for the containerized peer. The local route returns only a status and
// the version: no paths, peers, counts or errors (docs/homectl-2.0/container-peer.md).
import pkg from "../../package.json";

export const VERSION: string = pkg.version;

export type HealthBody = { status: "ok" | "degraded"; version: string };

export function healthBody(degraded: boolean): HealthBody {
  return { status: degraded ? "degraded" : "ok", version: VERSION };
}

// Docker HEALTHCHECK entry: exits 0 only when the local panel reports "ok".
// Runs in the container's own loopback namespace; nothing leaves the container.
if (import.meta.main) {
  const port = Number(process.env.HOMECTL_PANEL_PORT ?? 7447);
  if (!Number.isInteger(port) || port < 1 || port > 65535) process.exit(1);
  try {
    const response = await fetch(`http://127.0.0.1:${port}/healthz`, {
      redirect: "error",
      signal: AbortSignal.timeout(4000),
    });
    const body = (await response.json()) as { status?: unknown };
    process.exit(response.ok && body.status === "ok" ? 0 : 1);
  } catch {
    process.exit(1);
  }
}
