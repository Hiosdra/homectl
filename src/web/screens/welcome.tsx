// Welcome, as in the approved design: four steps to a working setup. Each step opens its
// place in the panel; skipped steps stay open and can be done later from the Dashboard.
import type { ReactNode } from "react";
import { navigate, render, ui } from "../store";
import { Action, PageHeading, Tag } from "../shared";
import { Button } from "../ui/button";

export function Welcome() {
  const machines = Object.values(ui.state.inventory.machines).filter((m) => m.transport !== "local");
  const steps: { title: string; text: string; done: boolean; action: ReactNode }[] = [
    {
      title: "Create a safe",
      text: "Encrypted database on this device",
      done: ui.state.vaultExists,
      action: <Action action="welcome-vault" label="Create" />,
    },
    {
      title: "Create an SSH key and add a machine",
      text: "One form: name, address, account. The key is created automatically.",
      done: machines.length > 0,
      action: <Action action="welcome-add-machine" label="Start" />,
    },
    {
      title: "Pair a second device",
      text: "Optional. Needed for sync between devices.",
      done: ui.state.peers.length > 0,
      action: <Action action="pair-open-wizard" label="Pair" />,
    },
    {
      title: "Connect an MCP client",
      text: "A ready command to paste into the terminal.",
      done: (ui.control?.clients ?? []).some((c) => !c.revoked),
      action: <Action action="client-dialog" label="Show command" />,
    },
  ];
  return (
    <>
      <PageHeading
        title="Welcome to homectl"
        description="Four steps to a working setup. Skip any step and come back from Dashboard."
        actions={
          <Button
            type="button"
            variant="ghost"
            onClick={() => {
              navigate("dashboard");
              render();
            }}
          >
            Dashboard
          </Button>
        }
      />
      <ol className="grid gap-3">
        {steps.map((step, i) => (
          <li
            key={step.title}
            className="flex flex-wrap items-center justify-between gap-3 rounded-panel border border-border bg-card p-4"
          >
            <div className="flex min-w-0 items-start gap-3">
              <span
                aria-hidden="true"
                className={
                  step.done
                    ? "grid size-7 shrink-0 place-items-center rounded-full bg-success/15 text-success"
                    : "grid size-7 shrink-0 place-items-center rounded-full border border-border text-muted-foreground"
                }
              >
                {step.done ? "✓" : i + 1}
              </span>
              <div>
                <b>{step.title}</b>
                <p className="text-sm text-muted-foreground">{step.text}</p>
              </div>
            </div>
            {step.done ? <Tag tone="success">done</Tag> : step.action}
          </li>
        ))}
      </ol>
    </>
  );
}
