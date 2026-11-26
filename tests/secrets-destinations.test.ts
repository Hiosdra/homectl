import { describe, expect, test } from "bun:test";
import type { SecretDestination } from "../src/core/contracts";
import { destinationKey, normalizeDestination } from "../src/secrets";
import { HomectlError } from "../src/types";

const knownHost = (host: string) => host === "ext-host-01";

function rejects(value: unknown): HomectlError {
  try {
    normalizeDestination(value, knownHost);
  } catch (error) {
    if (error instanceof HomectlError) return error;
    throw error;
  }
  throw new Error(`expected rejection for ${JSON.stringify(value)}`);
}

function accepts(value: unknown): SecretDestination {
  return normalizeDestination(value, knownHost);
}

describe("secret destinations: ssh-stdin", () => {
  test("accepts a known host with a non-empty argv", () => {
    expect(
      accepts({ kind: "ssh-stdin", host: "ext-host-01", argv: ["chpasswd"] }),
    ).toEqual({
      kind: "ssh-stdin",
      host: "ext-host-01",
      argv: ["chpasswd"],
    });
  });

  test("refuses unknown hosts, empty argv, and argv with NUL, CR or LF", () => {
    expect(
      rejects({ kind: "ssh-stdin", host: "other", argv: ["x"] }).code,
    ).toBe(2);
    expect(
      rejects({ kind: "ssh-stdin", host: "ext-host-01", argv: [] }).code,
    ).toBe(2);
    expect(
      rejects({ kind: "ssh-stdin", host: "ext-host-01", argv: ["a\0b"] }).code,
    ).toBe(2);
    expect(
      rejects({ kind: "ssh-stdin", host: "ext-host-01", argv: ["a\rb"] }).code,
    ).toBe(2);
    expect(
      rejects({ kind: "ssh-stdin", host: "ext-host-01", argv: ["a\nb"] }).code,
    ).toBe(2);
    expect(
      rejects({ kind: "ssh-stdin", host: "ext-host-01", argv: [1] }).code,
    ).toBe(2);
  });
});

describe("secret destinations: http-header", () => {
  test("accepts https and loopback http only", () => {
    for (const url of [
      "https://ext-host-01.example/api",
      "http://127.0.0.1:8080/hook",
      "http://localhost:9000/hook",
      "http://[::1]:9000/hook",
    ])
      expect(
        accepts({ kind: "http-header", url, header: "X-Api-Key" }).kind,
      ).toBe("http-header");
  });

  test("refuses plain http for non-loopback hosts and other schemes", () => {
    for (const url of [
      "http://example.com/api",
      "http://192.168.1.10/api",
      "http://localhost.example.com/api",
      "ftp://example.com/x",
      "javascript:alert(1)",
    ])
      expect(
        rejects({ kind: "http-header", url, header: "X-Api-Key" }).code,
      ).toBe(2);
  });

  test("refuses redirect-like userinfo URLs in every form", () => {
    for (const url of [
      "https://allowed.example@evil.example/steal",
      "https://user:pass@ext-host-01.example/api",
      "http://127.0.0.1@evil.example/x",
      "https://evil.example\\@ext-host-01.example/x",
    ])
      expect(
        rejects({ kind: "http-header", url, header: "X-Api-Key" }).code,
      ).toBe(2);
  });

  test("refuses whitespace and control characters in the URL", () => {
    expect(
      rejects({
        kind: "http-header",
        url: "https://ext.example/a b",
        header: "X",
      }).code,
    ).toBe(2);
    expect(
      rejects({
        kind: "http-header",
        url: "https://ext.example/a\nb",
        header: "X",
      }).code,
    ).toBe(2);
  });

  test("header names must be RFC 7230 tokens", () => {
    expect(
      accepts({
        kind: "http-header",
        url: "https://ext.example/",
        header: "X-Api-Key",
      }).kind,
    ).toBe("http-header");
    for (const header of ["Bad Header", "X:Key", "", "X\r\nInjected: 1", "é"])
      expect(
        rejects({ kind: "http-header", url: "https://ext.example/", header })
          .code,
      ).toBe(2);
  });
});

describe("secret destinations: target-file", () => {
  test("accepts an absolute path with a mode that grants no group or other write", () => {
    for (const mode of ["0600", "0400", "0644", "0000"])
      expect(
        accepts({
          kind: "target-file",
          host: "ext-host-01",
          path: "/etc/app/secret",
          mode,
        }).kind,
      ).toBe("target-file");
  });

  test("refuses relative paths, traversal, empty segments and trailing slashes", () => {
    for (const path of [
      "relative/secret",
      "/etc/../shadow",
      "/etc/./secret",
      "/etc//secret",
      "/etc/secret/",
      "/",
      "/etc\\secret",
    ])
      expect(
        rejects({
          kind: "target-file",
          host: "ext-host-01",
          path,
          mode: "0600",
        }).code,
      ).toBe(2);
  });

  test("refuses modes that grant group or other write, or that are malformed", () => {
    for (const mode of ["0660", "0602", "0666", "600", "0789", "1600"])
      expect(
        rejects({
          kind: "target-file",
          host: "ext-host-01",
          path: "/etc/x",
          mode,
        }).code,
      ).toBe(2);
  });

  test("refuses unknown hosts", () => {
    expect(
      rejects({
        kind: "target-file",
        host: "other",
        path: "/etc/x",
        mode: "0600",
      }).code,
    ).toBe(2);
  });
});

describe("secret destinations: vault-only and exact comparison", () => {
  test("vault-only needs no host", () => {
    expect(accepts({ kind: "vault-only" })).toEqual({ kind: "vault-only" });
  });

  test("unknown kinds are refused", () => {
    expect(rejects({ kind: "clipboard" }).code).toBe(2);
    expect(rejects("ssh-stdin").code).toBe(2);
  });

  test("destination keys are equal only when every field matches, argv order included", () => {
    const a = accepts({
      kind: "ssh-stdin",
      host: "ext-host-01",
      argv: ["a", "b"],
    });
    const same = accepts({
      kind: "ssh-stdin",
      host: "ext-host-01",
      argv: ["a", "b"],
    });
    const reordered = accepts({
      kind: "ssh-stdin",
      host: "ext-host-01",
      argv: ["b", "a"],
    });
    expect(destinationKey(a)).toBe(destinationKey(same));
    expect(destinationKey(a)).not.toBe(destinationKey(reordered));
  });
});
