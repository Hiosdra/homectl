import { HelpLabel } from "../help";
// Settings, as in the approved design: MCP clients, sign-in, the session, the background
// service, and the panel. Clients are created in a terminal; the panel shows the command.
import { useEffect, useState } from "react";
import { sessionTtlLabel } from "../format";
import { cn } from "../lib/utils";
import { render, ui } from "../store";
import { Action, Facts, Muted, Note, PageHeading, Section, Tag, type Tone } from "../shared";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";

const LENGTHS = [
  ["1h", "1 hour"],
  ["8h", "8 hours"],
  ["24h", "24 hours (default)"],
  ["7d", "7 days"],
  ["until-reboot", "Until reboot"],
] as const;

const IDLE = [
  ["30m", "30 minutes"],
  ["2h", "2 hours"],
  ["8h", "8 hours"],
  ["24h", "24 hours"],
] as const;

export function Settings() {
  return (
    <>
      <PageHeading title="Settings" description="MCP clients, sign-in and panel details." />
      <div className="grid gap-5 md:grid-cols-2">
        <ClientsCard />
        <SignInCard />
        <SessionCard />
        <ServiceCard />
      </div>
      <div className="mt-5">
        <PanelCard />
      </div>
    </>
  );
}

function StatusBadge({ tone, children }: { tone: Tone; children: string }) {
  return <Tag tone={tone}>{children}</Tag>;
}

function ClientsCard() {
  const clients = (ui.control?.clients ?? []).filter((c) => !c.revoked);
  return (
    <Section
      title={
        <span className="flex items-center justify-between gap-3">
          MCP clients
          <Button type="button" size="sm" variant="secondary" onClick={() => { ui.clientDialog = true; render(); }}>
            Add client
          </Button>
        </span>
      }
    >
      {clients.length ? (
        <div className="grid gap-3">
          {clients.map((client) => {
            const approves = client.scopes.includes("approve:decide");
            return (
              <div key={client.id} className="flex flex-wrap items-center justify-between gap-3 border-b border-border pb-3 last:border-b-0">
                <div>
                  <b>{client.name}</b>
                  <p className="text-sm text-muted-foreground">
                    {approves ? "Approves operations." : "Creates plans. Cannot approve them."}
                  </p>
                </div>
                <StatusBadge tone={approves ? "warning" : "neutral"}>{approves ? "can approve" : "plans only"}</StatusBadge>
              </div>
            );
          })}
        </div>
      ) : (
        <Muted>No clients yet. Each MCP client gets its own identity, scopes and host grants.</Muted>
      )}
    </Section>
  );
}

function SignInCard() {
  const oidc = ui.control?.oidc;
  return (
    <Section
      title={
        <span className="flex items-center justify-between gap-3">
          Sign-in (OIDC) <StatusBadge tone={oidc ? "success" : "neutral"}>{oidc ? "configured" : "not configured"}</StatusBadge>
        </span>
      }
    >
      <Muted>Each client has its own identity. Configure it in a separate step.</Muted>
      {oidc ? (
        <div className="mt-3">
          <Facts
            items={[
              ["Issuer", oidc.issuerHost],
              ["Audience", oidc.audience],
              ["Max token life", `${Math.round(oidc.maxLifetimeSeconds / 60)} min`],
            ]}
          />
        </div>
      ) : null}
    </Section>
  );
}

