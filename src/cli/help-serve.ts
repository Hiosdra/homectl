// Help pages for the local serve instance, the panel, service install and pairing.
import { globalOptions, type Page } from "./help-format";

export const serveHelp: Record<string, Page> = {
  serve: {
    usage:
      "home-ctl serve [--interface LAN-IP] [--port 7447] [--peer-port 7448]",
    intro:
      "Panel binds only localhost. Pairing is opened explicitly. LAN channel requires an explicit interface IP.",
    sections: [
      {
        title: "Options",
        rows: [
          ["--interface IP", "One LAN interface address; no wildcard binding."],
          ["--port PORT", "Local panel port, default 7447."],
          ["--peer-port PORT", "Peer protocol port, default 7448."],
          [
            "--container",
            "Container mode for the containerized peer: needs an explicit --interface, runs startup recovery, serves /healthz, stops cleanly on SIGTERM, and turns discovery off. See docs/setup.md (Docker and NAS containers).",
          ],
          [
            "--panel-interface IP",
            "Optional container-only remote panel listener on one explicit container IP; requires origin and token file.",
          ],
          [
            "--panel-origin ORIGIN",
            "Exact browser origin allowed for the remote panel, including scheme and port.",
          ],
          [
            "--panel-token-file PATH",
            "Optional extra access code for the remote panel, read from a protected file or Compose secret; never logged. The database password unlocks the panel without it.",
          ],
          [
            "--no-discovery",
            "Disable multicast discovery only; use manual IP pairing. Control sync with already-paired devices keeps running.",
          ],
          [
            "--no-control-sync",
            "Turn control sync off on this device. Peers get no sync from it, and operations here with signing peers wait for a sync.",
          ],
        ],
      },
      globalOptions,
    ],
  },
  service: {
    usage:
      "home-ctl service <install|start|stop|restart|status|logs|uninstall>",
    intro:
      "Linux/WSL use a systemd user service. Windows uses an official WinSW host with an explicitly configured user account. On Windows, --task uses a scheduled task that starts at your sign-in instead, with no service account and no password; install it with --dry-run first to see the command.",
    sections: [
      {
        title: "Install",
        rows: [
          ["--interface IP", "Persist the LAN interface for serve."],
          ["--wrapper PATH", "Windows: path to an official WinSW executable."],
        ],
      },
      globalOptions,
    ],
  },
  panel: {
    usage: "home-ctl panel [--interface LAN-IP] [--inventory PATH]",
    intro:
      "Run yourself in a private terminal. Opens the panel and starts a temporary workspace if needed; keep this terminal open until you finish. The private launch token is never emitted as JSON.",
    sections: [globalOptions],
  },
  peers: {
    usage: "home-ctl peers [--json]",
    intro:
      "List paired peers from the running local serve instance, without secrets.",
    sections: [globalOptions],
  },
  pair: {
    usage: "home-ctl pair [--address http://DEVICE-LAN-IP:7448]",
    intro:
      "Use home-ctl pair on both devices for guided LAN discovery. If discovery is blocked (for example by Docker, Wi-Fi isolation or VLANs), open pairing in one device's UI and run home-ctl pair --address http://<device-LAN-IP>:7448 on the other. It starts the local pairing endpoint, asks for the code privately and guides phrase verification; no separate serve command is needed. If Windows asks, allow homectl on private networks. Keep the terminal open until pairing and sync are finished. Codes and phrases are private, never argv. Advanced subcommands remain available.",
    sections: [
      {
        title: "Pairing",
        rows: [
          [
            "--interface IP",
            "Local LAN interface for the temporary workspace.",
          ],
          [
            "--address URL",
            "Manual pair join endpoint, e.g. http://192.168.1.10:7448",
          ],
        ],
      },
      globalOptions,
    ],
  },
  sync: {
    usage:
      "home-ctl sync <preview|apply|cancel> <peer-or-preview-id> [--file choices.json]",
    intro:
      "Review the preview before applying. An explicit choices JSON file is required, even when it contains {} and there are no conflicts. Choose local, remote or both for each conflict ID.",
    sections: [
      {
        title: "Apply",
        rows: [
          [
            "--file PATH",
            "Required reviewed choices object. Use {} when no conflicts exist.",
          ],
        ],
      },
      globalOptions,
    ],
  },
};
