// Argon2 for KDBX databases, wired the same way as src/peer/vault.ts: kdbxweb
// delegates the KDF to hash-wasm. The policy limits match that module.
import { argon2d, argon2id } from "hash-wasm";
import * as kdbx from "kdbxweb";
import { HomectlError } from "../types";
import type { Argon2Params } from "./types";

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

// Validates caller-supplied KDF parameters. Production callers pass nothing and
// keep the kdbxweb defaults; tests pass small values to stay fast.
export function assertArgon2(params: Argon2Params): void {
  const { memory, iterations, parallelism } = params;
  const integer = (value: number) => Number.isSafeInteger(value) && value > 0;
  if (
    !integer(memory) ||
    !integer(iterations) ||
    !integer(parallelism) ||
    memory < 8 * parallelism ||
    parallelism > 64 ||
    memory > 1024 * 1024
  )
    throw new HomectlError(2, "Invalid Argon2 parameters");
}
