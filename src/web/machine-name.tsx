// A machine's inventory name inside a sentence, set as one chip so it reads the same on
// every screen. The name is shown as stored; only its frame changes.
export function MachineName({ name }: { name: string }) {
  return (
    <span className="mx-px inline-block rounded-md border border-border bg-muted px-1.5 align-middle font-mono text-[0.9em] leading-6 font-semibold whitespace-nowrap text-foreground">
      {name}
    </span>
  );
}
