// The Sync landing page: pairing with another computer, the devices on the LAN, the
// paired devices, and the comparisons waiting for review.
import { formatLocalDate } from "../format";
import { pairingAddress, ui } from "../store";
import type { State } from "../types";
import {
  Action,
  EmptyState,
  ListRow,
  Muted,
  Note,
  PageHeading,
  Pre,
  Section,
  Tag,
} from "../shared";
import { Button } from "../ui/button";
import { Disclosure } from "../disclosure";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import { ControlSyncSection } from "./control-sync";
import { Output } from "./output";

export function Devices() {
  const p = ui.state.pair;
  return (
    <>
      <PageHeading
        title="Sync"
        description="Pair this computer with another homectl workspace, then compare changes before they apply."
        actions={p ? undefined : <Action action="pair-open" label="Start pairing" kind="primary" />}
      />
      {p ? <PairingPanel p={p} /> : null}
      {ui.state.pending.length ? (
        <Section title="Awaiting your review" className="mb-6">
          {ui.state.pending.map((pending) => (
            <ListRow
              key={pending.id}
              actions={<Action action="sync-preview" label="Review" id={pending.id} />}
            >
              <strong>{pending.remoteName}</strong>
              <p className="text-sm text-muted-foreground">
                A peer is proposing changes. Open the comparison before applying them.
              </p>
            </ListRow>
          ))}
        </Section>
      ) : null}
      {p ? null : (
        <div className="grid gap-5 md:grid-cols-2">
          <Section title="Devices on your LAN">
            {ui.state.discovery.devices.length ? (
              ui.state.discovery.devices.map((d) => (
                <ListRow
                  key={d.id}
                  actions={<Action action="discovered" label="Use this device" id={d.address} />}
                >
                  <strong>Ready to pair</strong>
                  <p className="text-sm text-muted-foreground">{d.address}</p>
                </ListRow>
              ))
            ) : (
              <>
                <Muted>
                  No device found automatically. That’s okay: enter its address and code
                  below.
                </Muted>
                <Disclosure title={<>Why automatic discovery may not work</>} className="mt-3" panelClassName="grid gap-2 pt-3">
                    <p>
                      Docker, Wi-Fi isolation, VLANs, and firewalls can block LAN
                      discovery. Direct connection still works. For troubleshooting, allow
                      UDP 5353 for discovery and TCP 7448 for pairing on the private LAN;
                      no router port forwarding is needed.
                    </p>
                    {ui.state.discovery.error ? (
                      <Note>{ui.state.discovery.error}</Note>
                    ) : null}
                  </Disclosure>
              </>
            )}
          </Section>
          <Section title="Join a pairing session">
            <Muted>
              On the other computer, choose Start pairing. Enter its LAN address and
              one-time code here, then compare the phrase on both devices.
            </Muted>
            <form id="pair-form" className="mt-4 grid gap-4">
              <div className="grid gap-1.5">
                <Label htmlFor="peer-address">Other computer’s address (port 7448)</Label>
                <Input
                  id="peer-address"
                  name="address"
                  placeholder="http://192.0.2.10:7448"
                  required
                />
              </div>
              <div className="grid gap-1.5">
                <Label htmlFor="pair-code">One-time code</Label>
                <Input
                  id="pair-code"
                  name="code"
                  inputMode="numeric"
                  placeholder="1234-5678"
                  autoComplete="off"
                  required
                />
              </div>
              <div>
                <Button type="submit">Connect</Button>
              </div>
            </form>
          </Section>
        </div>
      )}
      <Section title="Paired devices" className="mt-8">
        {ui.control?.devices ? (
          <Note>
            This device signs control records with{" "}
            <code>{ui.control.devices.self.fingerprint ?? "no key yet"}</code>.
          </Note>
        ) : null}
        {ui.state.peers.length ? (
          ui.state.peers.map((peer) => (
            <ListRow
              key={peer.id}
              actions={
                <>
                  <Action action="sync-start" label="Compare and sync" id={peer.id} />
                  <Action action="peer-status" label="Status" id={peer.id} />
                  <Action action="peer-permissions" label="Permissions" id={peer.id} kind="quiet" />
                  <Action action="peer-forget" label="Remove trust" id={peer.id} kind="quiet-danger" />
                </>
              }
            >
              <div className="flex flex-wrap items-center gap-2">
                <strong>{peer.name}</strong>
                <Tag>{peer.platform}</Tag>
              </div>
              <p className="text-sm text-muted-foreground">{peer.address}</p>
              <SigningNote id={peer.id} />
              <p className="text-sm text-muted-foreground">
                {peer.permissions.sync ? "Sync enabled" : "Sync disabled"} ·{" "}
                {peer.permissions.diagnostics ? "Diagnostics enabled" : "Diagnostics disabled"}{" "}
                · {peer.permissions.operations.length} operation grants
              </p>
            </ListRow>
          ))
        ) : (
          <EmptyState title="No paired devices yet">
            <p>
              Start pairing here and enter the code on the other computer. Check that both
              show the same phrase before confirming.
            </p>
          </EmptyState>
        )}
      </Section>
      <div className="mt-8">
        <ControlSyncSection />
      </div>
      <Output />
    </>
  );
}

