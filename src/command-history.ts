import { randomUUID } from "node:crypto";
import { lstat, readFile, unlink, writeFile } from "node:fs/promises";
import { hostname } from "node:os";
import { dirname, join, resolve } from "node:path";
import { withFileLock } from "./control/file-lock";
import { redactArgvBroad } from "./control/redact";
import type { Classification } from "./control/types";
import {
  atomicReplace,
  ownedByCurrentUser,
  privateDirectory,
  protect,
  windows,
} from "./platform";

export type CommandHistoryStatus =
  | "executing"
  | "succeeded"
  | "failed"
  | "unknown"
  | "refused"
  | "approval-required";

export type CommandHistoryEntry = {
  id: string;
  sequence: number;
  at: string;
  phase: "started" | "outcome";
  host: string;
  argv: string[];
  requester: string;
  requesterName?: string;
  approver?: string;
  operationId: string;
  classification?: Classification;
  policyDecision: "allowed" | "needs-approval" | "refused";
  status: CommandHistoryStatus;
  exitCode?: number;
  durationMs?: number;
  reason?: string;
};

export type LocalCommandHistoryInput = {
  inventoryPath: string;
  host: string;
  argv: string[];
  phase: CommandHistoryEntry["phase"];
  status: CommandHistoryStatus;
  policyDecision: CommandHistoryEntry["policyDecision"];
  operationId?: string;
  classification?: Classification;
  requester?: string;
  requesterName?: string;
  approver?: string;
  startedAt?: number;
  finishedAt?: number;
  exitCode?: number;
  reason?: string;
};

type HistoryOptions = {
  maxEntries?: number;
  maxAgeDays?: number;
  getUid?: () => number | undefined;
  now?: () => number;
  warn?: (message: string) => void;
};

function positiveSetting(name: string, fallback: number): number {
  const value = Number(process.env[name]);
  return Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

export function commandHistoryPath(inventoryPath: string): string {
  return join(dirname(resolve(inventoryPath)), "history", "commands.jsonl");
}

function parseHistory(text: string): {
  entries: CommandHistoryEntry[];
  malformedLines: number;
} {
  const entries: CommandHistoryEntry[] = [];
  let malformedLines = 0;
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      const entry: unknown = JSON.parse(line);
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
        malformedLines++;
        continue;
      }
      const candidate = entry as CommandHistoryEntry;
      if (
        typeof candidate.id !== "string" ||
        !Number.isSafeInteger(candidate.sequence) ||
        candidate.sequence < 1 ||
        typeof candidate.at !== "string" ||
        typeof candidate.host !== "string" ||
        !Array.isArray(candidate.argv) ||
        typeof candidate.requester !== "string" ||
        typeof candidate.operationId !== "string" ||
        typeof candidate.status !== "string" ||
        (candidate.phase !== "started" && candidate.phase !== "outcome")
      ) {
        malformedLines++;
        continue;
      }
      entries.push(candidate);
    } catch {
      malformedLines++;
    }
  }
  return { entries, malformedLines };
}

export class CommandHistoryStore {
  readonly path: string;
  readonly directory: string;
  private chain: Promise<void> = Promise.resolve();
  // On Windows each ownership or permission check starts PowerShell (about
  // 250 ms), so successful checks are remembered for this store. Any failed
  // write forgets them and the next write checks everything again.
  private directoryReady = false;
  private fileTrusted = false;
  private readonly maxEntries: number;
  private readonly maxAgeDays: number;
  private readonly getUid: () => number | undefined;
  private readonly now: () => number;
  private readonly warn: (message: string) => void;

  constructor(inventoryPath: string, options: HistoryOptions = {}) {
    this.path = commandHistoryPath(inventoryPath);
    this.directory = dirname(this.path);
    this.maxEntries =
      options.maxEntries ??
      positiveSetting("HOMECTL_HISTORY_MAX_ENTRIES", 5000);
    this.maxAgeDays =
      options.maxAgeDays ?? positiveSetting("HOMECTL_HISTORY_MAX_AGE_DAYS", 30);
    this.getUid = options.getUid ?? (() => process.getuid?.());
    this.now = options.now ?? Date.now;
    this.warn = options.warn ?? console.warn;
  }

  append(input: LocalCommandHistoryInput): Promise<void> {
    const task = this.chain.then(() => this.appendNow(input));
    this.chain = task.catch(() => {
      try {
        this.warn("Could not write local command history.");
      } catch {
        return;
      }
    });
    return this.chain;
  }

  async flush(): Promise<void> {
    await this.chain;
  }

  async read(): Promise<CommandHistoryEntry[]> {
    return (await this.readWithIssues()).entries;
  }

