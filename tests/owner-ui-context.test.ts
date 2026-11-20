// Owner panel: the device context (homelab #21 §8). The switcher only filters
// what the views show. These checks cover the stored choice (a stale or broken
// value falls back to All devices), the filter itself, and that filtered rows
// are the same objects, so decisions still use the canonical <client>:<operation>
// key. No browser is needed here; the browser checks live in owner-ui-context.ts.
import { afterEach, describe, expect, test } from "bun:test";
import {
  ALL_DEVICES,
  CONTEXT_STORAGE_KEY,
  contextLabel,
  type DeviceContext,
  encodeContext,
  loadContext,
  parseContext,
  resolveContext,
  saveContext,
  sameContext,
  scopeRows,
  showsLocal,
  THIS_DEVICE,
  viewScope,
} from "../src/web/owner/context";
import { decisionKey } from "../src/web/owner/workspace-api";

const clients = [
  { id: "ws-laptop", name: "Laptop" },
  { id: "ws-nas", name: "NAS" },
];
const rows = [
  { origin: "ws-laptop", id: "op-1" },
  { origin: "ws-nas", id: "op-2" },
  { origin: "ws-laptop", id: "op-3" },
];

// A stand-in for window.localStorage. `broken` makes every access throw, as a
// blocked or private-window storage does.
function fakeStorage(options: { broken?: boolean } = {}) {
  const values = new Map<string, string>();
  const fail = () => {
    throw new DOMException("blocked", "SecurityError");
  };
  return {
    values,
    getItem: (key: string) =>
      options.broken ? fail() : (values.get(key) ?? null),
    setItem: (key: string, value: string) =>
      options.broken ? fail() : values.set(key, value),
  };
}

const realStorage = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
function installStorage(value: unknown) {
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    get: () => value,
  });
}
afterEach(() => {
  if (realStorage)
    Object.defineProperty(globalThis, "localStorage", realStorage);
  else delete (globalThis as { localStorage?: unknown }).localStorage;
});

describe("the stored choice", () => {
  test("every context encodes and parses back to itself", () => {
    for (const context of [
      ALL_DEVICES,
      THIS_DEVICE,
      { kind: "client", id: "ws-laptop" },
    ] as DeviceContext[])
      expect(parseContext(encodeContext(context))).toEqual(context);
  });

  test("an unknown, empty or oversized value means All devices", () => {
    for (const value of [
      null,
      undefined,
      "",
      "everything",
      "client:",
      `client:${"x".repeat(65)}`,
    ])
      expect(parseContext(value)).toEqual(ALL_DEVICES);
  });

  test("the choice is saved and read back from localStorage", () => {
    const storage = fakeStorage();
    installStorage(storage);
    saveContext({ kind: "client", id: "ws-nas" });
    expect(storage.values.get(CONTEXT_STORAGE_KEY)).toBe("client:ws-nas");
    expect(loadContext()).toEqual({ kind: "client", id: "ws-nas" });
  });

  test("with no localStorage at all, the panel starts on All devices", () => {
    installStorage(undefined);
    expect(loadContext()).toEqual(ALL_DEVICES);
    expect(() => saveContext(THIS_DEVICE)).not.toThrow();
  });

  test("a blocked localStorage never throws, and All devices is the default", () => {
    installStorage(fakeStorage({ broken: true }));
    expect(() => saveContext(THIS_DEVICE)).not.toThrow();
    expect(loadContext()).toEqual(ALL_DEVICES);
  });

  test("a localStorage getter that throws is treated as blocked", () => {
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      get: () => {
        throw new DOMException("denied", "SecurityError");
      },
    });
    expect(loadContext()).toEqual(ALL_DEVICES);
    expect(() => saveContext(THIS_DEVICE)).not.toThrow();
  });
});

describe("the context follows the linked clients", () => {
  test("a selected client that is no longer linked falls back to All devices", () => {
    expect(resolveContext({ kind: "client", id: "ws-gone" }, clients)).toEqual(
      ALL_DEVICES,
    );
  });

  test("a linked client stays selected", () => {
    const selected = { kind: "client", id: "ws-nas" } as const;
    expect(resolveContext(selected, clients)).toEqual(selected);
  });

  test("before the client list loads, the choice is kept", () => {
    const selected = { kind: "client", id: "ws-nas" } as const;
    expect(resolveContext(selected, undefined)).toEqual(selected);
  });

  test("the label names the client, or says that it is not known", () => {
    expect(contextLabel(ALL_DEVICES, clients)).toBe("All devices");
    expect(contextLabel(THIS_DEVICE, clients)).toBe("This device");
    expect(contextLabel({ kind: "client", id: "ws-nas" }, clients)).toBe("NAS");
    expect(contextLabel({ kind: "client", id: "ws-gone" }, clients)).toBe(
      "Linked client",
    );
  });

  test("sameContext compares the stored form", () => {
    expect(sameContext(ALL_DEVICES, parseContext("all"))).toBe(true);
    expect(sameContext(THIS_DEVICE, ALL_DEVICES)).toBe(false);
  });
});

describe("the filter", () => {
  test("All devices keeps every row, as a new list", () => {
    const scoped = scopeRows(ALL_DEVICES, rows, (row) => row.origin);
    expect(scoped).toEqual(rows);
    expect(scoped).not.toBe(rows);
  });

  test("This device keeps no linked-client rows", () => {
    expect(scopeRows(THIS_DEVICE, rows, (row) => row.origin)).toEqual([]);
  });

  test("a client keeps only its own rows", () => {
    const scoped = scopeRows(
      { kind: "client", id: "ws-laptop" },
      rows,
      (row) => row.origin,
    );
    expect(scoped.map((row) => row.id)).toEqual(["op-1", "op-3"]);
  });

  test("filtered rows are the same objects, so the decision key does not change", () => {
    const [first] = scopeRows(
      { kind: "client", id: "ws-nas" },
      rows,
      (row) => row.origin,
    );
    expect(first).toBe(rows[1]);
    expect(decisionKey(first?.origin ?? "", first?.id ?? "")).toBe(
      "ws-nas:op-2",
    );
  });

  test("local approvals and secrets belong to This device, not to a client", () => {
    expect(showsLocal(ALL_DEVICES)).toBe(true);
    expect(showsLocal(THIS_DEVICE)).toBe(true);
    expect(showsLocal({ kind: "client", id: "ws-nas" })).toBe(false);
  });

  test("the view scope names the context and counts what it hides", () => {
    expect(viewScope({ kind: "client", id: "ws-nas" }, clients, 4)).toEqual({
      context: { kind: "client", id: "ws-nas" },
      label: "NAS",
      hidden: 4,
    });
  });
});
