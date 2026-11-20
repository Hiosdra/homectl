// Update banner routes for the panel opened on this computer: GET /api/update (status)
// and POST /api/update/apply. The release check itself lives in src/update-check.ts,
// shared with the broker's update routes; it is re-exported here so web imports keep working.
import { VERSION } from "../container/health";
import { applyUpdate } from "../update-apply";
import { UpdateChecker } from "../update-check";

export {
  isNewer,
  parseVersion,
  RELEASE_API,
  type UpdateStatus,
  UpdateChecker,
} from "../update-check";

// The panel opened on this computer; anything else is a LAN or container panel.
const LOCAL_HOSTS = ["127.0.0.1", "localhost", "[::1]"];

// Route handler for GET /api/update and POST /api/update/apply. Returns undefined for any
// other request. The apply route installs the release only for the panel opened on this
// computer, so a container or a LAN panel answers with the way to update it instead.
export async function handleUpdateRoute(
  request: Request,
  url: URL,
  checker: UpdateChecker,
): Promise<Response | undefined> {
  if (request.method === "POST" && url.pathname === "/api/update/apply")
    return applyRoute(request, url, checker);
  if (request.method !== "GET" || url.pathname !== "/api/update")
    return undefined;
  return new Response(JSON.stringify(await checker.status()), {
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
    },
  });
}

function json(status: number, value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
    },
  });
}

async function applyRoute(
  request: Request,
  url: URL,
  checker: UpdateChecker,
): Promise<Response> {
  if (!LOCAL_HOSTS.includes(url.hostname))
    return json(403, {
      error:
        "Update from the panel on the computer that runs homectl. A container updates by redeploying its image.",
    });
  if (request.headers.get("Origin") !== url.origin)
    return json(403, { error: "Open the local panel directly" });
  const status = await checker.status();
  if (!status.available || !status.latest)
    return json(409, { error: "No newer release is available." });
  try {
    return json(200, await applyUpdate(status.latest));
  } catch (error) {
    return json(500, {
      error: error instanceof Error ? error.message : "The update failed.",
    });
  }
}

// The panel's checker: one per process, sharing the day-long cache.
export const updateChecker = new UpdateChecker({ current: VERSION });
