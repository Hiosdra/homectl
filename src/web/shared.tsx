// Building blocks shared by the screens: action buttons that the root handler runs,
// page headings, sections, status badges and the responsive table.
import type { ReactNode } from "react";
import { ui } from "./store";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "./ui/table";
import { cn } from "./lib/utils";

export type ActionKind =
  | "primary"
  | "secondary"
  | "quiet"
  | "danger"
  | "quiet-danger"
  | "accept";

const ACTION_KIND: Record<ActionKind, { variant: "default" | "secondary" | "ghost" | "destructive-outline"; className?: string }> = {
  primary: { variant: "default" },
  secondary: { variant: "secondary" },
  quiet: { variant: "ghost" },
  danger: { variant: "destructive-outline" },
  "quiet-danger": { variant: "ghost", className: "text-destructive-foreground" },
  accept: {
    variant: "default",
    className: "border-success bg-success text-background hover:bg-success/90",
  },
};

// A button handled by the panel's root click handler (data-action and data-id).
export function Action({
  action,
  id = "",
  label,
  kind = "secondary",
  className,
}: {
  action: string;
  label: ReactNode;
  id?: string;
  kind?: ActionKind;
  className?: string;
}) {
  const style = ACTION_KIND[kind];
  return (
    <Button
      type="button"
      variant={style.variant}
      className={cn(style.className, className)}
      data-action={action}
      data-id={id}
      disabled={ui.busy}
    >
      {label}
    </Button>
  );
}

export function PageHeading({
  title,
  description,
  actions,
}: {
  title: string;
  description: string;
  actions?: ReactNode;
}) {
  return (
    <header className="mb-7 flex flex-wrap items-start justify-between gap-5">
      <div className="min-w-0">
        <h1
          tabIndex={-1}
          className="font-heading text-[30px] leading-[1.18] font-semibold tracking-[-0.025em] outline-none max-[700px]:text-[26px]"
        >
          {title}
        </h1>
        <p className="mt-2.5 max-w-[72ch] text-muted-foreground">{description}</p>
      </div>
      {actions ? <div className="flex flex-wrap gap-2.5">{actions}</div> : null}
    </header>
  );
}

// A bordered surface for one part of a screen.
export function Section({
  title,
  children,
  className,
  id,
}: {
  title?: ReactNode;
  children: ReactNode;
  className?: string;
  id?: string;
}) {
  return (
    <section
      id={id}
      className={cn(
        "rounded-panel border border-border bg-card p-6 max-[700px]:p-[18px]",
        className,
      )}
    >
      {title ? (
        <h2 className="mb-3 text-xl font-semibold tracking-[-0.015em]">{title}</h2>
      ) : null}
      {children}
    </section>
  );
}

// A helper line under a heading or control.
export function Note({ children }: { children: ReactNode }) {
  return <p className="mt-2 max-w-none text-xs text-muted-foreground">{children}</p>;
}

export function Muted({ children }: { children: ReactNode }) {
  return <p className="text-muted-foreground">{children}</p>;
}

// Status tags. Each carries a text label; colour only reinforces it.
export type Tone = "neutral" | "ready" | "success" | "warning" | "danger" | "info";

const TONE: Record<Tone, { variant: "outline" | "default" | "success" | "warning" | "destructive" | "info"; className?: string }> = {
  neutral: { variant: "outline", className: "text-muted-foreground" },
  ready: { variant: "info", className: "text-[#8ee3f0]" },
  success: { variant: "success" },
  warning: { variant: "warning" },
  danger: { variant: "destructive", className: "text-white" },
  info: { variant: "info" },
};

export function Tag({
  tone = "neutral",
  children,
  title,
  className,
}: {
  tone?: Tone;
  children: ReactNode;
  title?: string;
  className?: string;
}) {
  const style = TONE[tone];
  return (
    <Badge
      variant={style.variant}
      className={cn("font-medium", style.className, className)}
      title={title}
    >
      {children}
    </Badge>
  );
}

