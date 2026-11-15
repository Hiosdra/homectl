import { HomectlError } from "../types";
import { hasScope } from "./clients";
import type { ClientIdentity, Scope } from "./types";

export function requireScope(client: ClientIdentity, scope: Scope): void {
  if (!hasScope(client, scope))
    throw new HomectlError(3, "Client lacks the scope for this operation");
}
