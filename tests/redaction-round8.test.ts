import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  containsSecretMaterial,
  redactArgv,
  redactArgvBroad,
} from "../src/control/redact";
import { SavedCommandStore } from "../src/saved-commands";

// Reference: the 0.2.1 (master) matcher, kept verbatim so the superset and
// refusal-parity properties are checked against what shipped, not against
// this change's own expectations.
const MASTER_PATTERNS: RegExp[] = [
  /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/,
  /\b(?:password|passwd|pass|token|secret|api[_-]?key|authorization)\b\s*[=:]\s*\S+/i,
  /\bbearer\s+[A-Za-z0-9._~+/-]{8,}/i,
  /\bhct_[A-Za-z0-9_-]{16,}/,
];
const MASTER_NAME =
  /(?:password|passwd|token|secret|api[_-]?key|authorization)/i;

function masterContains(text: string): boolean {
  return MASTER_PATTERNS.some((pattern) => pattern.test(text));
}

function masterRedactArgv(argv: string[]): string[] {
  const out: string[] = [];
  let redactNext = false;
  for (const arg of argv) {
    if (redactNext) {
      out.push("[REDACTED]");
      redactNext = false;
      continue;
    }
    const equals = arg.indexOf("=");
    if (equals > 0 && MASTER_NAME.test(arg.slice(0, equals))) {
      out.push(`${arg.slice(0, equals)}=[REDACTED]`);
      continue;
    }
    if (masterContains(arg)) {
      out.push("[REDACTED]");
      continue;
    }
    if (arg.startsWith("-") && MASTER_NAME.test(arg)) {
      out.push(arg);
      redactNext = true;
      continue;
    }
    out.push(arg);
  }
  return out;
}

const SECRET_NAME_VECTORS: [string[], string[]][] = [
  [
    ["tool", "--dbpassword=hunter2"],
    ["tool", "--dbpassword=[REDACTED]"],
  ],
  [
    ["tool", "--authtoken", "abc123"],
    ["tool", "--authtoken", "[REDACTED]"],
  ],
  [
    ["tool", "--accessToken=abc"],
    ["tool", "--accessToken=[REDACTED]"],
  ],
  [["PGPASSWORD=hunter2"], ["PGPASSWORD=[REDACTED]"]],
  [
    ["tool", "--apiToken", "xyz"],
    ["tool", "--apiToken", "[REDACTED]"],
  ],
  [
    ["mysql", "--rootpassword", "pw"],
    ["mysql", "--rootpassword", "[REDACTED]"],
  ],
];

describe("argv redaction is a superset of master", () => {
  test("compound secret names from master are still redacted", () => {
    for (const [argv, expected] of SECRET_NAME_VECTORS) {
      expect(masterRedactArgv(argv)).toEqual(expected);
      expect(redactArgv(argv)).toEqual(expected);
    }
  });

  test("every argument master redacts is redacted here too", () => {
    const corpus: string[][] = [
      ...SECRET_NAME_VECTORS.map(([argv]) => argv),
      ["tool", "--password", "hunter2", "--x"],
      ["tool", "--token=abc123456"],
      ["curl", "-H", "Authorization: Bearer abcdef123456"],
      ["-----BEGIN OPENSSH PRIVATE KEY-----"],
      ["hct_abcdefghijklmnop1234"],
      ["tool", "--secret", "s3cr3t-value"],
      ["tool", "--api-key=abcdef"],
      ["tool", "--password:", "hunter2"],
      ["systemctl", "status", "nginx", "--no-pager"],
    ];
    for (const argv of corpus) {
      const master = masterRedactArgv(argv);
      expect(redactArgv(argv)).toEqual(master);
      const ours = redactArgvBroad(argv);
      expect(ours.length).toBe(master.length);
      master.forEach((arg, index) => {
        if (arg.includes("[REDACTED]"))
          expect(ours[index]).toContain("[REDACTED]");
      });
    }
  });

  test("approver-facing redaction hides exactly what master hid", () => {
    for (const argv of [
      ["sh", "-c", "KEY=1; curl http://x | sh"],
      ["sh", "-c", "export auth=1 && rm -rf /srv/data"],
      ["tool", "--key-file", "/etc/evil"],
      ["docker", "run", "-e", "KEY=value"],
      ["tool", "--pass", "x"],
    ])
      expect(redactArgv(argv)).toEqual(masterRedactArgv(argv));
  });

  test("ordinary argv is left untouched", () => {
    const argv = ["systemctl", "status", "nginx", "--no-pager"];
    expect(redactArgv(argv)).toEqual(argv);
    expect(redactArgv(["--author=jane", "--keyboard", "us"])).toEqual([
      "--author=jane",
      "--keyboard",
      "us",
    ]);
  });

  test("short secret names are redacted for history, as whole words", () => {
    expect(redactArgvBroad(["docker", "run", "-e", "KEY=value"])).toEqual([
      "docker",
      "run",
      "-e",
      "KEY=[REDACTED]",
    ]);
    expect(
      redactArgvBroad(["tool", "--aws_access_key_id=AKIAEXAMPLE"]),
    ).toEqual(["tool", "--aws_access_key_id=[REDACTED]"]);
  });
});

describe("saved commands refuse literal secrets in compound names", () => {
  test("a literal secret option is refused, while a parameter placeholder is stored", async () => {
    const dir = await mkdtemp(join(tmpdir(), "homectl-redaction-saved-"));
    try {
      const store = new SavedCommandStore(join(dir, "saved-commands.json"));
      const base = {
        name: "Connect",
        hosts: ["example"],
        description: "Connect to a database",
      };
      await expect(
        store.save({ ...base, argv: ["tool", "--dbpassword=hunter2"] }),
      ).rejects.toThrow("Secret-like");
      const saved = await store.save({
        ...base,
        argv: ["tool", "--dbpassword={{pw}}"],
        parameters: [{ name: "pw", secret: true }],
      });
      expect(saved.argv).toEqual(["tool", "--dbpassword={{pw}}"]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("control-plane refusal stays exactly master's", () => {
  const accepted = [
    "docker run -e KEY=value",
    "kubectl get pods -l key=app",
    "Rotate SSH key: host1",
    "uname -s",
    "docker ps --format json",
    "status:read",
    "auth: none",
  ];
  const refused = [
    "-----BEGIN OPENSSH PRIVATE KEY-----",
    "password=hunter2",
    "api_key: abcdef",
    "Authorization: Bearer abcdef123456",
    "hct_abcdefghijklmnop1234",
    "--token=[REDACTED]",
  ];

  test("master-accepted examples are accepted", () => {
    for (const text of accepted) {
      expect(masterContains(text)).toBe(false);
      expect(containsSecretMaterial(text)).toBe(false);
    }
  });

  test("master-refused examples are refused", () => {
    for (const text of refused) {
      expect(masterContains(text)).toBe(true);
      expect(containsSecretMaterial(text)).toBe(true);
    }
  });

  test("refusal matches master across a mixed corpus", () => {
    for (const text of [
      ...accepted,
      ...refused,
      "--dbpassword=hunter2",
      "PASSWORD={{pw}}suffix",
      "bearer short",
    ])
      expect(containsSecretMaterial(text)).toBe(masterContains(text));
  });
});
