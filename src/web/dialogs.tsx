// The confirmation and vault-unlock dialogs. Both are driven by requests in the store:
// a caller awaits the answer, and closing the dialog without choosing counts as no.
import type { FormEvent } from "react";
import { api, closeUnlock, element, render, ui } from "./store";
import { Alert, AlertDescription } from "./ui/alert";
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "./ui/alert-dialog";
import { Button } from "./ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "./ui/dialog";
import { Input } from "./ui/input";
import { Label } from "./ui/label";
import { Note, Pre } from "./shared";

export function ConfirmDialog() {
  const request = ui.confirmRequest;
  return (
    <AlertDialog
      open={request !== undefined}
      onOpenChange={(open) => {
        if (!open && ui.confirmRequest) ui.confirmRequest.resolve(false);
      }}
    >
      <AlertDialogPopup id="confirm-dialog" className="rounded-dialog">
        <AlertDialogHeader>
          <AlertDialogTitle id="confirm-title">{request?.title}</AlertDialogTitle>
          <AlertDialogDescription id="confirm-description" render={<div />}>
            {request?.body}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogClose render={<Button variant="ghost" value="cancel" />}>Cancel</AlertDialogClose>
          <Button value="confirm" onClick={() => request?.resolve(true)}>Confirm</Button>
        </AlertDialogFooter>
      </AlertDialogPopup>
    </AlertDialog>
  );
}

export function UnlockDialog() {
  const request = ui.unlockRequest;
  return (
    <Dialog
      open={request !== undefined}
      onOpenChange={(open) => {
        if (!open && ui.unlockRequest) closeUnlock(false);
      }}
    >
      <DialogPopup id="sync-unlock-dialog" className="rounded-dialog">
        <form
          id="sync-unlock-form"
          className="contents"
          onSubmit={(event) => void submitUnlock(event)}
        >
          <DialogHeader>
            <DialogTitle>Unlock this device&apos;s vault</DialogTitle>
            <DialogDescription>
              Enter this device&apos;s vault password. After unlocking, compare the
              devices again to review a fresh sync preview. The password is sent to
              this workspace over the current connection.
            </DialogDescription>
          </DialogHeader>
          <DialogPanel className="grid gap-2">
            <Label htmlFor="sync-unlock-password">Vault password</Label>
            <Input
              id="sync-unlock-password"
              type="password"
              autoComplete="current-password"
              autoFocus
              required
            />
            {request?.error ? (
              <Alert id="sync-unlock-error" variant="error" className="mt-2">
                <AlertDescription>{request.error}</AlertDescription>
              </Alert>
            ) : null}
          </DialogPanel>
          <DialogFooter>
            <Button
              type="button"
              id="sync-unlock-cancel"
              variant="ghost"
              onClick={() => closeUnlock(false)}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={request?.submitting === true}>
              Unlock vault
            </Button>
          </DialogFooter>
        </form>
      </DialogPopup>
    </Dialog>
  );
}

async function submitUnlock(event: FormEvent<HTMLFormElement>) {
  event.preventDefault();
  const password = element<HTMLInputElement>("sync-unlock-password");
  const value = password.value;
  password.value = "";
  if (ui.unlockRequest) {
    ui.unlockRequest.submitting = true;
    ui.unlockRequest.error = undefined;
    render();
  }
  try {
    await api("/api/vault/unlock", { password: value, create: false });
    closeUnlock(true);
  } catch (e) {
    if (ui.unlockRequest) {
      ui.unlockRequest.error =
        e instanceof Error ? e.message : "Could not unlock the vault.";
      ui.unlockRequest.submitting = false;
    }
    render();
    password.focus();
  }
}

// Connect an MCP client: the command to run in a private terminal, which writes the token
// file locally. The panel never creates or shows a client token.
export function ClientDialog() {
  const close = () => {
    ui.clientDialog = false;
    render();
  };
  return (
    <Dialog open={ui.clientDialog} onOpenChange={(next) => (next ? undefined : close())}>
      <DialogPopup id="client-dialog" className="rounded-dialog">
        <DialogHeader>
          <DialogTitle>Connect an MCP client</DialogTitle>
          <DialogDescription>Each client gets its own identity, scopes and host grants.</DialogDescription>
        </DialogHeader>
        <DialogPanel className="grid gap-3">
          <p>Run this in a private terminal. It writes the token file locally, so the token is never shown here.</p>
          <Pre>
            {COMMAND}
          </Pre>
          <Note>Replace the placeholders. Only clients granted approve:decide can approve operations.</Note>
        </DialogPanel>
        <DialogFooter>
          <Button type="button" variant="ghost" onClick={close}>
            Close
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

const COMMAND =
  'homectl control client add codex-pc --name "Codex PC" --scopes status:read,inspect:read,plan:create --hosts <host> --token-file <path>';
