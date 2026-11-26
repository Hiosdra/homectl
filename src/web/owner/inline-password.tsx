// Compact inline password form used on Needs-you cards when approving a
// step-up operation outside the 5-minute grace window.
import { useState } from "react";
import { PasswordStep } from "./ui";

export function InlineApprovalPassword({
  busy,
  onConfirm,
  onCancel,
}: {
  busy: boolean;
  onConfirm: (password: string) => void;
  onCancel: () => void;
}) {
  const [password, setPassword] = useState("");
  return (
    <form
      className="stack"
      onSubmit={(event) => {
        event.preventDefault();
        if (!password) return;
        const typed = password;
        setPassword("");
        onConfirm(typed);
      }}
    >
      <PasswordStep
        value={password}
        onChange={setPassword}
        hint="required once (remembered for 5 min)"
      />
      <div className="request-actions">
        <button
          type="submit"
          className="primary"
          disabled={busy || password.length === 0}
        >
          Confirm approve
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={() => {
            setPassword("");
            onCancel();
          }}
        >
          Cancel
        </button>
      </div>
    </form>
  );
}
