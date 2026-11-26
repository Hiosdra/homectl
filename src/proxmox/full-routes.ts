// The full-mode Proxmox route table (operations: "full"). A request reaches the
// API only when its method and path match a row here, after the strict checks in
// full.ts. Anything not listed is refused. Rows are split by area; the first row
// that matches wins.
import type { FullRoute } from "./full-route-types";
import { FULL_GUEST_ROUTES } from "./full-routes-guests";
import { FULL_PLATFORM_ROUTES } from "./full-routes-platform";

export type { FullMethod, FullRoute } from "./full-route-types";

export const FULL_ROUTES: readonly FullRoute[] = [
  ...FULL_GUEST_ROUTES,
  ...FULL_PLATFORM_ROUTES,
];
