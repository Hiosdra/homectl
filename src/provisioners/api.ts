import { HomectlError, type ProviderConfig } from "../types";
import type { API } from "./index";
export function proxmoxAPI(
  config: ProviderConfig,
  secret: string,
  fetcher: (input: string, init?: RequestInit) => Promise<Response> = fetch,
): API {
  if (!secret || !/^https:\/\//.test(config.url))
    throw new HomectlError(5, "Missing injected token or HTTPS endpoint");
  const request = async (
    method: string,
    path: string,
    params?: Record<string, string | number>,
  ) => {
    if (
      !/^\/nodes\/[a-zA-Z0-9-]+\//.test(path) &&
      !/^\/nodes\/[a-zA-Z0-9-]+\/qemu$/.test(path)
    )
      throw new HomectlError(2, "Invalid API path");
    let response: Response;
    try {
      response = await fetcher(
        `${config.url.replace(/\/$/, "")}/api2/json${path}`,
        {
          method,
          redirect: "error",
          signal: AbortSignal.timeout(30_000),
          headers: {
            Authorization: `PVEAPIToken=${config.token_id}=${secret}`,
            ...(params
              ? { "Content-Type": "application/x-www-form-urlencoded" }
              : {}),
          },
          ...(params
            ? {
                body: new URLSearchParams(
                  Object.entries(params).map(([k, v]) => [k, String(v)]),
                ),
              }
            : {}),
        },
      );
    } catch {
      throw new HomectlError(
        5,
        "Proxmox request failed (TLS/network details suppressed)",
      );
    }
    if (!response.ok)
      throw new HomectlError(
        5,
        `Proxmox HTTP ${response.status}; inspect ACLs, template and API task log outside credential output`,
      );
    const body = (await response.json()) as { data: unknown };
    return body.data;
  };
  return {
    request,
    async wait(task) {
      const deadline = Date.now() + 600_000;
      while (Date.now() < deadline) {
        const state = (await request(
          "GET",
          `/nodes/${config.node}/tasks/${encodeURIComponent(task)}/status`,
        )) as { status: string; exitstatus?: string };
        if (state.status === "stopped") {
          if (state.exitstatus !== "OK")
            throw new HomectlError(
              5,
              "Proxmox task failed; inspect task in provider UI",
            );
          return;
        }
        await Bun.sleep(1000);
      }
      throw new HomectlError(
        5,
        "Proxmox task timed out; journal retained for recovery",
      );
    },
  };
}
