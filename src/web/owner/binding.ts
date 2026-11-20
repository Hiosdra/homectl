// Where the owner panel listens and which origin it answers as (homelab #21 §8).
//
// The default is loopback only. HOMECTL_PANEL_LISTEN opts into another address,
// for example the host network of a container. A non-loopback panel is reachable
// by anything that can route to that address, so it must sit behind trusted
// network controls: a firewall that admits only your LAN or VPN, or a reverse
// proxy you run. The panel is still signed in with the owner password, but that
// is not a substitute for those controls.
//
// The Origin, Host and cookie checks stay exactly as strict on every address. A
// non-loopback panel must name the one exact browser origin it answers as
// (HOMECTL_PANEL_ORIGIN), and the broker must be started with that same origin.
import { isIP } from "node:net";
import { HomectlError } from "../../types";

export const PANEL_LISTEN_ENV = "HOMECTL_PANEL_LISTEN";
export const PANEL_ORIGIN_ENV = "HOMECTL_PANEL_ORIGIN";
// Set to "1" to accept a non-loopback panel over plain http. The default refuses
// it: the owner password and session cookie would cross the network unencrypted.
export const PANEL_INSECURE_HTTP_ENV = "HOMECTL_PANEL_INSECURE_HTTP";
export const DEFAULT_PANEL_LISTEN = "127.0.0.1";

export interface PanelBinding {
  // The address handed to the HTTP server.
  hostname: string;
  // The only origin the panel answers as. The broker must accept exactly this.
  origin: string;
  // The Host header the panel accepts: host and port, as the browser sends it.
  host: string;
  loopback: boolean;
}

// Resolves the bind address and origin. Refuses hostnames: a name could resolve
// to something other than the address the operator meant.
export function panelBinding(options: {
  port: number;
  listen?: string;
  origin?: string;
  // true only when HOMECTL_PANEL_INSECURE_HTTP=1 (see panelOptionsFromEnv).
  insecureHttp?: boolean;
}): PanelBinding {
  // A blank variable counts as unset, so an empty HOMECTL_PANEL_LISTEN is loopback.
  const hostname = options.listen?.trim() || DEFAULT_PANEL_LISTEN;
  if (isIP(hostname) === 0)
    throw new HomectlError(
      2,
      `${PANEL_LISTEN_ENV} must be an IP address, such as 127.0.0.1 or 0.0.0.0`,
    );
  if (hostname === "127.0.0.1" || hostname === "::1") {
    const shown = hostname === "::1" ? "[::1]" : "127.0.0.1";
    return {
      hostname,
      origin: `http://${shown}:${options.port}`,
      host: `${shown}:${options.port}`,
      loopback: true,
    };
  }
  const raw = options.origin?.trim() ?? "";
  if (raw === "")
    throw new HomectlError(
      2,
      `Listening on ${hostname} needs ${PANEL_ORIGIN_ENV}: the exact origin your browser uses, such as http://192.168.1.10:${options.port}`,
    );
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new HomectlError(2, `${PANEL_ORIGIN_ENV} must be a URL`);
  }
  if (
    (url.protocol !== "http:" && url.protocol !== "https:") ||
    url.username !== "" ||
    url.password !== "" ||
    url.pathname !== "/" ||
    url.search !== "" ||
    url.hash !== ""
  )
    throw new HomectlError(
      2,
      `${PANEL_ORIGIN_ENV} must be an origin only: http or https, a host and a port, with no path`,
    );
  if (url.protocol === "http:" && options.insecureHttp !== true)
    throw new HomectlError(
      2,
      `Listening on ${hostname} with a plain http origin would send the owner password and session cookie unencrypted. Use an https origin behind a reverse proxy you run, or reach the panel through an SSH tunnel to 127.0.0.1. To accept plain http on a network you trust, set ${PANEL_INSECURE_HTTP_ENV}=1.`,
    );
  return { hostname, origin: url.origin, host: url.host, loopback: false };
}

// The insecure-http opt-in as the environment states it. Only "1" counts.
export function panelOptionsFromEnv(env: NodeJS.ProcessEnv): {
  listen: string | undefined;
  origin: string | undefined;
  insecureHttp: boolean;
} {
  return {
    listen: env[PANEL_LISTEN_ENV],
    origin: env[PANEL_ORIGIN_ENV],
    insecureHttp: env[PANEL_INSECURE_HTTP_ENV] === "1",
  };
}

// The warning the panel prints when it leaves loopback. Shown on the console,
// because the owner should see it whenever the panel starts this way.
export function nonLoopbackWarning(binding: PanelBinding): string {
  // Over https the broker's session cookie is Secure. Over plain http (only with
  // HOMECTL_PANEL_INSECURE_HTTP=1) anything on the network path can read the
  // owner sign-in password and the session cookie.
  const transport = binding.origin.startsWith("https:")
    ? ""
    : " The origin is plain http, which you opted into with HOMECTL_PANEL_INSECURE_HTTP=1: the owner password and session cookie cross the LAN in clear text. Prefer an https reverse proxy you run, or an SSH tunnel to 127.0.0.1.";
  return `The owner panel listens on ${binding.hostname} (${binding.origin}), not only on this computer. Keep it behind trusted network controls: a firewall that admits only your LAN or VPN, or a reverse proxy you run. Anyone who can reach it can open its sign-in page.${transport}`;
}
