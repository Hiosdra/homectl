import { describe, expect, test } from "bun:test";
import {
  reviewerRequest,
  replyText,
  httpReviewer,
  ReviewerRequestError,
} from "../src/authz/http-reviewer";
import { providerSpec, normalizeBaseUrl } from "../src/broker/ai-providers";
import {
  listModels,
  testReviewer,
  failureMessage,
  modelEntry,
} from "../src/broker/ai-models";
import { HomectlError } from "../src/types";

// Stub provider: no real API is ever called. Each test supplies its own fetch.
function stubFetch(
  handler: (url: string, init: RequestInit) => Response | Promise<Response>,
): { fetchImpl: typeof fetch; calls: { url: string; init: RequestInit }[] } {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetchImpl = (async (
    input: string | URL | Request,
    init?: RequestInit,
  ) => {
    const url = String(input);
    calls.push({ url, init: init ?? {} });
    return handler(url, init ?? {});
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

// The headers of the first call a stub received.
function headersOf(calls: { init: RequestInit }[]): Record<string, string> {
  const first = calls.at(0);
  return (first?.init.headers ?? {}) as Record<string, string>;
}

const verdictJson = JSON.stringify({ verdict: "ask", reason: "stub answer" });
const CANARY = "sk-canary-DO-NOT-LEAK-0001";

describe("provider addresses", () => {
  test("hosted providers have fixed chat and model list addresses", () => {
    expect(providerSpec("anthropic").chatUrl).toBe(
      "https://api.anthropic.com/v1/messages",
    );
    expect(providerSpec("anthropic").protocol).toBe("anthropic-messages");
    expect(providerSpec("anthropic").defaultModel).toBe("claude-haiku-5-5");
    expect(providerSpec("openai").chatUrl).toBe(
      "https://api.openai.com/v1/chat/completions",
    );
    expect(providerSpec("openai").protocol).toBe("openai-chat");
    expect(providerSpec("openrouter").modelsUrl).toBe(
      "https://openrouter.ai/api/v1/models",
    );
    expect(providerSpec("openrouter").keyRequired).toBe(true);
  });

  test("custom builds its addresses from the base and needs no key", () => {
    const spec = providerSpec("custom", "http://localhost:11434/v1/");
    expect(spec.chatUrl).toBe("http://localhost:11434/v1/chat/completions");
    expect(spec.modelsUrl).toBe("http://localhost:11434/v1/models");
    expect(spec.keyRequired).toBe(false);
    expect(normalizeBaseUrl("http://127.0.0.1:1234/v1/chat/completions")).toBe(
      "http://127.0.0.1:1234/v1",
    );
  });

  test("custom refuses credentials, plain remote http and a missing address", () => {
    expect(() => normalizeBaseUrl("https://user:pw@example.test/v1")).toThrow(
      "must not contain a username or password",
    );
    expect(() => normalizeBaseUrl("http://ai.example.test/v1")).toThrow(
      "must use https",
    );
    expect(() => providerSpec("custom")).toThrow("Enter the address");
  });
});

describe("request format per protocol", () => {
  const input = {
    kind: "exec" as const,
    host: "test-host",
    argv: ["uname", "-s"],
    classification: "inspect" as const,
    risk: "R1" as const,
  };

  test("Anthropic Messages: x-api-key header, system prompt, no bearer token", () => {
    const request = reviewerRequest(
      "anthropic-messages",
      "claude-haiku-5-5",
      input,
      "k-1",
    );
    expect(request.headers["x-api-key"]).toBe("k-1");
    expect(request.headers["anthropic-version"]).toBe("2023-06-01");
    expect(request.headers.authorization).toBeUndefined();
    const body = JSON.parse(request.body);
    expect(body.model).toBe("claude-haiku-5-5");
    expect(body.system).toContain("You review one infrastructure action");
    expect(body.messages).toHaveLength(1);
    expect(body.messages[0].role).toBe("user");
  });

  test("OpenAI-compatible: bearer token and system + user messages", () => {
    const request = reviewerRequest("openai-chat", "gpt-x", input, "k-2");
    expect(request.headers.authorization).toBe("Bearer k-2");
    expect(request.headers["x-api-key"]).toBeUndefined();
    const body = JSON.parse(request.body);
    expect(body.messages.map((m: { role: string }) => m.role)).toEqual([
      "system",
      "user",
    ]);
  });

  test("no key means no auth header for either protocol (Custom)", () => {
    expect(
      reviewerRequest("openai-chat", "m", input, undefined).headers
        .authorization,
    ).toBeUndefined();
    expect(
      reviewerRequest("anthropic-messages", "m", input, undefined).headers[
        "x-api-key"
      ],
    ).toBeUndefined();
  });

  test("the request carries only reviewer fields, never a key or client data", () => {
    const body = reviewerRequest("openai-chat", "m", input, undefined).body;
    expect(body).not.toContain(CANARY);
    expect(body).not.toContain("authorization");
  });

  test("replies are read from the right envelope", () => {
    expect(
      replyText("anthropic-messages", {
        content: [{ type: "text", text: '{"verdict":"allow"}' }],
      }),
    ).toBe('{"verdict":"allow"}');
    expect(
      replyText("openai-chat", { choices: [{ message: { content: "x" } }] }),
    ).toBe("x");
    expect(replyText("anthropic-messages", { choices: [] })).toBeUndefined();
  });
});

describe("reviewer over a stub provider", () => {
  const input = {
    kind: "exec" as const,
    risk: "R1" as const,
    host: "h",
    argv: ["true"],
  };

  test("Anthropic reviewer posts to the messages address and parses the text block", async () => {
    const { fetchImpl, calls } = stubFetch(
      () =>
        new Response(
          JSON.stringify({ content: [{ type: "text", text: verdictJson }] }),
          {
            status: 200,
          },
        ),
    );
    const reviewer = httpReviewer({
      url: providerSpec("anthropic").chatUrl,
      model: "claude-haiku-5-5",
      protocol: "anthropic-messages",
      getApiKey: async () => CANARY,
      fetchImpl,
    });
    const answer = await reviewer.review(input, new AbortController().signal);
    expect(answer).toEqual({ verdict: "ask", reason: "stub answer" });
    expect(calls[0]?.url).toBe("https://api.anthropic.com/v1/messages");
    expect(headersOf(calls)["x-api-key"]).toBe(CANARY);
  });

  test("a status error is a ReviewerRequestError with only the status", async () => {
    const { fetchImpl } = stubFetch(
      () => new Response("nope", { status: 401 }),
    );
    const reviewer = httpReviewer({
      url: "https://openrouter.ai/api/v1/chat/completions",
      model: "m",
      getApiKey: async () => CANARY,
      fetchImpl,
    });
    const error = await reviewer
      .review(input, new AbortController().signal)
      .catch((e) => e);
    expect(error).toBeInstanceOf(ReviewerRequestError);
    expect((error as ReviewerRequestError).status).toBe(401);
    expect(String((error as Error).message)).not.toContain(CANARY);
  });
});

describe("model list", () => {
  test("OpenRouter pricing is scaled to dollars per million and free models are flagged", () => {
    const paid = modelEntry({
      id: "vendor/big",
      name: "Big",
      context_length: 128000,
      pricing: { prompt: "0.000003", completion: "0.000015" },
      description: "A large model",
    });
    expect(paid?.price?.promptPerMillion).toBeCloseTo(3);
    expect(paid?.price?.completionPerMillion).toBeCloseTo(15);
    expect(paid?.free).toBe(false);
    expect(paid?.contextLength).toBe(128000);
    const free = modelEntry({
      id: "vendor/small:free",
      pricing: { prompt: "0", completion: "0" },
    });
    expect(free?.free).toBe(true);
    expect(modelEntry({ id: "openrouter/auto" })?.router).toBe(true);
  });

  test("listModels returns cards for an OpenAI-style list, with the pricing flag", async () => {
    const { fetchImpl, calls } = stubFetch(
      () =>
        new Response(
          JSON.stringify({
            data: [
              {
                id: "b-model",
                pricing: { prompt: "0.000001", completion: "0.000002" },
              },
              { id: "a-model", display_name: "Alpha" },
            ],
          }),
          { status: 200 },
        ),
    );
    const list = await listModels(
      providerSpec("openrouter"),
      CANARY,
      fetchImpl,
    );
    expect(list.models.map((m) => m.id)).toEqual(["a-model", "b-model"]);
    expect(list.pricing).toBe(true);
    expect(list.models[0]?.name).toBe("Alpha");
    expect(calls[0]?.url).toBe("https://openrouter.ai/api/v1/models");
  });

  test("Anthropic list asks for one page and uses the key header", async () => {
    const { fetchImpl, calls } = stubFetch(
      () =>
        new Response(
          JSON.stringify({
            data: [{ id: "claude-haiku-5-5", display_name: "Haiku" }],
          }),
        ),
    );
    const list = await listModels(providerSpec("anthropic"), CANARY, fetchImpl);
    expect(list.models[0]?.name).toBe("Haiku");
    expect(list.pricing).toBe(false);
    expect(calls[0]?.url).toBe("https://api.anthropic.com/v1/models?limit=100");
    expect(headersOf(calls)["x-api-key"]).toBe(CANARY);
  });
});

describe("plain errors", () => {
  test("status and network failures become plain sentences without the key", async () => {
    const cases: [number, RegExp][] = [
      [401, /did not accept this key/],
      [404, /ends in \/v1/],
      [429, /busy or has no credit/],
      [503, /problem on its side/],
    ];
    for (const [status, pattern] of cases) {
      const { fetchImpl } = stubFetch(
        () => new Response("body with secret", { status }),
      );
      const error = await listModels(
        providerSpec("openai"),
        CANARY,
        fetchImpl,
      ).catch((e) => e);
      expect(error).toBeInstanceOf(HomectlError);
      expect(error.message).toMatch(pattern);
      expect(error.message).not.toContain(CANARY);
      expect(error.message).not.toContain("body with secret");
    }
  });

  test("an unreachable server names only the host", async () => {
    const { fetchImpl } = stubFetch(() => {
      throw new TypeError("fetch failed: connect ECONNREFUSED 127.0.0.1:11434");
    });
    const error = await listModels(
      providerSpec("custom", "http://localhost:11434/v1"),
      undefined,
      fetchImpl,
    ).catch((e) => e);
    expect(error.message).toBe(
      failureMessage({ kind: "network", host: "localhost:11434" }),
    );
    expect(error.message).toContain("Could not reach localhost:11434");
  });

  test("a test call that gets a non-JSON verdict fails in plain words", async () => {
    const { fetchImpl } = stubFetch(
      () =>
        new Response(
          JSON.stringify({ content: [{ type: "text", text: "not json" }] }),
        ),
    );
    const error = await testReviewer(
      providerSpec("anthropic"),
      "claude-haiku-5-5",
      CANARY,
      fetchImpl,
    ).catch((e) => e);
    expect(error.message).toBe(failureMessage({ kind: "format" }));
    expect(error.message).not.toContain(CANARY);
  });

  test("a good test call reports the verdict shape without approving anything", async () => {
    const { fetchImpl } = stubFetch(
      () =>
        new Response(
          JSON.stringify({ content: [{ type: "text", text: verdictJson }] }),
        ),
    );
    const result = await testReviewer(
      providerSpec("anthropic"),
      "claude-haiku-5-5",
      CANARY,
      fetchImpl,
    );
    expect(result.verdict).toBe("ask");
  });
});
