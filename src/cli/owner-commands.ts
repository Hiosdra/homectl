// `home-ctl owner …`: first-run owner setup (password and the Auto Mode
// reviewer authority, homelab #21 A1), host grants through the broker, and
// Auto Mode settings. Moved here from broker-commands.ts to keep that file
// under the length limit.
import { join } from "node:path";
import { createInterface } from "node:readline/promises";
import { defaultPolicy, savePolicy } from "../authz";
import { AUTHORITIES, MODES } from "../broker/auto-mode";
import { callBroker } from "../broker/client";
import { ownerHostCommand } from "../broker/host-permissions";
import type { Endpoint } from "../broker/paths";
import { compatPaths } from "../broker/paths";
import type { ReviewerAuthority } from "../core/contracts";
import { readPassword } from "../session";
import { HomectlError } from "../types";

type Emit = (value: unknown, human?: string) => void;
type Flags = Record<string, string | boolean | undefined>;
type Auth = { endpoint: Endpoint; authorization: string; password: string };

const AUTO_MODE_USAGE =
  "Usage: home-ctl owner auto-mode [get] | owner auto-mode set [--mode manual|rules|auto] [--authority recommend|routine|delegated] [--endpoint <https-url>|none] [--model <name>] | owner auto-mode set-key (asks for the key privately)";

// A flag value that must be one of the choices; anything else is a usage error.
function oneChoice<T extends string>(
  value: string | boolean | undefined,
  choices: readonly T[],
): T {
  if (typeof value !== "string" || !choices.includes(value as T))
    throw new HomectlError(2, AUTO_MODE_USAGE);
  return value as T;
}

export interface OwnerCommandContext {
  inventoryPath: string;
  flags: Flags;
  argv: string[];
  emit: Emit;
  auth: () => Promise<Auth>;
}

const AUTHORITY_HELP = [
  "Auto Mode reviewer authority (used only once Auto Mode and a reviewer endpoint are set):",
  "  recommend  the reviewer only recommends; you decide every request (default, least privilege)",
  "  routine    the reviewer may allow routine R1-R2 requests that a rule does not cover",
  "  delegated  wider: the reviewer may allow any R2-or-lower request; R3, R4 and human-only actions always need you",
];

export type AskLine = (question: string) => Promise<string>;

// The terminal question, or null when stdin is not a terminal.
export function terminalAsk(): AskLine | null {
  if (!process.stdin.isTTY) return null;
  return (question) =>
    readTerminalLine(process.stdin, process.stderr, question);
}

// One answer from a terminal. End of input (Ctrl-D) answers "" like Enter, so
// the least-privilege default is kept. Without this the question never settles
// at end of input and the command blocks. A pipe into `script` does not close
// the terminal, so scripted callers must still answer every question.
export function readTerminalLine(
  input: NodeJS.ReadableStream,
  output: NodeJS.WritableStream,
  question: string,
): Promise<string> {
  const rl = createInterface({ input, output });
  return new Promise<string>((resolve, reject) => {
    rl.once("close", () => resolve(""));
    rl.question(question).then(resolve, reject);
  }).finally(() => rl.close());
}

// Asks during `owner init`. Enter keeps the least-privilege default. With no
// terminal (ask === null) the default is kept, so scripted setup never widens
// authority.
export async function chooseReviewerAuthority(
  ask: AskLine | null = terminalAsk(),
): Promise<ReviewerAuthority> {
  if (ask === null) return "recommend";
  console.error(AUTHORITY_HELP.join("\n"));
  for (let attempt = 0; attempt < 3; attempt++) {
    const answer = (await ask("Reviewer authority [recommend]: "))
      .trim()
      .toLowerCase();
    if (answer === "") return "recommend";
    const match = AUTHORITIES.find((authority) => authority === answer);
    if (match) return match;
    console.error("Choose recommend, routine or delegated.");
  }
  // The password is already saved, so this is a notice, not a failure.
  console.error(
    "No reviewer authority chosen; it stays recommend. Change it with `home-ctl owner auto-mode set --authority <value>`.",
  );
  return "recommend";
}

// Stores a wider reviewer authority in the state directory's policy.json. The
// default policy already has recommend, so nothing is written for it. Returns
// true when a policy file was written, so the caller can fix its ownership.
export async function saveReviewerAuthority(
  state: string,
  authority: ReviewerAuthority,
): Promise<boolean> {
  if (authority === "recommend") return false;
  const base = defaultPolicy("conservative");
  await savePolicy(join(state, "policy.json"), {
    ...base,
    reviewer: { ...base.reviewer, authority },
  });
  return true;
}

