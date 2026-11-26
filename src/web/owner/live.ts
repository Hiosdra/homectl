// Live updates for the owner panel (homelab #21 D8). Server-sent events are the
// primary channel. When the stream fails, one poll loop reads the catch-up
// endpoint and the stream is retried later. The hook only signals "something
// changed"; screens re-read the broker, so no event payload is trusted.
import { useEffect, useRef, useState } from "react";
import { EVENT_TYPES, type EventEnvelope } from "../../core/contracts";
import { OwnerApiError, ownerRead } from "./api";

export type LiveMode = "live" | "polling" | "offline" | "idle";

const POLL_MS = 3000;
const RETRY_MS = 10_000;
const DEBOUNCE_MS = 150;

interface PollResult {
  origin: string;
  gap: unknown;
  events: EventEnvelope[];
}

export function useOwnerLive(options: {
  enabled: boolean;
  onChange: () => void;
  onSignedOut: () => void;
}): LiveMode {
  const [mode, setMode] = useState<LiveMode>("idle");
  // Latest callbacks without re-subscribing on every render.
  const callbacks = useRef(options);
  callbacks.current = options;

  useEffect(() => {
    if (!options.enabled) return;
    let stopped = false;
    let source: EventSource | undefined;
    let pollTimer: ReturnType<typeof setTimeout> | undefined;
    let polling = false;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    let debounce: ReturnType<typeof setTimeout> | undefined;
    let lastSeq = 0;
    let lastOrigin: string | undefined;

    const changed = () => {
      if (debounce || stopped) return;
      debounce = setTimeout(() => {
        debounce = undefined;
        if (!stopped) callbacks.current.onChange();
      }, DEBOUNCE_MS);
    };
    const seen = (seq: number, origin?: string) => {
      if (Number.isFinite(seq) && seq > lastSeq) lastSeq = seq;
      if (origin) lastOrigin = origin;
    };
    const signOut = () => {
      stopped = true;
      setMode("idle");
      callbacks.current.onSignedOut();
    };

    const pollOnce = async () => {
      try {
        const result = await ownerRead<PollResult>(
          `/v1/owner/events/poll?after=${lastSeq}`,
        );
        if (stopped) return;
        if (lastOrigin !== undefined && result.origin !== lastOrigin) {
          // Another device's event lineage: start over and re-read everything.
          lastSeq = 0;
          changed();
        }
        for (const event of result.events) seen(event.seq, event.origin);
        if (result.events.length > 0 || result.gap) changed();
        setMode("polling");
      } catch (error) {
        if (stopped) return;
        if (error instanceof OwnerApiError && error.signedOut) return signOut();
        setMode(
          error instanceof OwnerApiError && error.brokerOffline
            ? "offline"
            : "polling",
        );
      }
    };

    // One loop at a time: repeated stream errors must not start more loops.
    const startPolling = () => {
      if (polling || stopped) return;
      polling = true;
      const loop = async () => {
        await pollOnce();
        if (!stopped && polling) pollTimer = setTimeout(loop, POLL_MS);
      };
      void loop();
    };
    const stopPolling = () => {
      polling = false;
      clearTimeout(pollTimer);
    };

    const connect = () => {
      if (stopped) return;
      source = new EventSource("/v1/owner/events");
      source.onopen = () => {
        if (stopped) return;
        stopPolling();
        setMode("live");
      };
      for (const type of EVENT_TYPES) {
        source.addEventListener(type, (event) => {
          const id = (event as MessageEvent<string>).lastEventId;
          seen(Number(id.slice(id.lastIndexOf(":") + 1)));
          changed();
        });
      }
      source.onerror = () => {
        source?.close();
        source = undefined;
        if (stopped) return;
        startPolling();
        setMode("polling");
        clearTimeout(retryTimer);
        retryTimer = setTimeout(connect, RETRY_MS);
      };
    };

    connect();
    return () => {
      stopped = true;
      source?.close();
      stopPolling();
      clearTimeout(retryTimer);
      clearTimeout(debounce);
    };
    // The subscription lives for the signed-in session only.
  }, [options.enabled]);

  return mode;
}
