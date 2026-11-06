// `homectl serve --container`: the process-level lifecycle of the containerized
// peer (docs/homectl-2.0/container-peer.md). Startup recovery runs first; the
// first SIGTERM or SIGINT then starts one graceful stop, and a second signal is
// ignored so the stop can finish within Docker's grace period.
import { VERSION } from "./health";
import { recoverStartup } from "./recovery";

export type ContainerServeOptions = {
  inventoryPath: string;
  configPath: string;
  interface: string;
  port: number;
  peerPort: number;
};

// Resolves once the workspace is serving. The listeners keep the process alive
// until a signal stops it; the stop path exits with status 0.
export async function serveContainer(
  options: ContainerServeOptions,
): Promise<number> {
  let stopNow: (() => void) | undefined;
  let stopRequested = false;
  const onSignal = () => {
    if (stopRequested) return;
    stopRequested = true;
    // Before the workspace is up there is nothing to stop: exit at once.
    if (stopNow) stopNow();
    else process.exit(0);
  };
  process.on("SIGTERM", onSignal);
  process.on("SIGINT", onSignal);

  // Integrity doubts throw here; the caller prints the reason and exits.
  const startup = await recoverStartup({
    inventoryPath: options.inventoryPath,
  });
  for (const warning of startup.warnings)
    console.error(`homectl: startup: ${warning}`);

  const { serve } = await import("../serve");
  const running = await serve({
    inventoryPath: options.inventoryPath,
    configPath: options.configPath,
    interface: options.interface,
    port: options.port,
    peerPort: options.peerPort,
    // Multicast discovery does not cross the container bridge; pair manually.
    discover: false,
    controlSync: true,
    container: { recovered: startup.status === "recovered" },
  });
  stopNow = () => {
    void running.stop().then(
      () => process.exit(0),
      () => process.exit(1),
    );
  };
  // Prints the health URL and peer address only; the panel token is never printed.
  console.log(
    JSON.stringify({
      state: "running",
      version: VERSION,
      startup: startup.status,
      health: `${running.url}/healthz`,
      peers: running.address,
    }),
  );
  return 0;
}
