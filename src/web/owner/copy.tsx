// A button that copies text to the clipboard and says what happened. The clipboard
// can be blocked (a private window, a page that is not focused), so a failure is
// said in words and the text stays on screen to select by hand.
import { useState } from "react";

export function CopyButton({
  label,
  text,
  primary = false,
}: {
  label: string;
  text: string;
  primary?: boolean;
}) {
  const [result, setResult] = useState<string | undefined>();
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setResult(`Copied the ${label}.`);
    } catch {
      setResult("Could not copy. Select the text and copy it by hand.");
    }
  };
  return (
    <span className="copy-control">
      <button
        type="button"
        className={primary ? "primary" : undefined}
        onClick={() => void copy()}
      >
        {`Copy ${label}`}
      </button>
      {result ? (
        <span className="small muted" role="status">
          {result}
        </span>
      ) : null}
    </span>
  );
}
