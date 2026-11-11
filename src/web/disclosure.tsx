// A section that opens and closes. The whole bar is the button, and a chevron turns when
// the section is open, so the control reads as expandable before anyone clicks it.
import { ChevronDownIcon } from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "./lib/utils";
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "./ui/collapsible";

export function Disclosure({
  title,
  children,
  defaultOpen = false,
  className,
  panelClassName,
  compact = false,
}: {
  title: ReactNode;
  children: ReactNode;
  defaultOpen?: boolean;
  className?: string;
  panelClassName?: string;
  // Compact bars sit inside a card; the default bar stands on its own.
  compact?: boolean;
}) {
  return (
    <Collapsible defaultOpen={defaultOpen} className={cn("grid gap-0", className)}>
      <CollapsibleTrigger
        className={cn(
          "group flex w-full cursor-pointer items-center justify-between gap-3 text-left font-medium text-foreground hover:bg-accent",
          compact
            ? "rounded-lg px-1 py-1 text-muted-foreground hover:bg-transparent hover:text-foreground"
            : "rounded-lg border border-border bg-background px-4 py-3",
        )}
      >
        <span className="min-w-0">{title}</span>
        <ChevronDownIcon
          aria-hidden="true"
          className="size-4 shrink-0 text-muted-foreground transition-transform group-data-[panel-open]:rotate-180"
        />
      </CollapsibleTrigger>
      <CollapsiblePanel className={cn("pt-3", panelClassName)}>{children}</CollapsiblePanel>
    </Collapsible>
  );
}
