// The guided part of `home-ctl setup`, for interactive terminals only: create the
// vault and its password (explained once), print a summary, then ask whether to
// start homectl. The prompts are injected, so tests script them.
import { VAULT_PASSWORD_MIN } from "./session/database";
import { HomectlError } from "./types";

export const VAULT_EXPLANATION = [
  "Your vault is one encrypted file. It keeps the keys to your machines.",
  "Its password is also your owner password: it opens the vault and signs you in to the panel.",
  "Nothing in the vault can be recovered without it, so write it down somewhere safe.",
].join("\n");

const MAX_ATTEMPTS = 5;

export interface GuidedDeps {
  say(line: string): void;
  ask(question: string): Promise<string>;
  askSecret(prompt: string): Promise<string>;
  vaultExists(): Promise<boolean>;
  vaultPath: string;
  createVault(password: string): Promise<unknown>;
  // Resolves when homectl stops (Ctrl+C). Returns the process exit code.
  start(): Promise<number>;
}

export interface GuidedResult {
  vault: "created" | "existing";
  started: boolean;
}

// Asks for the vault password twice. Too short or mismatched answers ask again;
// after MAX_ATTEMPTS the flow stops rather than looping forever.
export async function chooseVaultPassword(
  deps: Pick<GuidedDeps, "say" | "askSecret">,
): Promise<string> {
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
    const first = await deps.askSecret(
      `Choose a vault password (at least ${VAULT_PASSWORD_MIN} characters): `,
    );
    if (first.length < VAULT_PASSWORD_MIN) {
      deps.say(`Use at least ${VAULT_PASSWORD_MIN} characters.`);
      continue;
    }
    const second = await deps.askSecret("Repeat the vault password: ");
    if (first !== second) {
      deps.say("The two passwords differ. Try again.");
      continue;
    }
    return first;
  }
  throw new HomectlError(
    2,
    "No vault password was set. Run home-ctl setup again when you are ready.",
  );
}

// Whether a typed answer means yes. An empty answer is yes: the prompt says [Y/n].
export function isYes(answer: string): boolean {
  return /^(|y|yes)$/i.test(answer.trim());
}

export async function guidedSetup(deps: GuidedDeps): Promise<GuidedResult> {
  deps.say("2/4 Vault");
  let vault: GuidedResult["vault"];
  if (await deps.vaultExists()) {
    vault = "existing";
    deps.say(
      "Your vault already exists. Sign in to the panel with your owner password, which is the vault password.",
    );
  } else {
    deps.say(VAULT_EXPLANATION);
    const password = await chooseVaultPassword(deps);
    await deps.createVault(password);
    vault = "created";
    deps.say(`Vault created: ${deps.vaultPath}`);
  }
  deps.say("");
  deps.say("3/4 Summary");
  deps.say(
    `Vault: ${vault === "created" ? "created now" : "already there"} (${deps.vaultPath})`,
  );
  deps.say(
    "Owner password: the vault password. Signing in also opens the vault.",
  );
  deps.say(
    "Next: the panel opens in your browser. Add a machine and connect an assistant there.",
  );
  deps.say("");
  deps.say("4/4 Start");
  const answer = await deps.ask("Start homectl now? [Y/n]: ");
  if (!isYes(answer)) {
    deps.say("Not started. Run home-ctl start when you want the panel.");
    return { vault, started: false };
  }
  await deps.start();
  return { vault, started: true };
}
