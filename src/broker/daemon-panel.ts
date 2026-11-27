import { panelBinding } from "../web/owner/binding";
import { type OwnerPanelOptions, startOwnerPanel } from "../web/owner/server";
import { type DaemonConfig, startDaemon } from "./daemon";

export async function startDaemonWithPanel(
  config: DaemonConfig,
  options: Pick<
    OwnerPanelOptions,
    "port" | "origin" | "listen" | "insecureHttp"
  >,
) {
  const binding = panelBinding(options);
  const daemon = await startDaemon({ ...config, panelOrigin: binding.origin });
  try {
    const panel = await startOwnerPanel({
      ...options,
      inventoryPath: config.inventoryPath,
      listen: binding.hostname,
      origin: binding.origin,
      insecureHttp: options.insecureHttp ?? false,
      endpoint: daemon.endpoint,
    });
    return {
      ...daemon,
      async stop() {
        panel.stop();
        await daemon.stop();
      },
    };
  } catch (error) {
    await daemon.stop();
    throw error;
  }
}
