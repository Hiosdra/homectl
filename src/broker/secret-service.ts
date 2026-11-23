// Secret requests through the broker (homelab #21 S1-S3). The agent asks for
// a secret bound to one destination; the owner provides it in the panel or
// CLI; the agent then asks the broker to *use* it. Values never travel back to
// the agent: the broker injects them (stdin of an inventory command, a file
// written with its final mode, or one HTTPS header) and redacts them from any
// output it returns. The exact destination was shown to the owner when they
// provided the value, so providing it is the approval for that one use path.
import { randomUUID } from "node:crypto";
import { fingerprint } from "../control/canonical";
import { permitsHost } from "../control/clients";
import type { ClientIdentity } from "../control/types";
import type { SecretDestination } from "../core/contracts";
import { injectionPlan, makeRedactor, type SecretBroker } from "../secrets";
import { HomectlError } from "../types";
import type { RouteExtension } from "./server";
import {
  type EventsPort,
  type ExecutorPort,
  type InventoryPort,
  OUTPUT_LIMIT,
} from "./types";

const HTTP_TIMEOUT_MS = 30_000;

export interface SecretServiceOptions {
  secrets: SecretBroker;
  inventory: InventoryPort;
  executor: ExecutorPort;
  events?: EventsPort;
  fetch?: typeof fetch;
  gate?: () => string | undefined;
  vaultUnlocked?: () => boolean;
  // Refreshes the host set the secret broker checks synchronously.
  refreshHosts?: () => Promise<void>;
}

export interface SecretUseResult {
  destination: SecretDestination["kind"];
  exitCode?: number;
  status?: number;
  stdout?: string;
  stderr?: string;
  body?: string;
}

function str(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0)
    throw new HomectlError(2, `${field} is required`);
  return value;
}

function hostOf(destination: unknown): string | undefined {
  if (destination && typeof destination === "object") {
    const host = (destination as { host?: unknown }).host;
    return typeof host === "string" ? host : undefined;
  }
  return undefined;
}

export class SecretService implements RouteExtension {
  constructor(private readonly options: SecretServiceOptions) {}

  // Same refusal as exec, so a client cannot probe which hosts exist.
  private requireHost(client: ClientIdentity, destination: unknown) {
    const host = hostOf(destination);
    if (host !== undefined && !permitsHost(client, host))
      throw new HomectlError(3, "Host not granted to this client");
  }

  private async target(destination: unknown) {
    const host = hostOf(destination);
    if (host === undefined) return undefined;
    const machine = await this.options.inventory.machine(host);
    if (!machine) throw new HomectlError(3, "Host not granted to this client");
    return { machine, binding: fingerprint(machine) };
  }

  private requireVaultAccess() {
    if (this.options.gate?.() !== undefined)
      throw new HomectlError(
        5,
        "Unlock the vault before delivering this secret",
      );
  }

  private async notify(subject: string, client: string) {
    await this.options.events?.emit("secret.requested", subject, [client], {
      id: subject,
    });
  }

  async agent(
    path: string,
    input: Record<string, unknown>,
    client: ClientIdentity,
  ): Promise<unknown> {
    if (!path.startsWith("/v1/secret/")) return undefined;
    await this.options.refreshHosts?.();
    const { secrets } = this.options;
    switch (path) {
      case "/v1/secret/request": {
        this.requireHost(client, input.destination);
        const target = await this.target(input.destination);
        const view = secrets.request({
          client: client.id,
          purpose: str(input.purpose, "purpose"),
          destination: input.destination as SecretDestination,
          fields: input.fields as never,
          targetBinding: target?.binding,
          ...(typeof input.task === "string" ? { task: input.task } : {}),
          ...(typeof input.ttlMs === "number"
            ? { requestTtlMs: input.ttlMs }
            : {}),
        });
        await this.notify(view.id, client.id);
        return view;
      }
      case "/v1/secret/status":
        return secrets.status(str(input.id, "id"), client.id);
      case "/v1/secret/cancel":
        return secrets.cancel(str(input.id, "id"), client.id);
      case "/v1/secret/use":
        this.requireHost(client, input.destination);
        return this.use(client, input);
      default:
        return undefined;
    }
  }

  async owner(
    path: string,
    input: Record<string, unknown>,
    stepUp: (password: unknown) => Promise<void>,
  ): Promise<unknown> {
    const { secrets } = this.options;
    switch (path) {
      case "/v1/owner/secrets/pending":
        // Requester text is display-only and marked as such.
        return secrets.pending().map((view) => ({
          ...view,
          purpose: { untrusted: view.purpose },
          canSave: secrets.canSave,
        }));
      case "/v1/owner/secrets/provide":
        // Providing a value approves one use path, so the owner password is
        // checked again in the same request, like other step-up routes.
        await stepUp(input.password);
        return secrets.provide(str(input.id, "id"), input.values, {
          retention: input.retention === "saved" ? "saved" : "ephemeral",
          ...(typeof input.saveName === "string"
            ? { saveName: input.saveName }
            : {}),
        });
      case "/v1/owner/secrets/decline":
        return secrets.decline(str(input.id, "id"));
      case "/v1/owner/secrets/revoke":
        secrets.revoke(str(input.ref, "ref"));
        return { revoked: true };
      case "/v1/owner/secrets/history":
        return secrets.history();
      default:
        return undefined;
    }
  }

  private async use(
    client: ClientIdentity,
    input: Record<string, unknown>,
  ): Promise<SecretUseResult> {
    if (this.options.vaultUnlocked?.() === false)
      throw new HomectlError(
        5,
        "Unlock the vault before delivering this secret",
      );
    const destination = input.destination as SecretDestination;
    const target = await this.target(destination);
    const values = await this.options.secrets.use(str(input.ref, "ref"), {
      client: client.id,
      destination,
      targetBinding: target?.binding,
      ...(typeof input.task === "string" ? { task: input.task } : {}),
    });
    const redact = makeRedactor(Object.values(values));
    // Redact first: clipping first could cut a value and leave a fragment.
    const clean = (text: string) => redact(text).slice(0, OUTPUT_LIMIT);
    const plan = injectionPlan(destination, values);
    if (plan.kind === "http-header") {
      this.requireVaultAccess();
      const response = await (this.options.fetch ?? fetch)(plan.url, {
        method: "POST",
        headers: plan.headers,
        redirect: "manual",
        signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
      });
      return {
        destination: plan.kind,
        status: response.status,
        body: clean(await response.text()),
      };
    }
    const current = await this.target(destination);
    if (!current || current.binding !== target?.binding)
      throw new HomectlError(
        3,
        "The destination configuration changed. Request the secret again",
      );
    const steps =
      plan.kind === "ssh-stdin"
        ? [{ argv: plan.argv, stdin: plan.stdin }]
        : plan.steps;
    let last = { exitCode: 0, stdout: "", stderr: "" };
    for (const step of steps) {
      this.requireVaultAccess();
      last = await this.options.executor.run({
        host: plan.host,
        machine: current.machine,
        argv: step.argv,
        operationId: `secret-${randomUUID()}`,
        ...(step.stdin === undefined ? {} : { stdin: step.stdin }),
      });
      if (last.exitCode !== 0) break;
    }
    return {
      destination: plan.kind,
      exitCode: last.exitCode,
      stdout: clean(last.stdout),
      stderr: clean(last.stderr),
    };
  }
}
