// The guided setup's live state for the panel: the status read from the broker, the
// first-run open at Welcome, and the five-second poll while the setup page is open.
// The status is never written to the browser's storage.
import { useCallback, useEffect, useRef, useState } from "react";
import { readSetup, type SetupStatus } from "./setup-api";
import { autoOpenTarget } from "./setup-first-run";

// The setup page re-reads its progress this often while it is open (audit C5).
export const SETUP_POLL_MS = 5_000;

export function useSetupStatus({
  signedIn,
  onSetupPage,
  go,
  onError,
}: {
  signedIn: boolean;
  onSetupPage: boolean;
  go: (hash: string) => void;
  onError: (error: unknown) => unknown;
}) {
  const [setup, setSetup] = useState<SetupStatus | undefined>();

  // A failed read keeps the last status on screen.
  const reloadSetup = useCallback(async () => {
    try {
      setSetup(await readSetup());
    } catch (error) {
      onError(error);
    }
  }, [onError]);

  // A fresh broker opens the guided setup at Welcome on the owner's first sign-in.
  // The rule lives in setup-first-run.ts. It is tried once per panel load, when the
  // first status arrives, so the owner can leave the wizard afterwards without being
  // pulled back by a later refresh.
  const tried = useRef(false);
  useEffect(() => {
    if (!signedIn || tried.current || setup === undefined) return;
    tried.current = true;
    const target = autoOpenTarget(setup, location.hash);
    if (target) go(target);
  }, [setup, signedIn, go]);

  useEffect(() => {
    if (!onSetupPage) return;
    const timer = setInterval(() => void reloadSetup(), SETUP_POLL_MS);
    return () => clearInterval(timer);
  }, [onSetupPage, reloadSetup]);

  return { setup, setSetup, reloadSetup };
}
