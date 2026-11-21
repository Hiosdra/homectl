// Help pages for the control plane: the MCP endpoint and operator actions.
import { globalOptions, type Page } from "./help-format";

export const controlHelp: Record<string, Page> = {
  "serve-mcp": {
    usage:
      "home-ctl serve-mcp [--host 127.0.0.1] [--port 7449] [--inventory PATH]",
    intro:
      "Starts the MCP endpoint on 127.0.0.1 by default. Each client authenticates with its own token and receives only its granted scopes and hosts. Clients can inspect, plan and approve. They cannot execute, open shells or read secrets; the local operator runs approved operations with home-ctl control execute.",
    sections: [
      {
        title: "Options",
        rows: [
          ["--port PORT", "Port (default 7449)."],
          [
            "--host IPV4",
            "Bind one explicit IPv4 address, for example the NAS LAN address. Wildcard, multicast and broadcast are refused. Plain HTTP: the bearer token is not encrypted on a LAN.",
          ],
          ...globalOptions.rows,
        ],
      },
    ],
  },
  control: {
    usage:
      "home-ctl control <client|ops|show|execute|handoff|sync|audit> [options]",
    intro:
      "Local operator actions for the control plane. Run them in your private terminal; they are not available through MCP.",
    sections: [
      {
        title: "Clients",
        rows: [
          [
            "client add ID --name NAME --scopes LIST --hosts LIST --token-file PATH",
            "Create a client. The token is written to a new owner-only file and is never printed.",
          ],
          ["client list", "List clients without token material."],
          [
            "client revoke ID",
            "Revoke a client; its token stops working at once.",
          ],
          [
            "--scopes LIST",
            "Comma-separated: status:read, inspect:read, plan:create, approve:decide, proxmox:lxc:restore. Restore remains disabled until its archive safety path is implemented.",
          ],
          ["--hosts LIST", "Comma-separated inventory host names to grant."],
          [
            "--token-file PATH",
            "New file that receives the token. Must not exist.",
          ],
        ],
      },
      {
        title: "Operations",
        rows: [
          [
            "ops [--state LIST] [--all]",
            "List open operations (pending, approved, executing). --all includes history.",
          ],
          [
            "show ID",
            "Show one operation in full. ID can be a unique prefix of at least 8 characters.",
          ],
          [
            "execute ID",
            "Run an approved operation, or an inspection plan, through the existing exec policy. Single use; failed and unknown operations are not retried.",
          ],
          [
            "handoff ID --to DEVICE",
            "On the owner: offer the operation to DEVICE. The owner will not run it until DEVICE accepts, the offer is cancelled, or it expires after five minutes (or when the plan ends). Needs an open workspace; run home-ctl panel to start one.",
          ],
          [
            "handoff ID",
            "On the named receiver: accept the pending offer. Without a pending offer, takes over an unreachable owner (the takeover window must be open). The operation needs a fresh approval on this device.",
          ],
          [
            "handoff ID --cancel",
            "On the owner: withdraw an offer that nobody has accepted.",
          ],
          [
            "peer suspend DEVICE [--reason TEXT]  |  peer resume DEVICE",
            "Take a paired device out of this device's lease, so operations here do not wait for it, or put it back. Operations here may run without that device confirming the latest state: use it only when the device is offline or will stay offline. Signed, replicated and audited. Needs an open workspace; run home-ctl panel to start one.",
          ],
          [
            "resolve ID --owner DEVICE",
            "Conflicting takeovers: propose DEVICE as the owner. It applies only once DEVICE runs the same command on its own device. A device that proposes itself agrees at once.",
          ],
          [
            "sync",
            "Per-device control sync: last sync, lease, backoff, refusals and conflicts. Without a running serve it shows the last saved state and says that backoff is unknown.",
          ],
          [
            "audit verify",
            "Check the audit journal hash chain and its anchor.",
          ],
          [
            "--state LIST",
            "Comma-separated: pending, approved, executing, succeeded, failed, unknown.",
          ],
        ],
      },
      {
        title: "Quickstart",
        rows: [
          [
            "1. Add clients",
            "client add codex-pc --name ... --scopes ... --hosts ... --token-file PATH (one per agent)",
          ],
          [
            "2. Start the endpoint",
            "serve-mcp, then keep it running in a private terminal",
          ],
          [
            "3. Configure the agent",
            "URL http://127.0.0.1:7449/mcp and header Authorization: Bearer <token file contents>",
          ],
          [
            "4. Plan and approve",
            "The agent calls homectl_plan. Inspection needs no approval; changes need approval by another client.",
          ],
          [
            "5. Accept and run",
            "control execute <id>, or choose Accept in the panel's Accept requests view",
          ],
          ["6. Verify", "control audit verify, or the panel's Audit log card"],
        ],
      },
      globalOptions,
    ],
  },
};
