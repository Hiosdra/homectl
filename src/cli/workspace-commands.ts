// Owner commands for workspace mode (homelab #21 §6). Each one asks the local
// daemon, which holds the state and the link keys; this module never reads
// them. The owner password is passed on every call that changes trust or
// approves an operation, so the server sees a fresh step-up.
import { type CallOptions, callBroker } from "../broker/client";
import { HomectlError } from "../types";

type Emit = (value: unknown, human?: string) => void;

export interface OwnerAuth extends CallOptions {
  password: string;
}

export interface WorkspaceCommandOptions {
  auth(): Promise<OwnerAuth>;
  emit: Emit;
  remoteApproval: boolean;
}

const USAGE =
  "Usage: home-ctl workspace invite | join <address> <code> [--remote-approval] | status | clients | pending | decide <client> <operationId> <fingerprint> approve|deny | remove <client> | leave | sync-now | backup-now";

function line(value: unknown): string {
  return JSON.stringify(value);
}

// Returns an exit code. Positionals are the words after `workspace`.
export async function workspaceCommand(
  positionals: string[],
  options: WorkspaceCommandOptions,
): Promise<number> {
  const [action, ...rest] = positionals;
  const { emit } = options;
  if (!action) throw new HomectlError(2, USAGE);
  const auth = await options.auth();
  const post = <T>(path: string, body: Record<string, unknown>) =>
    callBroker<T>(path, body, auth);
  const password = auth.password;
  switch (action) {
    case "invite": {
      const result = await post<{
        code: string;
        expiresAt: string;
        server: { id: string; name: string };
      }>("/v1/owner/workspace/invite", { password });
      emit(
        result,
        `Enter code ${result.code} on the other device within 5 minutes (until ${result.expiresAt}). Compare the verification phrase it shows with the one from \`workspace join\`.`,
      );
      return 0;
    }
    case "join": {
      const [address, code] = rest;
      if (!address || !code)
        throw new HomectlError(
          2,
          "Usage: home-ctl workspace join <address> <code> [--remote-approval]",
        );
      const result = await post<{
        server: { id: string; name: string };
        sas: string;
        backupKey: string;
      }>("/v1/owner/workspace/join", {
        address,
        code,
        remoteApproval: options.remoteApproval,
        password,
      });
      emit(
        result,
        `Linked to ${result.server.name}. Verification phrase: ${result.sas}. Remote approval: ${options.remoteApproval ? "on" : "off"}. Backup key registration with the server: ${result.backupKey}.`,
      );
      return 0;
    }
    case "status": {
      const result = await post("/v1/owner/workspace/status", {});
      emit(result, line(result));
      return 0;
    }
    case "clients": {
      const result = await post<
        {
          id: string;
          name: string;
          stale: boolean;
          remoteApproval: boolean;
          pending: number;
        }[]
      >("/v1/owner/workspace/clients", {});
      emit(
        result,
        result.length
          ? result
              .map(
                (c) =>
                  `${c.id}  ${c.name}${c.stale ? "  (stale)" : ""}  remote approval: ${c.remoteApproval ? "on" : "off"}  pending: ${c.pending}`,
              )
              .join("\n")
          : "No linked clients.",
      );
      return 0;
    }
    case "pending": {
      const result = await post<
        {
          origin: string;
          originName: string;
          id: string;
          host: string;
          argv: string[];
          fingerprint: string;
          risk: string;
        }[]
      >("/v1/owner/workspace/pending", {});
      emit(
        result,
        result.length
          ? result
              .map(
                (p) =>
                  `${p.id}  ${p.originName} -> ${p.host}  [${p.risk}]  fingerprint ${p.fingerprint}\n    ${JSON.stringify(p.argv)}`,
              )
              .join("\n")
          : "Nothing is waiting for approval on linked clients.",
      );
      return 0;
    }
    case "decide": {
      const [client, operationId, fingerprint, verdict] = rest;
      const decision =
        verdict === "approve"
          ? "approve-once"
          : verdict === "deny"
            ? "deny-once"
            : undefined;
      if (!client || !operationId || !fingerprint || !decision)
        throw new HomectlError(
          2,
          "Usage: home-ctl workspace decide <client> <operationId> <fingerprint> approve|deny",
        );
      const result = await post<{ operationId: string; status: string }>(
        "/v1/owner/workspace/decide",
        { client, operationId, fingerprint, decision, password },
      );
      emit(
        result,
        `Queued ${verdict === "approve" ? "approval" : "denial"} for ${operationId} on ${client} (intent ${result.status}). The client applies it at its next sync.`,
      );
      return 0;
    }
    case "remove": {
      const [client] = rest;
      if (!client)
        throw new HomectlError(2, "Usage: home-ctl workspace remove <client>");
      const result = await post("/v1/owner/workspace/remove", {
        client,
        password,
      });
      emit(result, `Removed ${client}. It cannot rejoin with this identity.`);
      return 0;
    }
    case "leave": {
      const result = await post("/v1/owner/workspace/leave", { password });
      emit(result, "Left the workspace server.");
      return 0;
    }
    case "sync-now": {
      const result = await post("/v1/owner/workspace/sync-now", {});
      emit(result, line(result));
      return 0;
    }
    case "backup-now": {
      const result = await post("/v1/owner/workspace/backup-now", {});
      emit(result, line(result));
      return 0;
    }
    default:
      throw new HomectlError(2, USAGE);
  }
}
