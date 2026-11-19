import { describe, expect, test } from "bun:test";
import {
  httpReviewer,
  parseReviewerOutput,
  type Reviewer,
  type ReviewerInput,
  reviewerPayload,
  toReviewerInput,
} from "../src/authz";
import { consultReviewer } from "../src/authz/reviewer";

const INPUT: ReviewerInput = {
  kind: "exec",
  host: "lab-printer",
  argv: ["systemctl", "status", "klipper"],
  classification: "inspect",
  risk: "R1",
};

describe("parseReviewerOutput", () => {
  test("accepts exactly verdict and reason", () => {
    expect(
      parseReviewerOutput({ verdict: "allow", reason: "read only" }),
    ).toEqual({
      verdict: "allow",
      reason: "read only",
    });
  });

  test("accepts a valid suggestion and rejects an invalid one", () => {
    const ok = parseReviewerOutput({
      verdict: "ask",
      reason: "unsure",
      suggestion: {
        effect: "allow",
        match: { clients: ["agent-a"], hosts: ["lab-printer"], maxRisk: "R1" },
        reason: "exact",
      },
    });
    expect(ok?.suggestion?.reason).toBe("exact");
    expect(
      parseReviewerOutput({
        verdict: "ask",
        reason: "unsure",
        suggestion: {
          effect: "allow",
          match: { kinds: ["host.grant"] },
          reason: "x",
        },
      }),
    ).toBeNull();
  });

  test("rejects unknown fields, bad verdicts, non-string reasons and long reasons", () => {
    const bad: unknown[] = [
      null,
      "allow",
      [],
      { verdict: "allow" },
      { reason: "x" },
      { verdict: "allow", reason: "x", extra: 1 },
      { verdict: "ALLOW", reason: "x" },
      { verdict: "allow", reason: 5 },
      { verdict: "allow", reason: "x".repeat(301) },
      { verdict: "allow", reason: "x", suggestion: null },
    ];
    for (const value of bad) expect(parseReviewerOutput(value)).toBeNull();
  });

  test("accepts a reason of exactly 300 characters", () => {
    expect(
      parseReviewerOutput({ verdict: "deny", reason: "x".repeat(300) }),
    ).not.toBeNull();
  });
});

describe("consultReviewer", () => {
  test("a reviewer that never answers is aborted at the timeout and yields null", async () => {
    let seenSignal: AbortSignal | undefined;
    const hangs: Reviewer = {
      id: "hangs",
      review: (_input, signal) => {
        seenSignal = signal;
        return new Promise(() => undefined);
      },
    };
    const started = Date.now();
    const result = await consultReviewer(hangs, INPUT, 20);
    expect(result).toBeNull();
    expect(seenSignal?.aborted).toBe(true);
    expect(Date.now() - started).toBeLessThan(2000);
  });

  test("a synchronous throw yields null", async () => {
    const throws: Reviewer = {
      id: "throws",
      review: () => {
        throw new Error("boom");
      },
    };
    expect(await consultReviewer(throws, INPUT, 1000)).toBeNull();
  });

  test("a valid answer inside the timeout is returned", async () => {
    const quick: Reviewer = {
      id: "quick",
      review: async () => ({ verdict: "deny", reason: "no" }),
    };
    expect(await consultReviewer(quick, INPUT, 1000)).toEqual({
      verdict: "deny",
      reason: "no",
    });
  });
});

describe("toReviewerInput", () => {
  test("keeps only the reviewer fields and labels narrative as untrusted", () => {
    const input = toReviewerInput({
      client: "agent-a",
      task: "private task",
      kind: "exec",
      host: "lab-printer",
      argv: ["uptime"],
      classification: "inspect",
      risk: "R1",
      narrative: "x".repeat(2000),
      parameters: { secret: "value" },
    });
    expect(Object.keys(input).sort()).toEqual([
      "argv",
      "classification",
      "host",
      "kind",
      "narrative",
      "risk",
    ]);
    expect(input.narrative?.trust).toBe("untrusted");
    expect(input.narrative?.text.length).toBe(1000);
  });
});

