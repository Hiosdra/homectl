import { HelpLabel } from "./help";
// Pairing as a three-step dialog: the code and address, the phrase both screens must show,
// and the permissions the other computer gets (sync only, by default).
import { useState } from "react";
import { formatLocalDate } from "./format";
import { api, confirm, pairingAddress, refresh, render, report, ui } from "./store";
import { Action, Muted, Note, Pre } from "./shared";
import { Button } from "./ui/button";
import { Checkbox } from "./ui/checkbox";
import { Dialog, DialogDescription, DialogFooter, DialogHeader, DialogPanel, DialogPopup, DialogTitle } from "./ui/dialog";
import { Input } from "./ui/input";
import { Label } from "./ui/label";
import { cn } from "./lib/utils";

const STEPS = [
  ["Code and address", "Show or enter the one-time code"],
  ["Compare phrase", "The same phrase on both screens"],
  ["Permissions", "Sync only, by default"],
] as const;

export function PairWizard() {
  const step = ui.pairStep;
  const pair = ui.state.pair;
  const close = () => {
    ui.pairWizard = false;
    ui.pairStep = 1;
    render();
  };
  return (
    <Dialog open={ui.pairWizard} onOpenChange={(next) => (next ? undefined : close())}>
      <DialogPopup id="pair-wizard" className="rounded-dialog">
        <DialogHeader>
          <DialogTitle>Pair a computer</DialogTitle>
          <DialogDescription>Three steps. Both screens must show the same phrase.</DialogDescription>
        </DialogHeader>
        <DialogPanel className="grid gap-4">
          <ol className="grid gap-2 md:grid-cols-3">
            {STEPS.map(([title, hint], i) => (
              <li
                key={title}
                aria-current={step === i + 1 ? "step" : undefined}
                className={cn(
                  "rounded-lg border px-3 py-2.5",
                  step === i + 1 ? "border-primary bg-popover" : "border-border text-muted-foreground",
                )}
              >
                <b className="block text-sm">
                  {i + 1}. {title}
                </b>
                <span className="text-xs">{hint}</span>
              </li>
            ))}
          </ol>
          {step === 1 ? <StepCode /> : null}
          {step === 2 ? <StepPhrase /> : null}
          {step === 3 ? <StepPermissions /> : null}
        </DialogPanel>
        <DialogFooter>
          <Action action="pair-cancel" label="Cancel pairing" kind="quiet-danger" />
          {step > 1 ? (
            <Button type="button" variant="ghost" onClick={() => { ui.pairStep = (step - 1) as 1 | 2; render(); }}>
              Back
            </Button>
          ) : null}
          {step < 3 ? (
            <Button
              type="button"
              disabled={step === 1 ? !pair : !pair?.sas}
              onClick={() => { ui.pairStep = (step + 1) as 2 | 3; render(); }}
            >
              Next
            </Button>
          ) : null}
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

function StepCode() {
  const pair = ui.state.pair;
  if (pair?.code)
    return (
      <div className="grid gap-3">
        <Muted>Code expires at {formatLocalDate(pair.expiresAt)}.</Muted>
        <p>On the other computer, open Sync → Pair device, and enter this address and code:</p>
        <p className="font-mono text-[26px] tracking-[0.08em] text-foreground tabular-nums">{pairingAddress()}</p>
        <p className="font-mono text-[26px] tracking-[0.08em] text-foreground tabular-nums">{pair.code}</p>
        <Pre>{`homectl pair --address ${pairingAddress()}`}</Pre>
        <div className="flex flex-wrap gap-2">
          <Action action="pair-copy-command" label="Copy command" />
          <Action action="pair-copy-code" label="Copy one-time code" />
        </div>
        <Note>Keep the code on your devices; do not put it in chat or logs.</Note>
      </div>
    );
  if (pair)
    return <Muted>Connecting to the other computer. Next appears when the phrase is ready.</Muted>;
  return (
    <div className="grid gap-4 md:grid-cols-2">
      <div className="grid content-start gap-3 rounded-lg border border-border p-4">
        <b>Show a code here</b>
        <Muted>Use this when the other computer will enter the code.</Muted>
        <div>
          <Action action="pair-open" label="Show code" kind="primary" />
        </div>
      </div>
      <form id="pair-form" className="grid content-start gap-3 rounded-lg border border-border p-4">
        <b>Enter a code</b>
        <div className="grid gap-1.5">
          <HelpLabel htmlFor="peer-address" label="Other computer’s address" help="The address the other computer shows on its pairing screen, with port 7448, for example http://192.168.1.20:7448. Both computers must be on the same network." />
          <Input id="peer-address" name="address" placeholder="http://192.0.2.10:7448" required />
        </div>
        <div className="grid gap-1.5">
          <HelpLabel htmlFor="pair-code" label="One-time code" help="The code shown on the other computer. It expires after a few minutes and can be used for one pairing only." />
          <Input id="pair-code" name="code" inputMode="numeric" placeholder="1234-5678" autoComplete="off" required />
        </div>
        <div>
          <Button type="submit">Connect</Button>
        </div>
      </form>
    </div>
  );
}

function StepPhrase() {
  const pair = ui.state.pair;
  if (!pair?.sas) return <Muted>Waiting for the other computer to show its phrase.</Muted>;
  return (
    <div className="grid gap-3">
      <p>
        Compare this phrase on both computers. Device: <strong>{pair.remote?.name}</strong>.
      </p>
      <div className="rounded-[7px] border border-border bg-muted p-4 font-mono text-xl tracking-[0.04em]">{pair.sas}</div>
      <Muted>Continue only if both computers show the same phrase.</Muted>
      <div>
        <Button type="button" onClick={() => { ui.pairStep = 3; render(); }}>
          The phrases match
        </Button>
      </div>
    </div>
  );
}

function StepPermissions() {
  const [sync, setSync] = useState(true);
  const [diagnostics, setDiagnostics] = useState(false);
  const [administer, setAdminister] = useState(false);
  const finish = async () => {
    const name = ui.state.pair?.remote?.name ?? "the other computer";
    if (
      !(await confirm(
        `Trust ${name}?`,
        "Both computers showed the same phrase. The other computer gets only the permissions chosen here; remote operations stay disabled unless you allow them.",
      ))
    )
      return;
    await api("/api/pair/confirm", {
      permissions: { sync, diagnostics, operations: [], administer },
    });
    ui.pairWizard = false;
    ui.pairStep = 1;
    await refresh();
    report(`Paired with ${name}.`, "notice");
  };
  return (
    <div className="grid gap-4">
      <Muted>Sync only is the default. Anything more can be changed later under the device’s Permissions.</Muted>
      <Label className="flex items-center gap-2.5 text-foreground">
        <Checkbox checked={sync} onCheckedChange={(v) => setSync(v === true)} />
        Sync entries
      </Label>
      <Label className="flex items-center gap-2.5 text-foreground">
        <Checkbox checked={diagnostics} onCheckedChange={(v) => setDiagnostics(v === true)} />
        Inspect this device and its hosts
      </Label>
      <Label className="flex items-center gap-2.5 text-foreground">
        <Checkbox checked={administer} onCheckedChange={(v) => setAdminister(v === true)} />
        Operate on the computer running homectl
      </Label>
      <div>
        <Button type="button" onClick={() => void finish()}>
          Finish pairing
        </Button>
      </div>
    </div>
  );
}
