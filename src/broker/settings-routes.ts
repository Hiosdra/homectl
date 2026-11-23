// Owner routes for the owner's own settings that change how homectl waits. The
// approval wait is the first: how long a request waits for the owner before it
// expires. Changing it needs the owner password in the same request (step-up).
import {
  APPROVAL_WAIT_DEFAULT_MS,
  describeApprovalWait,
  parseApprovalWait,
  readApprovalWait,
  writeApprovalWait,
} from "./approval-wait";
import type { RouteExtension } from "./server";

export const APPROVAL_WAIT_PATH = "/v1/owner/settings/approval-wait";

export class SettingsRoutes implements RouteExtension {
  constructor(private readonly directory: string) {}

  async owner(
    path: string,
    input: Record<string, unknown>,
    stepUp: (password: unknown) => Promise<void>,
  ): Promise<unknown> {
    if (path === APPROVAL_WAIT_PATH) {
      await stepUp(input.password);
      // Either a duration the owner typed ("24h") or the checked milliseconds
      // an approved agent request carries.
      const ms = await writeApprovalWait(
        this.directory,
        input.waitMs !== undefined
          ? input.waitMs
          : parseApprovalWait(input.wait),
      );
      return approvalWaitView(ms);
    }
    if (path === `${APPROVAL_WAIT_PATH}/get`)
      return approvalWaitView(await readApprovalWait(this.directory));
    return undefined;
  }
}

export function approvalWaitView(ms: number) {
  return {
    approvalWaitMs: ms,
    label: describeApprovalWait(ms),
    default: ms === APPROVAL_WAIT_DEFAULT_MS,
  };
}
