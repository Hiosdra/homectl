// Settings: this device's name, the session lifetime, and how the service runs.
import { useState } from "react";
import { sessionTtlPresets } from "../format";
import { pairingAddress, ui } from "../store";
import { Note, PageHeading, Pre, Section, Facts } from "../shared";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "../ui/select";

const idlePresets = [
  ["30m", "30 minutes"],
  ["2h", "2 hours"],
  ["8h", "8 hours"],
  ["24h", "24 hours"],
] as const;

// The session lifetime: presets, or a custom duration that appears when chosen.
function SessionTtlControl({ value, idle }: { value: string; idle: string }) {
  const isPreset = sessionTtlPresets.some(([ttl]) => ttl === value);
  const [custom, setCustom] = useState(!isPreset);
  const ttlItems = [
    ...sessionTtlPresets.map(([ttl, label]) => ({ value: ttl, label })),
    { value: "custom", label: "Custom duration…" },
  ];
  const idleItems = idlePresets.map(([v, label]) => ({ value: v, label }));
  return (
    <div className="grid gap-4">
      <div className="grid gap-1.5">
        <Label htmlFor="ttl">Session lifetime</Label>
        <Select
          name="ttl"
          items={ttlItems}
          defaultValue={custom ? "custom" : value}
          onValueChange={(next) => setCustom(next === "custom")}
        >
          <SelectTrigger id="ttl" className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectPopup>
            {ttlItems.map((item) => (
              <SelectItem key={item.value} value={item.value}>
                {item.label}
              </SelectItem>
            ))}
          </SelectPopup>
        </Select>
      </div>
      {custom ? (
        <div className="grid gap-1.5">
          <Label htmlFor="custom-ttl-value">Duration</Label>
          <Input
            id="custom-ttl-value"
            name="custom-ttl"
            defaultValue={isPreset ? "" : value}
            placeholder="For example, 30m or 2d"
            pattern="[1-9][0-9]{0,6}[smhd]"
            autoComplete="off"
          />
          <Note>Use seconds, minutes, hours, or days (up to 365 days).</Note>
        </div>
      ) : null}
      <div className="grid gap-1.5">
        <Label htmlFor="idle">Lock after no activity</Label>
        <Select name="idle" items={idleItems} defaultValue={idle}>
          <SelectTrigger id="idle" className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectPopup>
            {idleItems.map((item) => (
              <SelectItem key={item.value} value={item.value}>
                {item.label}
              </SelectItem>
            ))}
          </SelectPopup>
        </Select>
      </div>
    </div>
  );
}

export function Settings() {
  return (
    <>
      <PageHeading
        title="Settings"
        description="This device’s identity, session lifetime, and background execution."
      />
      <div className="grid gap-5 md:grid-cols-2">
        <Section title="This device">
          <form id="settings-form" key="settings" className="grid gap-4">
            <div className="grid gap-1.5">
              <Label htmlFor="device-label">Device name</Label>
              <Input
                id="device-label"
                name="name"
                defaultValue={ui.state.device.name}
                maxLength={100}
                required
              />
            </div>
            <SessionTtlControl
              value={ui.state.inventory.session?.ttl ?? "24h"}
              idle={ui.state.inventory.session?.idle ?? "2h"}
            />
            <Note>Changing the session lifetime locks the current SSH session.</Note>
            <div>
              <Button type="submit">Save settings</Button>
            </div>
          </form>
        </Section>
        <Section title="Server and service">
          <Facts
            items={[
              ["Other devices connect at", <code key="a">{pairingAddress()}</code>],
              ["Panel open in this browser", <code key="o">{location.origin}</code>],
              ["Identity", <code key="i">{ui.state.device.id}</code>],
            ]}
          />
          <h3 className="mt-6 mb-2 text-[15px] font-semibold">
            Keep homectl running in the background
          </h3>
          <p className="text-muted-foreground">
            For a workspace that stays available after closing the panel, install and
            start the service from a terminal. It starts with SSH access locked.
          </p>
          <Pre>
            {[
              "homectl service install --interface <LAN-IP>",
              "homectl service start",
              "homectl service status",
            ].join("\n")}
          </Pre>
          <Note>
            On Windows, install the service once from an administrator terminal. WSL
            requires systemd. See docs/windows.md.
          </Note>
        </Section>
      </div>
    </>
  );
}
