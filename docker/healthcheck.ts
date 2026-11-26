#!/usr/bin/env bun
// Docker HEALTHCHECK for the container. Exits 0 when the container's own
// service answers, and nothing leaves the container.
//
//   0.3 broker  healthy when the broker answers on its endpoint (it refuses an
//               unauthenticated request with "Client token required", as
//               `daemon status` expects) and the owner panel answers /healthz.
//   legacy serve  healthy when its /healthz answers with status "ok" (the
//               container-mode peer from homelab #21's 0.2 line).
import { findEndpoint } from "../src/broker/client";

const TIMEOUT_MS = 3000;

// The broker's endpoint file lives under HOME (compat mode), as the CLI finds it.
export async function brokerAnswers(): Promise<boolean> {
  const endpoint = await findEndpoint();
  if (!endpoint) return false;
  const url =
    endpoint.transport === "unix"
      ? "http://localhost/v1/whoami"
      : `${endpoint.address}/v1/whoami`;
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
      signal: AbortSignal.timeout(TIMEOUT_MS),
      ...(endpoint.transport === "unix" ? { unix: endpoint.address } : {}),
    } as RequestInit);
    const body = (await response.json().catch(() => ({}))) as {
      error?: { message?: unknown };
    };
    return (
      response.status === 401 &&
      typeof body.error?.message === "string" &&
      /Client token/.test(body.error.message)
    );
  } catch {
    return false;
  }
}

async function getJson(url: string): Promise<unknown> {
  const response = await fetch(url, {
    redirect: "error",
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!response.ok) return undefined;
  return response.json().catch(() => undefined);
}

export async function panelAnswers(port: number): Promise<boolean> {
  const body = await getJson(`http://127.0.0.1:${port}/healthz`).catch(
    () => undefined,
  );
  return (body as { ok?: unknown } | undefined)?.ok === true;
}

export async function legacyServeAnswers(port: number): Promise<boolean> {
  const body = await getJson(`http://127.0.0.1:${port}/healthz`).catch(
    () => undefined,
  );
  return (body as { status?: unknown } | undefined)?.status === "ok";
}

export async function healthy(
  env: Record<string, string | undefined> = process.env,
): Promise<boolean> {
  const legacyPort = Number(env.HOMECTL_PANEL_PORT ?? 7447);
  if (await legacyServeAnswers(legacyPort)) return true;
  const panelPort = Number(env.HOMECTL_OWNER_PANEL_PORT ?? 7451);
  return (await brokerAnswers()) && (await panelAnswers(panelPort));
}

if (import.meta.main) process.exit((await healthy()) ? 0 : 1);