async function initOwner(ctx: OwnerCommandContext): Promise<number> {
  const mode = ctx.flags.mode ?? "compat";
  if (mode !== "compat")
    throw new HomectlError(
      2,
      "The hardened service sets the owner password during `home-ctl daemon install`",
    );
  const { vaultPathFor } = await import("../broker/vault-wiring");
  if (await Bun.file(await vaultPathFor(ctx.inventoryPath, "compat")).exists())
    throw new HomectlError(
      3,
      "This workspace has a homelab vault: its master password is the owner password, so there is nothing to set",
    );
  const { FileVerifier } = await import("../broker/owner");
  const state = compatPaths(ctx.inventoryPath).state;
  const verifier = new FileVerifier(join(state, "owner.json"));
  if (await verifier.exists())
    throw new HomectlError(3, "An owner password is already set");
  const first = await readPassword("New homectl owner password: ");
  const second = await readPassword("Repeat it: ");
  if (first !== second) throw new HomectlError(2, "The passwords do not match");
  const { privateDirectory } = await import("../platform");
  await privateDirectory(state);
  await verifier.set(first);
  // A fresh install keeps no policy file while the authority stays recommend.
  const authority = await chooseReviewerAuthority();
  await saveReviewerAuthority(state, authority);
  ctx.emit(
    { owner: "set", reviewerAuthority: authority },
    `Owner password set. Reviewer authority: ${authority}.`,
  );
  return 0;
}

// `owner auto-mode [get]` or `owner auto-mode set [--mode …] [--authority …]
// [--endpoint <https-url>|none] [--model <name>]`. Changes that widen the
// reviewer authority, turn Auto Mode on or use a new endpoint are confirmed
// with the owner password, which every call sends.
async function autoModeCommand(
  args: string[],
  ctx: OwnerCommandContext,
): Promise<number> {
  const [sub = "get"] = args;
  const { flags } = ctx;
  // Usage errors are reported before the owner password is asked for.
  if (sub !== "get" && sub !== "set" && sub !== "set-key")
    throw new HomectlError(2, AUTO_MODE_USAGE);
  if (sub === "get" && args.length > 1)
    throw new HomectlError(2, AUTO_MODE_USAGE);
  if (sub === "set-key") {
    if (args.length > 1) throw new HomectlError(2, AUTO_MODE_USAGE);
    // The key is never an argument, so it stays out of shell history and process
    // lists. The owner password and the key are both typed at a private prompt.
    const auth = await ctx.auth();
    const apiKey = await readPassword("AI helper API key (typed privately): ");
    ctx.emit(
      await callBroker(
        "/v1/owner/ai-helper/set-key",
        { apiKey, password: auth.password },
        auth,
      ),
      "The AI helper key is saved in the encrypted vault.",
    );
    return 0;
  }
  const changes: Record<string, unknown> = {};
  if (sub === "set") {
    if (args.length > 1) throw new HomectlError(2, AUTO_MODE_USAGE);
    if (flags.mode !== undefined) changes.mode = oneChoice(flags.mode, MODES);
    if (flags.authority !== undefined)
      changes.authority = oneChoice(flags.authority, AUTHORITIES);
    if (flags.endpoint !== undefined)
      changes.endpoint = flags.endpoint === "none" ? null : flags.endpoint;
    if (flags.model !== undefined) changes.model = flags.model;
    if (Object.keys(changes).length === 0)
      throw new HomectlError(2, AUTO_MODE_USAGE);
  }
  const auth = await ctx.auth();
  if (sub === "get") {
    ctx.emit(await callBroker("/v1/owner/auto-mode/get", {}, auth));
    return 0;
  }
  const body = { ...changes, password: auth.password };
  ctx.emit(
    await callBroker("/v1/owner/auto-mode/set", body, auth),
    "Auto Mode settings saved.",
  );
  return 0;
}

export async function ownerCommand(
  positionals: string[],
  ctx: OwnerCommandContext,
): Promise<number> {
  const [action] = positionals;
  const hostCall = ctx.argv.length === 0 && ownerHostCommand(positionals);
  if (hostCall) {
    const auth = await ctx.auth();
    const body = { ...hostCall.body, password: auth.password };
    ctx.emit(await callBroker(hostCall.route, body, auth));
    return 0;
  }
  if (action === "auto-mode") return autoModeCommand(positionals.slice(1), ctx);
  if (action !== "init")
    throw new HomectlError(
      2,
      "Usage: home-ctl owner init | auto-mode [get|set …] | scan-host-keys <host> | pin-host-key <host> <SHA256:…> | inspect-host <host> | preview-host-grant <host> | apply-host-grant <host> <fingerprint> | revoke-host-grant <host> | repair-host-grant <host> [fingerprint]",
    );
  return initOwner(ctx);
}
