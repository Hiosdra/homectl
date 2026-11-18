import { expect } from "bun:test";

export function rejectionArgvPresence(audit: string): boolean[] {
  return audit
    .split("\n")
    .filter((line) => line.includes('"request.rejected"'))
    .map((line) => line.includes('"argv"'));
}

export function expectSecretRefusalsOmitArguments(
  state: string,
  audit: string,
) {
  for (const value of [state, audit]) {
    expect(value).not.toContain("hunter2");
    expect(value).not.toContain("hct_abcdefghijklmnop1234");
  }
  expect(rejectionArgvPresence(audit)).toEqual([false, false]);
}
