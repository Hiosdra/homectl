// In-memory remote host for hostperm tests: files with mode/owner/symlink,
// users, sudo availability and a visudo that rejects content containing
// "INVALID". No network, no SSH, no shell: argv is interpreted directly.
import { createHash } from "node:crypto";
import type { RemoteExec } from "../src/hostperm";
import type { ProcessResult } from "../src/types";

export interface FakeFile {
  content: string;
  mode: string;
  owner: string;
  group: string;
  link?: string;
}

export interface FakeLogEntry {
  argv: string[];
  stdin?: string;
}

const SUDOERS_D = "/etc/sudoers.d";
const SUDOERS = "/etc/sudoers";

function result(exitCode: number, stdout = "", stderr = ""): ProcessResult {
  return { exitCode, stdout, stderr };
}

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

function parentOf(path: string): string {
  const index = path.lastIndexOf("/");
  return index <= 0 ? "/" : path.slice(0, index);
}

// Destinations a command would modify. Used to audit writes in tests.
export function writeTargets(argv: string[]): string[] {
  const cmd = argv[0] === "sudo" ? argv.slice(2) : argv;
  const [name, ...args] = cmd;
  switch (name) {
    case "install":
      return [args[args.length - 1] ?? ""];
    case "cp":
    case "mv":
      return [args[args.length - 1] ?? "", args[args.length - 2] ?? ""];
    case "rm":
      return args.filter((arg) => arg.startsWith("/"));
    case "useradd":
      return ["/etc/passwd"];
    default:
      return [];
  }
}

export class FakeHost {
  readonly files = new Map<string, FakeFile>();
  readonly dirs = new Set<string>([
    "/",
    "/etc",
    SUDOERS_D,
    "/home",
    "/home/oskar",
    "/home/oskar/.ssh",
  ]);
  readonly users = new Set<string>(["oskar"]);
  readonly executables = new Set<string>([
    "/usr/sbin/visudo",
    "/usr/sbin/useradd",
  ]);
  readonly log: FakeLogEntry[] = [];
  osRelease: string | undefined = 'NAME="Debian"\nID=debian\nVERSION_ID="12"\n';
  uname = "Linux x86_64";
  uid = "1000";
  sudoWorks = true;
  sudoersInclude = true;
  readOnlyEtc = false;
  // Hook for injected failures: return true to fail the command.
  failIf: ((argv: string[], stdin?: string) => boolean) | undefined;

  constructor() {
    this.files.set(SUDOERS, {
      content: "root ALL=(ALL:ALL) ALL\n#includedir /etc/sudoers.d\n",
      mode: "0440",
      owner: "root",
      group: "root",
    });
  }

  // Read-only view of the remote state, for assertions.
  text(path: string): string | undefined {
    return this.files.get(path)?.content;
  }

  put(path: string, content: string, meta: Partial<FakeFile> = {}): void {
    this.files.set(path, {
      content,
      mode: meta.mode ?? "0644",
      owner: meta.owner ?? "root",
      group: meta.group ?? "root",
      link: meta.link,
    });
  }

  readonly exec: RemoteExec = (argv, opts) => this.run(argv, opts?.stdin);

  // Commands that are not implemented return 127, which fails every test that
  // expects a specific outcome.
  private run(argv: string[], stdin?: string): Promise<ProcessResult> {
    this.log.push({ argv: [...argv], stdin });
    if (this.failIf?.(argv, stdin))
      return Promise.resolve(result(1, "", "injected failure"));
    return Promise.resolve(this.dispatch(argv, stdin));
  }

  private dispatch(argv: string[], stdin?: string): ProcessResult {
    let asRoot = false;
    let cmd = argv;
    if (argv[0] === "sudo") {
      if (argv[1] !== "-n") return result(1, "", "unsupported sudo options");
      if (!this.sudoWorks) return result(1, "", "a password is required");
      asRoot = true;
      cmd = argv.slice(2);
    }
    const [name, ...args] = cmd;
    switch (name) {
      case "true":
        return result(0);
      case "uname":
        return result(0, `${this.uname}\n`);
      case "id":
        return this.id(args);
      case "cat":
        return this.cat(args[0] ?? "", asRoot);
      case "test":
        return this.test(args, asRoot);
      case "grep":
        return result(this.sudoersInclude ? 0 : 1);
      case "install":
        return this.install(args, asRoot, stdin);
      case "cp":
        return this.copy(args, asRoot);
      case "mv":
        return this.move(args, asRoot);
      case "rm":
        return this.remove(args, asRoot);
      case "visudo":
        return this.visudo(args);
      case "sha256sum":
        return this.hash(args[0] ?? "");
      case "useradd":
        return this.useradd(args, asRoot);
      case "-l":
        return this.listUser(args[1] ?? "", asRoot);
      default:
        return result(127, "", "command not found");
    }
  }

  private id(args: string[]): ProcessResult {
    if (args[0] === "-u") return result(0, `${this.uid}\n`);
    if (args[0] === "-gn" && args[1] !== undefined && this.users.has(args[1]))
      return result(0, `${args[1]}\n`);
    return result(1);
  }

