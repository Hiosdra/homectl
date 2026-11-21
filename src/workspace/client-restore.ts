// Client side of a restore (homelab #21 §6, W5). A device that joined with a
// restore invite asks the server whether a restore waits for it, then:
//   - if it already holds a restorable file: it declines. The server retires
//     this fresh identity, and the device is unlinked with a new identity so
//     it can join again once the owner issues the restore anew;
//   - if it wrote the files for this restore but was never acknowledged: it
//     only acknowledges again;
//   - otherwise it fetches the files (the grant is not consumed), writes them,
//     records what it wrote, and acknowledges. Only the acknowledgment ends the
//     grant on the server.
// Nothing here throws: a failure is reported in the outcome and the link stays.
import { HomectlError } from "../types";
import { channelRequest, type LinkPeer, type Post } from "./channel";
import { isRestorable, type RestoreTarget } from "./restore-files";
import { type ClientLink, freshIdentity } from "./state";
import { errorText, peerOf } from "./summary";
import * as v from "./validate";

export type RestoreOutcome =
  | { status: "none" }
  | {
      status: "restored";
      seq: number;
      files: string[];
      notes: string[];
      acknowledged: boolean;
    }
  | { status: "refused"; reason: string }
  | { status: "failed"; reason: string };

// Applies a change to this device's link state, serialised with the rest.
export type UpdateLink = (
  mutate: (next: ClientLink) => void,
) => Promise<unknown>;

export async function takeRestore(
  transport: (address: string) => Post,
  link: ClientLink,
  target: RestoreTarget,
  update: UpdateLink,
): Promise<RestoreOutcome> {
  const server = link.server;
  if (!server) return { status: "failed", reason: "This device is not linked" };
  try {
    return await restoreFromServer(
      transport(server.address),
      link.id,
      peerOf(server),
      target,
      update,
      link.restore,
    );
  } catch (error) {
    return { status: "failed", reason: errorText(error) };
  }
}

async function restoreFromServer(
  post: Post,
  self: string,
  server: LinkPeer,
  target: RestoreTarget,
  update: UpdateLink,
  receipt: ClientLink["restore"],
): Promise<RestoreOutcome> {
  const waiting = v.parseRestoreStatus(
    await channelRequest(post, self, server, "restore.status", {}),
  );
  if (!waiting.pending || waiting.seq === undefined) {
    // Nothing waits any more: a receipt left over from an expired grant ends here.
    if (receipt) await update((next) => (next.restore = undefined));
    return { status: "none" };
  }
  const seq = waiting.seq;
  const taken = await target.existing();
  if (
    receipt?.seq === seq &&
    taken.length > 0 &&
    taken.every((name) => receipt.files.includes(name))
  )
    return acknowledge(post, self, server, seq, receipt.files, [], update);
  if (taken.length > 0) return decline(post, self, server, seq, taken, update);

  const delivery = v.parseRestoreDelivery(
    await channelRequest(post, self, server, "restore.fetch", {}),
  );
  if (delivery.status === "none" || delivery.seq === undefined)
    return { status: "none" };
  const files = delivery.files ?? [];
  if (!files.every((file) => isRestorable(file.path)))
    throw new HomectlError(3, "The server sent a file that cannot be restored");
  await target.write(
    files.map((file) => ({
      path: file.path,
      data: new Uint8Array(Buffer.from(file.data, "base64")),
    })),
  );
  const written = files.map((file) => file.path);
  await update((next) => {
    next.restore = { seq: delivery.seq ?? seq, files: written };
  });
  return acknowledge(
    post,
    self,
    server,
    delivery.seq,
    written,
    delivery.notes,
    update,
  );
}

// A failed acknowledgment leaves the receipt in place, so the next check
// acknowledges again without writing anything.
async function acknowledge(
  post: Post,
  self: string,
  server: LinkPeer,
  seq: number,
  files: string[],
  notes: string[],
  update: UpdateLink,
): Promise<RestoreOutcome> {
  let acknowledged = true;
  try {
    v.parseRestoreAck(
      await channelRequest(post, self, server, "restore.ack", { seq }),
    );
  } catch {
    acknowledged = false;
  }
  if (acknowledged) await update((next) => (next.restore = undefined));
  return { status: "restored", seq, files, notes, acknowledged };
}

async function decline(
  post: Post,
  self: string,
  server: LinkPeer,
  seq: number,
  taken: string[],
  update: UpdateLink,
): Promise<RestoreOutcome> {
  const names = taken.join(", ");
  try {
    v.parseRestoreDecline(
      await channelRequest(post, self, server, "restore.decline", { seq }),
    );
  } catch (error) {
    return {
      status: "refused",
      reason: `${names} already exists on this device, so the restore was not applied, and the server could not close it (${errorText(error)}). Move the file aside, run home-ctl workspace leave on this device, then ask the owner to issue the restore again.`,
    };
  }
  await update((next) => {
    next.server = undefined;
    next.eventsAcked = 0;
    next.backupKeyRegistered = false;
    next.lastSyncAt = undefined;
    next.lastSyncError = undefined;
    next.restore = undefined;
    Object.assign(next, freshIdentity());
  });
  return {
    status: "refused",
    reason: `${names} already exists on this device, so the restore was not applied. The device is unlinked and its fresh identity was discarded on the server. Move the file aside, have the owner issue the restore again (home-ctl workspace restore <client> <seq> --reason "<why>"), then join this device with the new code.`,
  };
}