  async readWithIssues(): Promise<{
    entries: CommandHistoryEntry[];
    malformedLines: number;
  }> {
    await this.chain;
    const trusted = this.directoryReady && this.fileTrusted;
    if (
      !(await this.exists(this.directory)) ||
      (!trusted && !(await ownedByCurrentUser(this.directory)))
    )
      return { entries: [], malformedLines: 0 };
    if (
      !(await this.exists(this.path)) ||
      (!trusted && !(await ownedByCurrentUser(this.path)))
    )
      return { entries: [], malformedLines: 0 };
    return parseHistory(await readFile(this.path, "utf8"));
  }

  async clear(): Promise<boolean> {
    await this.chain;
    if (this.getUid() === 0) {
      this.warn(
        "Local command history was not cleared because homectl is running as root.",
      );
      return false;
    }
    const stateDirectory = dirname(this.directory);
    if (!(await ownedByCurrentUser(stateDirectory))) {
      this.warn(
        "Local command history was not cleared because the state directory belongs to another user.",
      );
      return false;
    }
    if (!(await this.exists(this.directory))) return true;
    await privateDirectory(this.directory);
    return withFileLock(
      join(this.directory, ".commands.lock"),
      "Command history",
      async () => {
        if (!(await this.exists(this.path))) return true;
        if (!(await ownedByCurrentUser(this.path))) return false;
        await unlink(this.path);
        this.fileTrusted = false;
        return true;
      },
    );
  }

  private async appendNow(input: LocalCommandHistoryInput): Promise<void> {
    if (this.getUid() === 0) {
      this.warn(
        "Local command history was not written because homectl is running as root.",
      );
      return;
    }
    try {
      if (!this.directoryReady) {
        if (!(await ownedByCurrentUser(dirname(this.directory)))) {
          this.warn(
            "Local command history was not written because the state directory belongs to another user.",
          );
          return;
        }
        await privateDirectory(this.directory);
        this.directoryReady = true;
      }
      await withFileLock(
        join(this.directory, ".commands.lock"),
        "Command history",
        () => this.appendLocked(input),
      );
    } catch (error) {
      this.directoryReady = false;
      this.fileTrusted = false;
      throw error;
    }
  }

  private async appendLocked(input: LocalCommandHistoryInput): Promise<void> {
    const entries = await this.readFileIfOwned();
    const finishedAt = input.finishedAt ?? this.now();
    const entry: CommandHistoryEntry = {
      id: randomUUID(),
      sequence: (entries.at(-1)?.sequence ?? 0) + 1,
      at: new Date(finishedAt).toISOString(),
      phase: input.phase,
      host: input.host,
      argv: redactCommandHistoryArgv([...input.argv]),
      requester: input.requester ?? "local-operator",
      ...((input.requesterName ?? (!input.requester ? hostname() : undefined))
        ? { requesterName: input.requesterName ?? hostname() }
        : {}),
      ...(input.approver ? { approver: input.approver } : {}),
      operationId: input.operationId ?? randomUUID(),
      ...(input.classification ? { classification: input.classification } : {}),
      policyDecision: input.policyDecision,
      status: input.status,
      ...(input.exitCode === undefined ? {} : { exitCode: input.exitCode }),
      ...(input.phase !== "outcome" || input.startedAt === undefined
        ? {}
        : { durationMs: Math.max(0, finishedAt - input.startedAt) }),
      ...(input.reason ? { reason: input.reason.slice(0, 120) } : {}),
    };
    const cutoff = this.now() - this.maxAgeDays * 24 * 60 * 60 * 1000;
    const eligible = entries.filter((item) => Date.parse(item.at) >= cutoff);
    const retained =
      this.maxEntries <= 1 ? [] : eligible.slice(-(this.maxEntries - 1));
    await this.writeEntries([...retained, entry]);
  }

  private async readFileIfOwned(): Promise<CommandHistoryEntry[]> {
    if (!(await this.exists(this.path))) return [];
    const metadata = await lstat(this.path);
    if (!metadata.isFile() || metadata.isSymbolicLink())
      throw new Error("Command history path is not a regular file");
    if (!this.fileTrusted) {
      if (!(await ownedByCurrentUser(this.path)))
        throw new Error("Command history file belongs to another user");
      await protect(this.path);
    }
    return parseHistory(await readFile(this.path, "utf8")).entries;
  }

  private async writeEntries(entries: CommandHistoryEntry[]): Promise<void> {
    const temp = `${this.path}.${randomUUID()}.tmp`;
    const text = `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`;
    try {
      await writeFile(temp, text, { mode: 0o600, flag: "wx" });
      // On Windows the temp file inherits the private directory's owner-only
      // ACL, which privateDirectory set for this store.
      if (!windows) await protect(temp);
      await atomicReplace(temp, this.path);
      this.fileTrusted = true;
    } catch (error) {
      await unlink(temp).catch(() => undefined);
      throw error;
    }
  }

