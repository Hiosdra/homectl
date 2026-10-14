import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { HomectlError } from "../types";
export async function localApi<T = unknown>(
  inventory: string,
  path: string,
  value?: unknown,
): Promise<T> {
  let info: { url: string; token: string };
  try {
    info = JSON.parse(
      await readFile(join(dirname(inventory), "serve", "panel.json"), "utf8"),
    );
  } catch {
    throw new HomectlError(5, "Start homectl serve or its service first");
  }
  const url = new URL(info.url);
  if (
    url.protocol !== "http:" ||
    url.hostname !== "127.0.0.1" ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    throw new HomectlError(3, "Invalid local panel endpoint");
  const authenticate = await fetch(`${url.origin}/api/connect`, {
    method: "POST",
    headers: { Origin: url.origin, "Content-Type": "application/json" },
    body: JSON.stringify({ token: info.token }),
    redirect: "error",
    signal: AbortSignal.timeout(5000),
  });
  const cookie = authenticate.headers.get("set-cookie")?.split(";")[0];
  if (!authenticate.ok || !cookie)
    throw new HomectlError(
      5,
      "Panel access changed; restart the private panel session",
    );
  const response = await fetch(`${url.origin}${path}`, {
    method: value === undefined ? "GET" : "POST",
    headers: {
      Cookie: cookie,
      Origin: url.origin,
      ...(value === undefined ? {} : { "Content-Type": "application/json" }),
    },
    body: value === undefined ? undefined : JSON.stringify(value),
    redirect: "error",
    signal: AbortSignal.timeout(120_000),
  });
  const result = (await response.json()) as T & {
    error?: string;
    code?: number;
  };
  if (!response.ok)
    throw new HomectlError(
      result.code ?? 5,
      result.error ?? "Local operation failed",
    );
  return result;
}