  private cat(path: string, asRoot: boolean): ProcessResult {
    if (path === "/etc/os-release")
      return this.osRelease === undefined
        ? result(1)
        : result(0, this.osRelease);
    if (path.startsWith("/etc/") && !asRoot)
      return result(1, "", "Permission denied");
    const file = this.resolve(path);
    if (!file) return result(1, "", "No such file");
    return result(0, file.content);
  }

  private test(args: string[], asRoot: boolean): ProcessResult {
    const [flag, path = ""] = args;
    const ok = (value: boolean): ProcessResult => result(value ? 0 : 1);
    switch (flag) {
      case "-x":
        return ok(this.executables.has(path));
      case "-d":
        return ok(this.dirs.has(path));
      case "-e":
        return ok(this.files.has(path) || this.dirs.has(path));
      case "-L":
        return ok(this.files.get(path)?.link !== undefined);
      case "-w":
        return ok(asRoot && !this.readOnlyEtc);
      default:
        return result(2, "", "unsupported test");
    }
  }

  private resolve(path: string): FakeFile | undefined {
    const file = this.files.get(path);
    if (file?.link !== undefined) return this.files.get(file.link);
    return file;
  }

  private install(
    args: string[],
    asRoot: boolean,
    stdin?: string,
  ): ProcessResult {
    if (args[0] === "-d") {
      const dir = args[args.length - 1] ?? "";
      if (!asRoot && dir.startsWith("/etc/"))
        return result(1, "", "Permission denied");
      this.dirs.add(dir);
      return result(0);
    }
    const mode = args[1] ?? "";
    const owner = args[3] ?? "";
    const group = args[5] ?? "";
    const dest = args[args.length - 1] ?? "";
    const source = args[args.length - 2] ?? "";
    if (source !== "/dev/stdin")
      return result(1, "", "unsupported install source");
    if (dest.startsWith("/etc/") && !asRoot)
      return result(1, "", "Permission denied");
    if (!this.dirs.has(parentOf(dest)))
      return result(1, "", "No such directory");
    if (this.files.get(dest)?.link !== undefined)
      return result(1, "", "refusing symlink");
    this.put(dest, stdin ?? "", { mode, owner, group });
    return result(0);
  }

  private copy(args: string[], asRoot: boolean): ProcessResult {
    const [, src = "", dst = ""] = args;
    const file = this.files.get(src);
    if (!file) return result(1, "", "No such file");
    if (dst.startsWith("/etc/") && !asRoot)
      return result(1, "", "Permission denied");
    this.files.set(dst, { ...file, link: undefined });
    return result(0);
  }

  private move(args: string[], asRoot: boolean): ProcessResult {
    const [, src = "", dst = ""] = args;
    const file = this.files.get(src);
    if (!file) return result(1, "", "No such file");
    if (dst.startsWith("/etc/") && !asRoot)
      return result(1, "", "Permission denied");
    if (!this.dirs.has(parentOf(dst)))
      return result(1, "", "No such directory");
    this.files.delete(src);
    this.files.set(dst, file);
    return result(0);
  }

  private remove(args: string[], asRoot: boolean): ProcessResult {
    const paths = args.filter((arg) => arg !== "-f");
    for (const path of paths) {
      if (path.startsWith("/etc/") && !asRoot)
        return result(1, "", "Permission denied");
      this.files.delete(path);
    }
    return result(0);
  }

  // Checks files the way visudo -c does: -cf FILE checks one file, -c checks
  // /etc/sudoers and every includedir entry that sudo would load.
  private visudo(args: string[]): ProcessResult {
    if (args[0] === "-cf") {
      const file = this.files.get(args[1] ?? "");
      if (!file) return result(1, "", "no such file");
      return result(file.content.includes("INVALID") ? 1 : 0);
    }
    if (args[0] !== "-c") return result(2, "", "unsupported visudo option");
    for (const [path, file] of this.files) {
      if (!this.loadedBySudo(path)) continue;
      if (file.content.includes("INVALID"))
        return result(1, "", `${path}: syntax error`);
    }
    return result(0);
  }

  // sudo loads /etc/sudoers and files in /etc/sudoers.d whose names contain no dot.
  private loadedBySudo(path: string): boolean {
    if (path === SUDOERS) return true;
    if (parentOf(path) !== SUDOERS_D) return false;
    const name = path.slice(SUDOERS_D.length + 1);
    return this.sudoersInclude && !name.includes(".") && !name.endsWith("~");
  }

  private hash(path: string): ProcessResult {
    const file = this.resolve(path);
    if (!file) return result(1, "", "No such file");
    return result(0, `${sha256(file.content)}  ${path}\n`);
  }

  private useradd(args: string[], asRoot: boolean): ProcessResult {
    const user = args[args.length - 1] ?? "";
    if (!this.executables.has("/usr/sbin/useradd")) return result(127);
    if (!asRoot) return result(1, "", "a password is required");
    if (this.users.has(user)) return result(9, "", "user exists");
    this.users.add(user);
    return result(0);
  }

  // sudo -n -l -U USER succeeds only when sudo loads a rule for the user.
  private listUser(user: string, asRoot: boolean): ProcessResult {
    if (!asRoot) return result(1);
    const granted = [...this.files].some(
      ([path, file]) =>
        this.loadedBySudo(path) &&
        file.content.split("\n").some((line) => line.startsWith(`${user} `)),
    );
    return granted
      ? result(0, `User ${user} may run the following commands\n`)
      : result(1);
  }
}
