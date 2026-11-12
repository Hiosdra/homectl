// A field label with a "?" beside it. The explanation is hidden until it is asked for, so
// the screen stays quiet for people who already know what the field means.
import { useState } from "react";
import { Button } from "./ui/button";
import { Label } from "./ui/label";

export function HelpLabel({ htmlFor, label, help }: { htmlFor: string; label: string; help: string }) {
  const [open, setOpen] = useState(false);
  const helpId = `${htmlFor}-help`;
  return (
    <>
      <div className="flex items-center gap-1.5">
        <Label htmlFor={htmlFor}>{label}</Label>
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          aria-label={`About ${label}`}
          aria-expanded={open}
          aria-controls={helpId}
          onClick={() => setOpen(!open)}
        >
          ?
        </Button>
      </div>
      {open ? (
        <p id={helpId} className="text-sm text-muted-foreground">
          {help}
        </p>
      ) : null}
    </>
  );
}
