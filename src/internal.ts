// Internal roles that homectl starts as child processes: the credential worker and
// the session daemon. They run as `homectl __internal <role>`, so the same
// program works from a source checkout (`bun src/cli/main.ts`) and from a single
// compiled executable (`bun build --compile`), where no .ts file exists on disk.
import { resolve } from "node:path";

export type InternalRole = "worker" | "session-daemon";

// Inside a compiled executable, modules live in an embedded file system: `$bunfs`
// on POSIX, `B:/~BUN` on Windows. There, process.execPath is the program itself.
export const bundled =
  import.meta.path.includes("$bunfs") || import.meta.path.includes("~BUN");

// The argv that starts this program for one internal role.
export function internalCommand(role: InternalRole): string[] {
  const self = bundled
    ? [process.execPath]
    : [process.execPath, resolve(import.meta.dir, "cli", "main.ts")];
  return [...self, "__internal", role];
}

// The argv that starts this program for a normal command, used by launchers and
// service units. A compiled executable needs no entry script.
export function selfCommand(): string[] {
  return bundled
    ? [process.execPath]
    : [process.execPath, resolve(import.meta.dir, "cli", "main.ts")];
}