function SessionCard() {
  const unlocked = ui.state.session.unlocked;
  const expires = ui.state.session.expiresAt;
  const left = unlocked && expires ? formatLeft(expires) : undefined;
  const ttl = ui.state.inventory.session?.ttl ?? "24h";
  const idle = ui.state.inventory.session?.idle ?? "2h";
  const [changing, setChanging] = useState(false);
  return (
    <Section
      title={
        <span className="flex items-center justify-between gap-3">
          Session
          <StatusBadge tone={unlocked ? "success" : "neutral"}>{unlocked ? `Unlocked · ${left ?? "until reboot"}` : "Locked"}</StatusBadge>
        </span>
      }
    >
      <dl className="grid grid-cols-[120px_minmax(0,1fr)] gap-x-3 gap-y-2 text-sm">
        <dt className="text-muted-foreground">Length</dt>
        <dd>{sessionTtlLabel(ttl)} (default). Choose 1 h, 8 h, 7 days or until reboot.</dd>
        <dt className="text-muted-foreground">Lock after idle</dt>
        <dd>{idle.replace(/h$/, " h").replace(/m$/, " min")} without use</dd>
      </dl>
      {changing ? (
        <form id="session-form" className="mt-4 grid gap-3">
          <div className="grid gap-1.5">
            <HelpLabel htmlFor="session-ttl" label="Session length" help="How long the vault stays unlocked after you unlock it. When this ends, you unlock again." />
            <Select name="ttl" items={LENGTHS.map(([value, label]) => ({ value, label }))} defaultValue={ttl}>
              <SelectTrigger id="session-ttl" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectPopup>
                {LENGTHS.map(([value, label]) => (
                  <SelectItem key={value} value={value}>
                    {label}
                  </SelectItem>
                ))}
              </SelectPopup>
            </Select>
          </div>
          <div className="grid gap-1.5">
            <HelpLabel htmlFor="session-idle" label="Lock after no activity" help="The vault locks itself when the panel has not been used for this long, even before the session length ends." />
            <Select name="idle" items={IDLE.map(([value, label]) => ({ value, label }))} defaultValue={idle}>
              <SelectTrigger id="session-idle" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectPopup>
                {IDLE.map(([value, label]) => (
                  <SelectItem key={value} value={value}>
                    {label}
                  </SelectItem>
                ))}
              </SelectPopup>
            </Select>
          </div>
          <div className="flex flex-wrap justify-end gap-2">
            <Button type="button" variant="ghost" onClick={() => setChanging(false)}>
              Cancel
            </Button>
            <Button type="submit">Save length</Button>
          </div>
          <Note>Changing the session length locks the current SSH session.</Note>
        </form>
      ) : null}
      <div className="mt-4 flex flex-wrap justify-end gap-2">
        {changing ? null : (
          <Button type="button" variant="secondary" onClick={() => setChanging(true)}>
            Change length
          </Button>
        )}
        <Action action="lock" label="Lock now" kind="quiet" />
      </div>
    </Section>
  );
}

function formatLeft(expiresAt: number) {
  const ms = expiresAt - Date.now();
  if (ms <= 0) return "expired";
  const hours = Math.floor(ms / 3_600_000);
  if (hours >= 1) return `${hours} h left`;
  return `${Math.max(1, Math.round(ms / 60_000))} min left`;
}

type ServiceStatus = { running: boolean; text: string } | undefined;

function ServiceCard() {
  const [status, setStatus] = useState<ServiceStatus>();
  useEffect(() => {
    fetch("/api/service", { credentials: "same-origin" })
      .then((response) => response.json() as Promise<{ running: boolean; text: string }>)
      .then(setStatus)
      .catch(() => setStatus({ running: false, text: "Status unavailable" }));
  }, []);
  return (
    <Section
      title={
        <span className="flex items-center justify-between gap-3">
          Background service
          <StatusBadge tone={status?.running ? "success" : "neutral"}>{status ? status.text : "checking"}</StatusBadge>
        </span>
      }
    >
      <Muted>Starts when you log in. Keeps sync and requests working while no window is open.</Muted>
      <dl className="mt-3 grid grid-cols-[120px_minmax(0,1fr)] gap-x-3 gap-y-2 text-sm">
        <dt className="text-muted-foreground">Start</dt>
        <dd>At login on Windows, macOS and Linux</dd>
        <dt className="text-muted-foreground">Updates</dt>
        <dd>Checked daily. You confirm each update.</dd>
      </dl>
      <div className="mt-4 flex flex-wrap justify-end gap-2">
        <Action action="service-restart" label="Restart" kind="secondary" />
        <Action action="service-stop" label="Stop" kind="quiet-danger" />
      </div>
    </Section>
  );
}

function PanelCard() {
  const [version, setVersion] = useState<string>();
  useEffect(() => {
    fetch("/api/update", { credentials: "same-origin" })
      .then((response) => response.json() as Promise<{ current: string }>)
      .then((value) => setVersion(value.current))
      .catch(() => undefined);
  }, []);
  return (
    <Section title="Panel">
      <form id="settings-form" className="grid gap-4 md:grid-cols-2">
        <div className="grid gap-1.5">
          <HelpLabel htmlFor="device-label" label="Device name" help="The name other paired computers show for this one." />
          <Input id="device-label" name="name" defaultValue={ui.state.device.name} maxLength={100} required />
        </div>
        <div className="flex items-end justify-end">
          <Button type="submit">Save name</Button>
        </div>
      </form>
      <dl className="mt-4 grid grid-cols-[120px_minmax(0,1fr)] gap-x-3 gap-y-2 text-sm">
        <dt className="text-muted-foreground">Address</dt>
        <dd className={cn("font-mono text-[12px] break-all")}>{location.origin}</dd>
        <dt className="text-muted-foreground">Theme</dt>
        <dd>System</dd>
        <dt className="text-muted-foreground">Version</dt>
        <dd>{version ?? "—"}</dd>
      </dl>
    </Section>
  );
}
