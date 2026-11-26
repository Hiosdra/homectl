// Owner panel: how an assistant is named on screen. A name the owner typed is shown as
// it is; only when two assistants share a name is the id added after it, so the rows
// and the "Who can do what" sentences can tell them apart.
import { describe, expect, test } from "bun:test";
import {
  assistantLabels,
  sharedNameIds,
} from "../src/web/owner/assistant-labels";

describe("assistant labels", () => {
  test("a unique name is shown alone", () => {
    const clients = [
      { id: "codex", name: "Codex" },
      { id: "claude", name: "Claude Desktop" },
    ];
    expect(assistantLabels(clients)).toEqual({
      codex: "Codex",
      claude: "Claude Desktop",
    });
    expect(sharedNameIds(clients).size).toBe(0);
  });

  test("two assistants with one name get their ids after it", () => {
    const clients = [
      { id: "claude", name: "Claude" },
      { id: "claude-laptop", name: "Claude" },
      { id: "codex", name: "Codex" },
    ];
    expect(assistantLabels(clients)).toEqual({
      claude: "Claude · claude",
      "claude-laptop": "Claude · claude-laptop",
      codex: "Codex",
    });
    expect([...sharedNameIds(clients)].sort()).toEqual([
      "claude",
      "claude-laptop",
    ]);
  });

  test("names match regardless of case and surrounding spaces", () => {
    const clients = [
      { id: "a", name: "Claude " },
      { id: "b", name: "claude" },
    ];
    expect(assistantLabels(clients)).toEqual({
      a: "Claude · a",
      b: "claude · b",
    });
  });

  test("a missing name falls back to the id, and is shared like one", () => {
    const clients = [{ id: "codex" }, { id: "codex-2", name: "codex" }];
    expect(assistantLabels(clients)).toEqual({
      codex: "codex · codex",
      "codex-2": "codex · codex-2",
    });
  });
});
