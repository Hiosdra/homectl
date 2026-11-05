import { expect, test } from "bun:test";
import { controlPlaneSchema, definition, schemas } from "../src/control/schema";
import {
  CLASSIFICATIONS,
  OPERATION_KINDS,
  OPERATION_STATES,
  SCOPES,
} from "../src/control/types";

const id = "0b6f2c1e-3a4d-4e5f-8a9b-0c1d2e3f4a5b";
const digest = "a".repeat(64);
const enumOf = (name: string) =>
  (controlPlaneSchema.definitions as Record<string, { enum?: string[] }>)[name]
    ?.enum;

test("TypeScript enumerations match the JSON schema", () => {
  expect(enumOf("scope")).toEqual([...SCOPES]);
  expect(enumOf("operationKind")).toEqual([...OPERATION_KINDS]);
  expect(enumOf("operationState")).toEqual([...OPERATION_STATES]);
  expect(enumOf("classification")).toEqual([...CLASSIFICATIONS]);
});

test("request union accepts each typed operation", () => {
  const valid = [
    { op: "inspect" },
    { op: "inspect", host: "lab-printer" },
    { op: "status" },
    { op: "status", operationId: id },
    {
      op: "plan",
      host: "lab-printer",
      argv: ["uname", "-s"],
      impact: "read kernel name",
      idempotencyKey: "req-1",
    },
    { op: "validate", operationId: id, fingerprint: digest },
    {
      op: "approve",
      operationId: id,
      fingerprint: digest,
      decision: "approve",
    },
    { op: "approve", operationId: id, fingerprint: digest, decision: "reject" },
    { op: "execute", operationId: id },
    { op: "verify", operationId: id },
  ];
  for (const request of valid) expect(schemas.request(request)).toBe(true);
});

test("request union rejects unknown operations and smuggled fields", () => {
  const invalid: unknown[] = [
    { op: "shell", argv: ["sh", "-c", "id"] },
    { op: "exec", host: "lab-printer", argv: ["uname"] },
    { op: "execute", operationId: id, argv: ["rm", "-rf", "/"] },
    { op: "inspect", host: "Bad Host" },
    { op: "plan", host: "lab-printer", argv: [] },
    { op: "plan", host: "lab-printer", argv: ["uname"], approval: digest },
    {
      op: "approve",
      operationId: "not-a-uuid",
      fingerprint: digest,
      decision: "approve",
    },
    {
      op: "approve",
      operationId: id,
      fingerprint: "short",
      decision: "approve",
    },
    { op: "approve", operationId: id, fingerprint: digest, decision: "auto" },
    {
      op: "plan",
      host: "lab-printer",
      argv: ["uname"],
      idempotencyKey: "has space",
    },
    {
      op: "plan",
      host: "lab-printer",
      argv: ["uname"],
      impact: "x".repeat(1001),
    },
    { op: "plan", host: "lab-printer", argv: Array(65).fill("a") },
    "not an object",
    null,
  ];
  for (const request of invalid) expect(schemas.request(request)).toBe(false);
});

test("client identity requires explicit scopes from the enumeration", () => {
  const base = {
    id: "codex-pc",
    name: "Codex PC",
    scopes: ["inspect:read", "plan:create"],
    hosts: ["lab-printer"],
  };
  expect(schemas.clientIdentity(base)).toBe(true);
  expect(schemas.clientIdentity({ ...base, scopes: [] })).toBe(false);
  expect(schemas.clientIdentity({ ...base, scopes: ["exec:run"] })).toBe(false);
  expect(
    schemas.clientIdentity({ ...base, scopes: ["plan:create", "plan:create"] }),
  ).toBe(false);
  expect(schemas.clientIdentity({ ...base, tokenHash: digest })).toBe(false);
  expect(schemas.clientIdentity({ ...base, id: "Codex PC" })).toBe(false);
});

test("audit entries are strictly shaped and hash-linked", () => {
  const entry = {
    v: 1,
    seq: 1,
    at: "2026-11-05T10:00:00.000Z",
    prev: "0".repeat(64),
    hash: digest,
    event: { event: "operation.planned", client: "codex-pc", operationId: id },
  };
  expect(schemas.auditEntry(entry)).toBe(true);
  expect(schemas.auditEntry({ ...entry, seq: 0 })).toBe(false);
  expect(schemas.auditEntry({ ...entry, at: "yesterday" })).toBe(false);
  expect(
    schemas.auditEntry({ ...entry, event: { event: "token.leaked" } }),
  ).toBe(false);
  expect(
    schemas.auditEntry({
      ...entry,
      event: { event: "request.accepted", token: "hct_x" },
    }),
  ).toBe(false);
});

test("view definitions exist for every public record", () => {
  for (const name of [
    "clientView",
    "operationView",
    "approvalView",
    "operationRecord",
    "auditEntry",
  ])
    expect(() => definition(name)).not.toThrow();
  expect(() => definition("doesNotExist")).toThrow();
});
