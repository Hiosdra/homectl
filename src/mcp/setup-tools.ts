// MCP tools for setup requests (0.3 acceptance). Each one queues a request that the
// owner approves in Needs you; nothing changes before that. They sit beside
// setup_status and setup_machines in the tool list. No tool takes a password, a
// fingerprint confirmation or a key: the broker refuses those fields by name.
import type { ToolDefinition } from "./tools";

type Schema = Record<string, unknown>;

const object = (properties: Schema, required: string[] = []): Schema => ({
  type: "object",
  additionalProperties: false,
  properties,
  required,
});

const NAME: Schema = {
  type: "string",
  minLength: 1,
  maxLength: 63,
  description:
    "The machine's name in homectl: 1 to 63 lowercase letters, digits or hyphens.",
};
const ADDRESS: Schema = {
  type: "string",
  minLength: 1,
  maxLength: 253,
  description: "The machine's IP address or host name, as the owner gave it.",
};
const PORT: Schema = {
  type: "integer",
  minimum: 1,
  maximum: 65535,
  description: "SSH port. Leave out for 22.",
};
const ACCESS: Schema = {
  type: "string",
  enum: ["observe", "user", "full"],
  description:
    "look only (observe), everyday account (user) or full admin (full). Full admin is the highest level and needs the owner's password.",
};
const NARRATIVE: Schema = {
  type: "string",
  maxLength: 2000,
  description: "Why you are asking, in a sentence. Shown to the owner.",
};

const WAITING =
  "This is a request, not a change: it waits for the owner in Needs you. Tell the owner it is waiting, then poll the operation's status until its state is final. Do not ask for or send any password, fingerprint confirmation or key.";

function request(
  name: string,
  kind: string,
  description: string,
  properties: Schema,
  required: string[],
): ToolDefinition {
  return {
    name,
    description: `${description} ${WAITING}`,
    inputSchema: object({ ...properties, narrative: NARRATIVE }, required),
    readOnly: false,
    untrusted: false,
    run: (port, args) => port.call(`/v1/setup/request/${kind}`, args),
  };
}

export const SETUP_REQUEST_TOOLS: readonly ToolDefinition[] = [
  request(
    "setup_scan",
    "scan",
    "Ask the owner to look at a new address and show the SSH key it presents, so they can compare it with a trusted source. Nothing contacts the address until the owner approves. Looking pins and trusts nothing. An approved scan is what setup_enroll needs for the same address, for 30 minutes.",
    { address: ADDRESS },
    ["address"],
  ),
  request(
    "setup_probe",
    "probe",
    "Ask the owner to let homectl check that a machine in your grant answers. The check is read-only.",
    { name: NAME },
    ["name"],
  ),
  request(
    "setup_create_key",
    "create-key",
    "Ask the owner to create an SSH key for a machine in the broker vault. This never contacts the machine. The owner installs its public half through trusted access before enrolling the machine.",
    { name: NAME },
    ["name"],
  ),
  request(
    "setup_enroll",
    "enroll",
    "Propose adding a new machine: its name, address, login and access level. It needs an approved setup_scan of the same address made within the last 30 minutes; without one the request is refused, so scan first. The owner checks the fingerprint that scan recorded against a trusted source, types it, and confirms with their password. You never supply the fingerprint.",
    {
      name: NAME,
      address: ADDRESS,
      port: PORT,
      user: {
        type: "string",
        minLength: 1,
        maxLength: 32,
        description: "The login name homectl should use on the machine.",
      },
      access: ACCESS,
    },
    ["name", "address", "user", "access"],
  ),
  request(
    "setup_access",
    "access",
    "Propose a new access level for a machine in your grant. The owner approves with their password.",
    { name: NAME, access: ACCESS },
    ["name", "access"],
  ),
  request(
    "setup_preset",
    "preset",
    "Propose a permission setting for AI requests: conservative (ask me first), routine (AI helps with small fixes) or delegated (AI decides more). The owner approves with their password.",
    {
      preset: {
        type: "string",
        enum: ["conservative", "routine", "delegated"],
        description: "The permission setting to propose.",
      },
    },
    ["preset"],
  ),
  request(
    "setup_remove",
    "remove",
    "Propose removing a machine in your grant from homectl. This is destructive: the owner approves with their password. The machine itself is not changed.",
    { name: NAME },
    ["name"],
  ),
  request(
    "setup_ai_helper",
    "ai-helper",
    "Propose the AI helper provider and model. A custom provider also needs its exact base address. The owner reviews the destination and enters any key privately in Needs you on this device. This does not enable Auto Mode or widen reviewer authority.",
    {
      provider: {
        type: "string",
        enum: ["anthropic", "openai", "openrouter", "custom"],
      },
      baseUrl: { type: "string", minLength: 1, maxLength: 500 },
      model: { type: "string", minLength: 1, maxLength: 100 },
    },
    ["provider", "model"],
  ),
  request(
    "setup_approval_wait",
    "approval-wait",
    "Propose how long requests wait for the owner before they expire: 5 minutes to 7 days, for example 90m, 24h or 7d. The owner approves with their password. Requests the owner has not answered in time expire.",
    {
      wait: {
        type: "string",
        minLength: 1,
        maxLength: 8,
        description: "The wait: a number with m, h or d, for example 24h.",
      },
    },
    ["wait"],
  ),
];
