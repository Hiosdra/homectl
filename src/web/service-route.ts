// The panel's view of the background service. GET reports whether it runs; POST restarts
// or stops it through the service manager. Like the update, the POST works only for the
// panel opened on this computer, from its own origin.
import { service } from "../service";

const LOCAL_HOSTS = ["127.0.0.1", "localhost", "[::1]"];

function json(status: number, value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
    },
  });
}

export async function handleServiceRoute(
  request: Request,
  url: URL,
  inventoryPath: string,
): Promise<Response | undefined> {
  if (url.pathname !== "/api/service") return undefined;
  if (request.method === "GET") {
    try {
      const result = (await service("status", {
        inventory: inventoryPath,
      })) as { exitCode?: number };
      // systemctl: 0 active, 3 inactive, anything else means no unit is installed.
      if (result.exitCode === 0)
        return json(200, { running: true, text: "Running" });
      if (result.exitCode === 3)
        return json(200, { running: false, text: "Stopped" });
      return json(200, { running: false, text: "Not installed" });
    } catch {
      return json(200, { running: false, text: "Not installed" });
    }
  }
  if (request.method !== "POST") return undefined;
  if (!LOCAL_HOSTS.includes(url.hostname))
    return json(403, {
      error:
        "Manage the service from the panel on the computer that runs homectl.",
    });
  if (request.headers.get("Origin") !== url.origin)
    return json(403, { error: "Open the local panel directly" });
  const body = (await request.json().catch(() => ({}))) as { action?: unknown };
  // Only a restart: the panel cannot start a stopped service, so it never offers a stop.
  if (body.action !== "restart")
    return json(400, { error: "Unknown service action" });
  // A restart ends the process that is answering, so the answer goes out first and the
  // change follows. A refused change is written to the log; the status line shows the result.
  setTimeout(() => {
    service("restart", { inventory: inventoryPath })
      .then((result) => {
        const code = (result as { exitCode?: number }).exitCode;
        if (code)
          console.error(`homectl service restart refused (exit ${code})`);
      })
      .catch((error: unknown) =>
        console.error("homectl service restart failed", error),
      );
  }, 200);
  return json(200, { text: "Restarting the service." });
}
