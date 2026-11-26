import { describe, expect, test } from "bun:test";
import { FULL_ROUTES } from "../src/proxmox/full-routes";
import { REDACTED, redactOutput, redactParams } from "../src/proxmox/redact";

// Invariants of the full-mode route table. Every row must follow the tier rules
// (GET inspects, POST/PUT change, DELETE destroys) and owner-only areas must be
// flagged, so a new row cannot quietly widen what a client can approve.
describe("full-mode route table", () => {
  test("every row is well formed", () => {
    for (const row of FULL_ROUTES) {
      expect(row.template.startsWith("/")).toBe(false);
      expect(row.template.endsWith("/")).toBe(false);
      expect(row.template.includes("..")).toBe(false);
      expect(row.template).not.toMatch(/[?#%\\ ]/);
      expect(row.label.length).toBeGreaterThan(3);
      expect(["R1", "R2", "R3", "R4"]).toContain(row.risk);
    }
  });

  test("no two rows share a method and template", () => {
    const keys = FULL_ROUTES.map((row) => `${row.method} ${row.template}`);
    expect(new Set(keys).size).toBe(keys.length);
  });

  test("tier rules: reads are R1 (or owner-only R4), DELETE is R4, owner-only is R4", () => {
    for (const row of FULL_ROUTES) {
      if (row.method === "GET")
        expect(row.risk === "R1" || row.ownerOnly).toBe(true);
      if (row.method === "DELETE") expect(row.risk).toBe("R4");
      if (row.ownerOnly) expect(row.risk).toBe("R4");
    }
  });

  test("owner-only areas: access, firewall, network, HA, cluster config, shell-like execution", () => {
    const ownerOnly = (method: string, template: string) =>
      FULL_ROUTES.find(
        (row) => row.method === method && row.template === template,
      )?.ownerOnly;
    expect(ownerOnly("GET", "access/**")).toBe(true);
    expect(ownerOnly("POST", "access/**")).toBe(true);
    expect(ownerOnly("POST", "nodes/{node}/execute")).toBe(true);
    expect(ownerOnly("POST", "nodes/{node}/status")).toBe(true);
    expect(ownerOnly("PUT", "nodes/{node}/network")).toBe(true);
    expect(ownerOnly("PUT", "cluster/ha/**")).toBe(true);
    expect(ownerOnly("POST", "cluster/config/**")).toBe(true);
    expect(ownerOnly("POST", "cluster/firewall/**")).toBe(true);
    expect(ownerOnly("DELETE", "storage/{id}")).toBe(true);
    expect(
      ownerOnly("DELETE", "nodes/{node}/storage/{id}/content/{volume}"),
    ).toBe(true);
    expect(ownerOnly("POST", "nodes/{node}/services/{id}/start")).toBe(false);
  });

  test("guest agent exec and file access are owner-only; other agent reads are plain reads", () => {
    const find = (method: string, template: string) =>
      FULL_ROUTES.find(
        (row) => row.method === method && row.template === template,
      );
    const exec = find("POST", "nodes/{node}/{type}/{vmid}/agent/exec");
    expect(exec?.ownerOnly).toBe(true);
    const read = find("GET", "nodes/{node}/{type}/{vmid}/agent/**");
    expect(read?.risk).toBe("R1");
    expect(read?.ownerOnly).toBe(false);
  });

  test("shell-like endpoints are not in the table, so they are refused", () => {
    const paths = FULL_ROUTES.map((row) => row.template);
    for (const name of ["termproxy", "vncshell", "spiceshell", "vncwebsocket"])
      expect(paths.some((path) => path.includes(name))).toBe(false);
  });
});

describe("redaction", () => {
  test("secret-looking keys and secret-looking strings are replaced in output", () => {
    const out = redactOutput({
      memory: 2048,
      cipassword: "hunter2",
      data: { token: "abc", tokenid: "ops@pve!homectl" },
      list: [{ password: "p" }, { name: "keep" }],
      note: "password=hunter2 in a description",
      plain: "fine",
    }) as Record<string, unknown>;
    expect(out.memory).toBe(2048);
    expect(out.cipassword).toBe(REDACTED);
    expect(out.data).toEqual({ token: REDACTED, tokenid: REDACTED });
    expect(out.list).toEqual([{ password: REDACTED }, { name: "keep" }]);
    expect(out.note).toBe(REDACTED);
    expect(out.plain).toBe("fine");
    expect(JSON.stringify(out)).not.toContain("hunter2");
  });

  test("parameters with secret-looking names are redacted in views", () => {
    expect(redactParams({ memory: "2048", cipassword: "x" })).toEqual({
      memory: "2048",
      cipassword: REDACTED,
    });
  });
});