// Responsive data table. Wide screens get a grid; phones stack each row into a card,
// with the column name from data-label shown before each value.
export function DataTable({
  head,
  children,
  className,
}: {
  head: ReactNode[];
  children: ReactNode;
  className?: string;
}) {
  return (
    <div
      data-table
      className={cn("overflow-auto rounded-panel border border-border bg-card", className)}
    >
      <Table className="w-full text-left max-[700px]:block">
        <TableHeader className="bg-muted max-[700px]:hidden">
          <TableRow className="hover:bg-transparent">
            {head.map((label, i) => (
              <TableHead
                key={i}
                className="h-auto px-4 py-3 text-xs font-medium text-muted-foreground"
              >
                {label}
              </TableHead>
            ))}
          </TableRow>
        </TableHeader>
        <TableBody className="max-[700px]:block">{children}</TableBody>
      </Table>
    </div>
  );
}

export function Row({
  children,
  className,
  search,
  hidden,
  operationId,
}: {
  children: ReactNode;
  className?: string;
  search?: string;
  hidden?: boolean;
  operationId?: string;
}) {
  return (
    <TableRow
      data-operation={operationId}
      data-search={search}
      hidden={hidden}
      className={cn(
        "border-border max-[700px]:grid max-[700px]:grid-cols-2 max-[700px]:gap-1.5 max-[700px]:border-b max-[700px]:px-3.5 max-[700px]:py-3",
        className,
      )}
    >
      {children}
    </TableRow>
  );
}

// A cell. `label` is the column name shown on phones.
export function Cell({
  label,
  children,
  className,
  wide,
}: {
  label: string;
  children: ReactNode;
  className?: string;
  wide?: boolean;
}) {
  return (
    <TableCell
      data-label={label}
      className={cn(
        "px-4 py-3.5 align-top whitespace-normal max-[700px]:block max-[700px]:border-0 max-[700px]:p-0",
        "max-[700px]:before:block max-[700px]:before:text-[11px] max-[700px]:before:text-muted-foreground max-[700px]:before:content-[attr(data-label)]",
        wide && "max-[700px]:col-span-2",
        className,
      )}
    >
      {children}
    </TableCell>
  );
}

// The panel's empty state: a dashed boundary with guidance and optional actions.
export function EmptyState({
  title,
  children,
  actions,
}: {
  title?: string;
  children: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <div className="rounded-dialog border border-dashed border-[#3b4c62] px-7 py-14 text-center text-muted-foreground max-[700px]:px-5">
      {title ? (
        <h2 className="mb-2.5 text-xl font-semibold tracking-[-0.015em] text-foreground">
          {title}
        </h2>
      ) : null}
      <div className="mx-auto max-w-[55ch]">{children}</div>
      {actions ? <div className="mt-6 flex flex-wrap justify-center gap-2.5">{actions}</div> : null}
    </div>
  );
}

// Lines of a list row: the main text on the left, actions on the right.
export function ListRow({
  children,
  actions,
  className,
}: {
  children: ReactNode;
  actions?: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "flex flex-wrap items-center justify-between gap-4 border-b border-border py-5 last:border-b-0 max-[700px]:flex-col max-[700px]:items-start",
        className,
      )}
    >
      <div className="min-w-0">{children}</div>
      {actions ? <div className="flex flex-wrap gap-2">{actions}</div> : null}
    </div>
  );
}

// Key-value details, two columns on wide screens and stacked on phones.
export function Facts({ items }: { items: [ReactNode, ReactNode][] }) {
  return (
    <dl className="grid grid-cols-[130px_minmax(0,1fr)] gap-x-4 gap-y-2.5 max-[700px]:grid-cols-[100px_minmax(0,1fr)]">
      {items.map(([term, value], i) => (
        <div key={i} className="contents">
          <dt className="text-muted-foreground">{term}</dt>
          <dd className="m-0 break-words">{value}</dd>
        </div>
      ))}
    </dl>
  );
}

// Preformatted output: commands, JSON and command results.
export function Pre({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <pre
      className={cn(
        "max-h-[420px] overflow-auto rounded-[7px] border border-border bg-[#0d1520] p-4 font-mono text-[12px] whitespace-pre-wrap break-words",
        className,
      )}
    >
      {children}
    </pre>
  );
}

// Disclosures open by default on desktop and closed on phones, where the vault and
// key forms would otherwise push everything else down.
export function phoneView(): boolean {
  return window.matchMedia("(max-width: 699px)").matches;
}