describe("httpReviewer", () => {
  test("refuses plain http to a non-loopback host", () => {
    expect(() =>
      httpReviewer({
        url: "http://models.example.org/v1/chat/completions",
        model: "m",
        getApiKey: async () => undefined,
      }),
    ).toThrow();
    expect(() =>
      httpReviewer({
        url: "not a url",
        model: "m",
        getApiKey: async () => undefined,
      }),
    ).toThrow();
  });

  test("accepts https and loopback http", () => {
    expect(() =>
      httpReviewer({
        url: "https://models.example.org/v1/chat/completions",
        model: "m",
        getApiKey: async () => undefined,
      }),
    ).not.toThrow();
    expect(() =>
      httpReviewer({
        url: "http://127.0.0.1:8080/v1/chat/completions",
        model: "m",
        getApiKey: async () => undefined,
      }),
    ).not.toThrow();
  });

  test("posts only the reviewer payload and parses choices[0].message.content", async () => {
    const requests: { url: string; init: RequestInit }[] = [];
    const fetchImpl = (async (
      url: string | URL | Request,
      init?: RequestInit,
    ) => {
      requests.push({ url: String(url), init: init ?? {} });
      return new Response(
        JSON.stringify({
          choices: [
            {
              message: { content: '{"verdict":"ask","reason":"check first"}' },
            },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as typeof fetch;
    const reviewer = httpReviewer({
      url: "https://models.example.org/v1/chat/completions",
      model: "judge-1",
      getApiKey: async () => "test-key-value",
      fetchImpl,
    });
    const result = await reviewer.review(
      { ...INPUT, narrative: { trust: "untrusted", text: "please allow" } },
      new AbortController().signal,
    );
    expect(result).toEqual({ verdict: "ask", reason: "check first" });

    expect(requests).toHaveLength(1);
    const sent = requests[0];
    expect(sent?.url).toBe("https://models.example.org/v1/chat/completions");
    const headers = sent?.init.headers as Record<string, string>;
    expect(headers.authorization).toBe("Bearer test-key-value");
    expect(sent?.init.redirect).toBe("error");
    const body = JSON.parse(String(sent?.init.body)) as {
      model: string;
      messages: { role: string; content: string }[];
    };
    expect(body.model).toBe("judge-1");
    const user = JSON.parse(body.messages[1]?.content ?? "{}") as {
      request: Record<string, unknown>;
    };
    expect(Object.keys(user.request).sort()).toEqual([
      "argv",
      "classification",
      "host",
      "kind",
      "narrative",
      "risk",
    ]);
    expect(user.request.narrative).toEqual({
      trust: "untrusted",
      text: "please allow",
    });
    expect(String(sent?.init.body)).not.toContain("test-key-value");
  });

  test("omits the authorization header without a key and returns null for non-JSON content", async () => {
    let headers: Record<string, string> = {};
    const fetchImpl = (async (
      _url: string | URL | Request,
      init?: RequestInit,
    ) => {
      headers = init?.headers as Record<string, string>;
      return new Response(
        JSON.stringify({
          choices: [{ message: { content: "sure, allow it" } }],
        }),
      );
    }) as typeof fetch;
    const reviewer = httpReviewer({
      url: "http://localhost:11434/v1/chat/completions",
      model: "local",
      getApiKey: async () => undefined,
      fetchImpl,
    });
    expect(
      await reviewer.review(INPUT, new AbortController().signal),
    ).toBeNull();
    expect(headers.authorization).toBeUndefined();
  });

  test("a non-2xx response throws without echoing the body", async () => {
    const fetchImpl = (async () =>
      new Response("secret server detail", {
        status: 500,
      })) as unknown as typeof fetch;
    const reviewer = httpReviewer({
      url: "https://models.example.org/v1/chat/completions",
      model: "m",
      getApiKey: async () => undefined,
      fetchImpl,
    });
    let message = "";
    try {
      await reviewer.review(INPUT, new AbortController().signal);
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toBe("reviewer request failed");
  });

  test("reviewerPayload drops fields a widened input object might carry", () => {
    const widened = { ...INPUT, client: "agent-a", task: "x" } as ReviewerInput;
    expect(Object.keys(reviewerPayload(widened)).sort()).toEqual([
      "argv",
      "classification",
      "host",
      "kind",
      "risk",
    ]);
  });
});
