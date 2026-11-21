import { describe, expect, test } from "bun:test";
import { reviewerFrom } from "../src/broker/reviewer-settings";
import { parseApiKey } from "../src/broker/ai-helper-routes";

describe("the reviewer built from settings", () => {
  test("a hosted provider with no key fails the review plainly", async () => {
    const reviewer = reviewerFrom(
      {
        version: 1,
        provider: "openrouter",
        endpoint: "https://openrouter.ai/api/v1/chat/completions",
        model: "m",
      },
      {},
      async () => undefined,
    );
    await expect(
      reviewer?.review(
        { kind: "exec", risk: "R1" },
        new AbortController().signal,
      ),
    ).rejects.toThrow("Add an API key");
  });

  test("a legacy address with no provider is Custom and needs no key", () => {
    const reviewer = reviewerFrom(
      {
        version: 1,
        endpoint: "http://localhost:1/v1/chat/completions",
        model: "m",
      },
      {},
    );
    expect(reviewer?.id).toBe("openai-compatible");
  });

  test("parseApiKey refuses spaces and line breaks and never echoes the key", () => {
    expect(parseApiKey("  sk-or-v1-abc  ")).toBe("sk-or-v1-abc");
    expect(parseApiKey("")).toBeUndefined();
    let message = "";
    try {
      parseApiKey("sk-two parts");
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain("Paste only the key");
    expect(message).not.toContain("sk-two");
  });
});