function SigningNote({ id }: { id: string }) {
  const device = ui.control?.devices?.peers.find((p) => p.id === id);
  if (!device) return <Note>Signing key not reported yet.</Note>;
  return device.legacy ? (
    <Note>Re-pair this device to enable control sync; it has no signing key.</Note>
  ) : (
    <Note>
      Signing key <code>{device.fingerprint ?? ""}</code>
    </Note>
  );
}

function PairingPanel({ p }: { p: NonNullable<State["pair"]> }) {
  return (
    <Section title={p.sas ? "Verify this device" : "Pairing window open"} className="mb-6">
      <Muted>Code expires at {formatLocalDate(p.expiresAt)}.</Muted>
      {p.code ? (
        <div className="mt-3 grid gap-3">
          <p>
            On the other computer, open <strong>Devices → Join a pairing session</strong>.
            Use this address and one-time code:
          </p>
          <p className="my-1 font-mono text-[30px] tracking-[0.08em] text-[#dbd2ff] tabular-nums max-[700px]:text-[25px]">
            {pairingAddress()}
          </p>
          <p className="my-1 font-mono text-[30px] tracking-[0.08em] text-[#dbd2ff] tabular-nums max-[700px]:text-[25px]">
            {p.code}
          </p>
          <p>Or run this command on the other computer:</p>
          <Pre>{`homectl pair --address ${pairingAddress()}`}</Pre>
          <div className="flex flex-wrap gap-2">
            <Action action="pair-copy-command" label="Copy command" />
            <Action action="pair-copy-code" label="Copy one-time code" />
          </div>
          <Note>
            The command asks for the code privately so it is not saved in terminal history.
          </Note>
          <Note>
            Use the computer&apos;s reachable LAN address. If it runs in Docker, use the
            Docker host address, not a container-only IP. Keep the code on your devices; do
            not put it in chat or logs.
          </Note>
          <p>
            When both computers show the same verification phrase, confirm it on each one.
          </p>
        </div>
      ) : null}
      {p.sas ? (
        <div className="mt-3 grid gap-3">
          <p>
            Compare this phrase on both computers. Device: <strong>{p.remote?.name}</strong>.
          </p>
          <div className="rounded-[7px] border border-[#59517a] bg-[#24233d] p-3.5 font-mono text-xl tracking-[0.04em]">
            {p.sas}
          </div>
          <p>
            {p.localConfirmed
              ? "You confirmed this phrase."
              : "Confirm only if both computers show the same phrase."}{" "}
            {p.remoteConfirmed
              ? "The other computer confirmed too."
              : "Waiting for the other computer to confirm."}
          </p>
          {!p.localConfirmed ? (
            <div>
              <Action action="pair-confirm" label="The phrases match" kind="primary" />
            </div>
          ) : null}
        </div>
      ) : null}
      <div className="mt-5 flex justify-end">
        <Action action="pair-cancel" label="Cancel pairing" />
      </div>
    </Section>
  );
}
