import { CLIENT_ID_PATTERN, type EventEnvelope } from "../core/contracts";
import { HomectlError } from "../types";

// Owner surfaces see every event. An ordinary client sees only events whose
// audience lists its own id, so one client never receives another client's data.
export type AudienceFilter = { owner: true } | { client: string };

export const OWNER_FILTER: AudienceFilter = { owner: true };

export function assertFilter(filter: AudienceFilter): void {
  if ("owner" in filter) {
    if (filter.owner !== true)
      throw new HomectlError(
        2,
        "Owner audience filter must be { owner: true }",
      );
    return;
  }
  if (!("client" in filter) || !CLIENT_ID_PATTERN.test(filter.client))
    throw new HomectlError(2, "Audience filter needs a valid client id");
}

export function audienceAllows(
  filter: AudienceFilter,
  envelope: Pick<EventEnvelope, "audience">,
): boolean {
  if ("owner" in filter) return true;
  return envelope.audience.includes(filter.client);
}
