import { createPrivateKey, randomUUID } from "node:crypto";
import { copyFile, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { argon2d, argon2id } from "hash-wasm";
import * as kdbx from "kdbxweb";
import { privateDirectory, protect } from "../platform";
import { decodeKey, publicBlob } from "../session/agent";
import { HomectlError } from "../types";
import { hash } from "./sync";
export type Credential = {
  title: string;
  fields: Record<string, string>;
  attachments: Record<string, string>;
};
kdbx.CryptoEngine.setArgon2Impl(
  async (
    password,
    salt,
    memory,
    iterations,
    length,
    parallelism,
    type,
    version,
  ) => {
    if (
      version !== 0x13 ||
      memory > 1024 * 1024 ||
      iterations > 100 ||
      parallelism > 64
    )
      throw new HomectlError(2, "Unsupported or excessive KDBX KDF parameters");
    const result = await (type === 0 ? argon2d : argon2id)({
      password: new Uint8Array(password),
      salt: new Uint8Array(salt),
      memorySize: memory,
      iterations,
      hashLength: length,
      parallelism,
      outputType: "binary",
    });
    return Uint8Array.from(result).buffer;
  },
);
function text(value: string | kdbx.ProtectedValue | undefined) {
  return typeof value === "string" ? value : (value?.getText() ?? "");
}
function entries(db: kdbx.Kdbx) {
  return db.groups
    .flatMap((g) => [...g.allEntries()])
    .filter(
      (e) =>
        text(e.fields.get("Title")).startsWith("homectl-") &&
        e.parentGroup?.uuid.id !== db.meta.recycleBinUuid?.id,
    );
}
export class Vault {
  private db?: kdbx.Kdbx;
  private fingerprint = "";
  constructor(readonly path: string) {}
  get unlocked() {
    return Boolean(this.db);
  }
  lock() {
    this.db = undefined;
  }
  async unlock(password: string, create = false) {
    try {
      let bytes: Buffer | undefined;
      try {
        bytes = await readFile(this.path);
      } catch (e) {
        if (!create || (e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
      }
      const credentials = new kdbx.Credentials(
        kdbx.ProtectedValue.fromString(password),
      );
      this.db = bytes
        ? await kdbx.Kdbx.load(Uint8Array.from(bytes).buffer, credentials)
        : kdbx.Kdbx.create(credentials, "homectl");
      this.fingerprint = bytes ? hash(bytes.toString("base64")) : "missing";
      if (!bytes) await this.save();
    } catch {
      this.lock();
      throw new HomectlError(
        5,
        "Vault unlock failed; password or database unavailable. Details suppressed.",
      );
    }
  }
  snapshot(): Record<string, Credential> {
    if (!this.db)
      throw new HomectlError(
        5,
        "Unlock the local vault before syncing credentials",
      );
    const result: Record<string, Credential> = {};
    for (const entry of entries(this.db)) {
      const title = text(entry.fields.get("Title"));
      if (result[title])
        throw new HomectlError(
          2,
          "Duplicate homectl credential titles; resolve in KeePassXC first",
        );
      const fields = Object.fromEntries(
        [...entry.fields].map(([k, v]) => [k, text(v)]),
      );
      const attachments: Record<string, string> = {};
      for (const [name, bin] of entry.binaries) {
        const v = kdbx.KdbxBinaries.isKdbxBinaryWithHash(bin) ? bin.value : bin;
        attachments[name] = Buffer.from(
          v instanceof kdbx.ProtectedValue ? v.getBinary() : new Uint8Array(v),
        ).toString("base64");
      }
      result[title] = { title, fields, attachments };
    }
    return result;
  }
  async apply(values: Record<string, Credential>) {
    const db = this.db;
    if (!db) throw new HomectlError(5, "Unlock the local vault first");
    const old = new Map(
      entries(db).map((e) => [text(e.fields.get("Title")), e]),
    );
    for (const title of old.keys())
      if (!(title in values)) {
        const e = old.get(title);
        if (e) db.remove(e);
      }
    for (const [title, value] of Object.entries(values)) {
      if (
        !/^homectl-[a-z][a-z0-9-]{0,62}$/.test(title) ||
        !value.fields ||
        !value.attachments ||
        value.title !== title
      )
        throw new HomectlError(2, "Invalid credential record");
      const e = old.get(title) ?? db.createEntry(db.getDefaultGroup());
      e.pushHistory();
      e.fields.clear();
      for (const [name, v] of Object.entries(value.fields)) {
        if (typeof v !== "string")
          throw new HomectlError(2, "Invalid credential field");
        e.fields.set(name, kdbx.ProtectedValue.fromString(v));
      }
      e.fields.set("Title", title);
      e.binaries.clear();
      for (const [name, v] of Object.entries(value.attachments)) {
        if (typeof v !== "string" || v.length > 1024 * 1024)
          throw new HomectlError(2, "Invalid credential attachment");
        e.binaries.set(
          name,
          await db.createBinary(
            Uint8Array.from(Buffer.from(v, "base64")).buffer,
          ),
        );
      }
      e.times.update();
    }
    await this.save();
  }
  async save() {
    if (!this.db) throw new HomectlError(5, "Vault is locked");
    await privateDirectory(dirname(this.path));
    let current = "missing";
    try {
      current = hash((await readFile(this.path)).toString("base64"));
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    }
    if (current !== this.fingerprint) {
      this.lock();
      throw new HomectlError(
        3,
        "Database changed outside homectl; reopen before syncing",
      );
    }
    const bytes = Buffer.from(await this.db.save());
    if (current !== "missing") {
      const backup = `${this.path}.before-sync-${Date.now()}`;
      await copyFile(this.path, backup);
      await protect(backup);
    }
    const tmp = `${this.path}.${randomUUID()}.tmp`;
    await writeFile(tmp, bytes, { mode: 0o600, flag: "wx" });
    await protect(tmp);
    await rename(tmp, this.path);
    this.fingerprint = hash(bytes.toString("base64"));
    bytes.fill(0);
  }
}
export function credentialPublicKey(credential: Credential) {
  const bytes = Buffer.from(credential.attachments.id_ed25519 ?? "", "base64");
  try {
    const key = bytes.toString().includes("BEGIN ENCRYPTED PRIVATE KEY")
      ? createPrivateKey({
          key: bytes,
          passphrase: credential.fields.Password ?? "",
        })
      : decodeKey(bytes);
    return `ssh-ed25519 ${publicBlob(key).toString("base64")}\n`;
  } finally {
    bytes.fill(0);
  }
}
