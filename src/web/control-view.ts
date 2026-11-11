import type { ControlPlane } from "../control/engine";
import { lastRecoveryExport } from "../control/recovery";

// Control-plane overview for the Approvals view. Read-only, except that the
// audit verification itself is an in-memory check of the journal.
export async function controlPanel(
  control: ControlPlane,
  extra: { sync?: unknown; devices?: unknown },
) {
  const [operations, clients, audit, lastExportAt] = await Promise.all([
    control.listOperations({ all: true }),
    control.listClients(),
    control.verifyAudit(),
    lastRecoveryExport(control.store.directory),
  ]);
  return {
    operations: operations.slice(0, 200),
    clients,
    recovery: { lastExportAt },
    sync: extra.sync,
    devices: extra.devices,
    oidc: await control.oidcView(),
    audit: {
      ok: audit.ok,
      entries: audit.entries,
      head: audit.head,
      anchored: audit.anchored,
      checkedAt: new Date().toISOString(),
      error: audit.error,
    },
  };
}