  private async exists(path: string): Promise<boolean> {
    try {
      await lstat(path);
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw error;
    }
  }
}

const credentialPair = /^([^:\s]+):([^\s]*)$/;
const urlCredentials = /([a-z][a-z0-9+.-]*:\/\/[^\s/:?#@]+):[^\s/@?#]*@/gi;

function redactUrlCredentials(value: string): string {
  return value.replace(urlCredentials, "$1:[REDACTED]@");
}

function redactCredentialPair(value: string): string | undefined {
  const match = credentialPair.exec(value);
  return match ? `${match[1]}:[REDACTED]` : undefined;
}

export function redactCommandHistoryArgv(argv: string[]): string[] {
  const output: string[] = [];
  let redactNext: "value" | "user" | "authorization" | "bearer" | undefined;
  for (const arg of argv) {
    if (redactNext) {
      if (redactNext === "user") {
        output.push(redactCredentialPair(arg) ?? "[REDACTED]");
      } else if (
        redactNext === "authorization" &&
        /^\s*Bearer\s*$/i.test(arg)
      ) {
        output.push(arg);
        redactNext = "bearer";
        continue;
      } else if (/^\s*Bearer\s+/i.test(arg)) {
        output.push(arg.replace(/^(\s*Bearer\s+).+$/i, "$1[REDACTED]"));
      } else if (/^\s*Authorization\s*:/i.test(arg)) {
        output.push(
          arg.replace(/^(\s*Authorization\s*:\s*).+$/i, "$1[REDACTED]"),
        );
      } else {
        output.push("[REDACTED]");
      }
      redactNext = undefined;
      continue;
    }
    const header = arg.match(/^(\s*Authorization\s*:\s*)(.*)$/i);
    if (header) {
      const headerPrefix = header[1] ?? "";
      const headerValue = header[2] ?? "";
      if (!headerValue) {
        output.push(headerPrefix);
        redactNext = "authorization";
      } else if (/^Bearer\s+\S+/i.test(headerValue)) {
        output.push(
          `${headerPrefix}${headerValue.replace(/^(Bearer\s+).+$/i, "$1[REDACTED]")}`,
        );
      } else if (/^Bearer\s*$/i.test(headerValue)) {
        output.push(`${headerPrefix}${headerValue}`);
        redactNext = "bearer";
      } else {
        output.push(`${headerPrefix}[REDACTED]`);
      }
      continue;
    }
    if (/^Bearer\s+\S+/i.test(arg)) {
      output.push(arg.replace(/^(Bearer\s+).+$/i, "$1[REDACTED]"));
      continue;
    }
    if (arg === "Bearer") {
      output.push(arg);
      redactNext = "bearer";
      continue;
    }
    const userAssignment = arg.match(/^(--user|-u)=(.+)$/i);
    if (userAssignment) {
      const option = userAssignment[1] ?? "--user";
      const value = userAssignment[2] ?? "";
      output.push(`${option}=${redactCredentialPair(value) ?? "[REDACTED]"}`);
      continue;
    }
    if (arg === "--user" || arg === "-u") {
      output.push(arg);
      redactNext = "user";
      continue;
    }
    if (arg === "-p") {
      output.push(arg);
      redactNext = "value";
      continue;
    }
    if (/^-p.+/i.test(arg)) {
      output.push(`${arg.slice(0, 2)}[REDACTED]`);
      continue;
    }
    if (/authorization\s*:\s*$/i.test(arg)) {
      output.push(arg);
      redactNext = "authorization";
      continue;
    }
    const urlRedacted = redactUrlCredentials(arg);
    if (urlRedacted !== arg) {
      output.push(urlRedacted);
      continue;
    }
    output.push(arg);
  }
  return redactArgvBroad(output);
}

const stores = new Map<string, CommandHistoryStore>();

function storeFor(inventoryPath: string): CommandHistoryStore {
  const key = resolve(inventoryPath);
  let store = stores.get(key);
  if (!store) {
    store = new CommandHistoryStore(key);
    stores.set(key, store);
  }
  return store;
}

export function recordLocalCommand(input: LocalCommandHistoryInput): void {
  void storeFor(input.inventoryPath).append(input);
}

export function flushLocalCommandHistory(inventoryPath: string): Promise<void> {
  return storeFor(inventoryPath).flush();
}

export function readLocalCommandHistory(
  inventoryPath: string,
): Promise<CommandHistoryEntry[]> {
  return storeFor(inventoryPath).read();
}

export function readLocalCommandHistoryWithIssues(inventoryPath: string) {
  return storeFor(inventoryPath).readWithIssues();
}

export function clearLocalCommandHistory(
  inventoryPath: string,
): Promise<boolean> {
  return storeFor(inventoryPath).clear();
}
