// Single-use ledger for approval nonces. consume() is atomic across processes
// (file lock + atomic replace): the first caller wins, every later caller with
// the same nonce is refused. Expired entries are pruned; a nonce cannot be
// replayed after pruning because its grant has expired too.
import { randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { ensurePrivateDirectoryOnce, withFileLock } from "../control/file-lock";
import { atomicReplace } from "../platform";
import { HomectlError } from "../types";

interface LedgerFile {
  version: 1;
  // nonce -> expiresAt (epoch ms)
  consumed: Record<string, number>;
}

export class NonceLedger {
  private readonly path: string;
  private readonly lock: string;

  constructor(
    private readonly directory: string,
    private readonly now: () => number = Date.now,
  ) {
    this.path = join(directory, "consumed-approvals.json");
    this.lock = join(directory, ".consumed-approvals.lock");
  }

  private async load(): Promise<LedgerFile> {
    try {
      const data = JSON.parse(await readFile(this.path, "utf8")) as LedgerFile;
      if (data.version !== 1 || typeof data.consumed !== "object")
        throw new Error("shape");
      return data;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT")
        return { version: 1, consumed: {} };
      throw new HomectlError(
        5,
        "Approval ledger is corrupt; refusing to dispatch approved work",
      );
    }
  }

  // Returns true exactly once per nonce.
  async consume(nonce: string, expiresAt: number): Promise<boolean> {
    await ensurePrivateDirectoryOnce(this.directory);
    return withFileLock(this.lock, "Approval ledger", async () => {
      const data = await this.load();
      if (data.consumed[nonce] !== undefined) return false;
      const now = this.now();
      for (const [key, until] of Object.entries(data.consumed))
        if (until < now) delete data.consumed[key];
      data.consumed[nonce] = expiresAt;
      const temp = `${this.path}.${randomUUID()}.tmp`;
      await writeFile(temp, JSON.stringify(data), { mode: 0o600, flag: "wx" });
      await atomicReplace(temp, this.path);
      return true;
    });
  }

  async isConsumed(nonce: string): Promise<boolean> {
    return (await this.load()).consumed[nonce] !== undefined;
  }
}
