import { describe, expect, test } from "bun:test";
import type { SecretDestination } from "../src/core/contracts";
import { canaryLeaks, injectionPlan } from "../src/secrets";
import { HomectlError } from "../src/types";

// Canary only. Never a real credential.
const CANARY = "CANARY-homectl-inject-9Hq1-do-not-leak";
const SECOND = "CANARY-homectl-inject-second-2Xw8";

function refused(fn: () => unknown): HomectlError {
  try {
    fn();
  } catch (error) {
    if (error instanceof HomectlError) return error;
    throw error;
  }
  throw new Error("expected a throw");
}

describe("secret injection: ssh-stdin", () => {
  test("single field: the value is the stdin and argv is the destination argv", () => {
    const destination: SecretDestination = {
      kind: "ssh-stdin",
      host: "ext-host-01",
      argv: ["chpasswd"],
    };
    const plan = injectionPlan(destination, { password: CANARY });
    expect(plan).toEqual({
      kind: "ssh-stdin",
      host: "ext-host-01",
      argv: ["chpasswd"],
      stdin: CANARY,
    });
    expect(
      canaryLeaks(
        [plan.kind === "ssh-stdin" ? plan.argv.join(" ") : ""],
        [CANARY],
      ),
    ).toEqual([]);
  });

  test("several fields: sorted name=value lines on stdin, never in argv", () => {
    const plan = injectionPlan(
      { kind: "ssh-stdin", host: "ext-host-01", argv: ["chpasswd"] },
      { token: SECOND, password: CANARY },
    );
    expect(plan.kind === "ssh-stdin" && plan.stdin).toBe(
      `password=${CANARY}\ntoken=${SECOND}\n`,
    );
    expect(plan.kind === "ssh-stdin" && plan.argv).toEqual(["chpasswd"]);
  });

  test("multi-field values cannot smuggle line breaks into the stdin format", () => {
    const error = refused(() =>
      injectionPlan(
        { kind: "ssh-stdin", host: "ext-host-01", argv: ["chpasswd"] },
        { password: `${CANARY}\nroot=evil`, token: SECOND },
      ),
    );
    expect(error.code).toBe(2);
  });

  test("a value that would appear in argv is refused, in raw or encoded form", () => {
    const destination: SecretDestination = {
      kind: "ssh-stdin",
      host: "ext-host-01",
      argv: ["sh", "-c", `echo ${CANARY}`],
    };
    const error = refused(() =>
      injectionPlan(destination, { password: CANARY }),
    );
    expect(error.code).toBe(3);
    expect(error.message).not.toContain(CANARY);
  });

  test("rejects a destination whose argv is not valid", () => {
    expect(
      refused(() =>
        injectionPlan(
          { kind: "ssh-stdin", host: "ext-host-01", argv: [] },
          { password: CANARY },
        ),
      ).code,
    ).toBe(2);
  });
});

describe("secret injection: http-header", () => {
  test("one field: url and a single header carrying the value", () => {
    const plan = injectionPlan(
      {
        kind: "http-header",
        url: "https://ext.example/api",
        header: "X-Api-Key",
      },
      { token: CANARY },
    );
    expect(plan).toEqual({
      kind: "http-header",
      url: "https://ext.example/api",
      headers: { "X-Api-Key": CANARY },
    });
  });

  test("the value is refused in the URL, in raw or encoded form", () => {
    const error = refused(() =>
      injectionPlan(
        {
          kind: "http-header",
          url: `https://ext.example/api?key=${encodeURIComponent(CANARY)}`,
          header: "X-Api-Key",
        },
        { token: CANARY },
      ),
    );
    expect(error.code).toBe(3);
  });

  test("more than one field is refused; header values cannot carry CR or LF", () => {
    const destination: SecretDestination = {
      kind: "http-header",
      url: "https://ext.example/api",
      header: "X-Api-Key",
    };
    expect(
      refused(() => injectionPlan(destination, { a: CANARY, b: SECOND })).code,
    ).toBe(2);
    expect(
      refused(() =>
        injectionPlan(destination, { token: `${CANARY}\r\nX-Evil: 1` }),
      ).code,
    ).toBe(2);
  });

  test("destinations that cannot be injected into are refused", () => {
    expect(
      refused(() => injectionPlan({ kind: "vault-only" }, { token: CANARY }))
        .code,
    ).toBe(2);
  });
});

describe("secret injection: target-file", () => {
  test("two steps: install creates the file with its mode, then dd writes the value on stdin; no value in argv", () => {
    const plan = injectionPlan(
      {
        kind: "target-file",
        host: "ext-host-01",
        path: "/etc/app/secret",
        mode: "0600",
      },
      { token: CANARY },
    );
    expect(plan.kind).toBe("target-file");
    if (plan.kind !== "target-file") return;
    expect(plan.host).toBe("ext-host-01");
    expect(plan.steps[0]).toEqual({
      argv: ["install", "-m", "0600", "/dev/null", "/etc/app/secret"],
    });
    expect(plan.steps[1]).toEqual({
      argv: ["dd", "of=/etc/app/secret", "status=none"],
      stdin: CANARY,
    });
    const argvText = plan.steps.map((step) => step.argv.join(" ")).join("\n");
    expect(canaryLeaks([argvText], [CANARY])).toEqual([]);
  });

  test("the planner refuses a path that would carry the value", () => {
    const error = refused(() =>
      injectionPlan(
        {
          kind: "target-file",
          host: "ext-host-01",
          path: `/etc/${CANARY}`,
          mode: "0600",
        },
        { token: CANARY },
      ),
    );
    expect(error.code).toBe(3);
  });

  test("an invalid mode is refused by the planner too", () => {
    expect(
      refused(() =>
        injectionPlan(
          {
            kind: "target-file",
            host: "ext-host-01",
            path: "/etc/x",
            mode: "0666",
          },
          { token: CANARY },
        ),
      ).code,
    ).toBe(2);
  });
});

describe("secret injection: input shape", () => {
  test("value keys must be valid field names; values must be non-empty", () => {
    const destination: SecretDestination = {
      kind: "ssh-stdin",
      host: "ext-host-01",
      argv: ["chpasswd"],
    };
    expect(
      refused(() => injectionPlan(destination, { "Bad Name": CANARY })).code,
    ).toBe(2);
    expect(
      refused(() => injectionPlan(destination, { password: "" })).code,
    ).toBe(2);
    expect(refused(() => injectionPlan(destination, {})).code).toBe(2);
  });
});
