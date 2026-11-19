// Redaction helpers. `canaryLeaks` is the test and assertion tool: it reports
// where a value appears in any text, in raw or encoded form. It never echoes
// the values back, so its output is safe to put in test failures and logs.

import { redactor } from "../credentials";

export interface EncodedForm {
  label: string;
  text: string;
}

// The forms a value can take on the wire or in logs. Unpadded base64 is
// included because padding is often stripped in transit.
export function encodedForms(value: string): EncodedForm[] {
  const bytes = Buffer.from(value, "utf8");
  const base64 = bytes.toString("base64");
  const base64Url = bytes.toString("base64url");
  const forms: EncodedForm[] = [
    { label: "raw", text: value },
    { label: "url-encoded", text: encodeURIComponent(value) },
    { label: "base64", text: base64 },
    { label: "base64 (unpadded)", text: base64.replace(/=+$/, "") },
    { label: "base64url", text: base64Url },
    { label: "url-encoded base64", text: encodeURIComponent(base64) },
    { label: "hex", text: bytes.toString("hex") },
  ];
  // Forms that produce identical text (raw and URL-encoded for a URL-safe
  // value, for example) are reported once, under the first label.
  const seen = new Set<string>();
  const unique: EncodedForm[] = [];
  for (const form of forms) {
    if (form.text.length === 0 || seen.has(form.text)) continue;
    seen.add(form.text);
    unique.push(form);
  }
  return unique;
}

// Returns one description per (text, value, form) match. Empty values are
// ignored. Matching is substring-based, so it fails closed on short values.
export function canaryLeaks(texts: string[], values: string[]): string[] {
  const leaks: string[] = [];
  for (let j = 0; j < values.length; j++) {
    const value = values[j];
    if (!value) continue;
    for (const form of encodedForms(value)) {
      for (let i = 0; i < texts.length; i++) {
        if (texts[i]?.includes(form.text))
          leaks.push(`texts[${i}] contains ${form.label} of values[${j}]`);
      }
    }
  }
  return leaks;
}

// The existing credential redactor, extended with the base64url and hex forms
// that it does not cover itself.
export function makeRedactor(values: string[]): (text: string) => string {
  const forms = new Set<string>();
  for (const value of values) {
    if (!value) continue;
    for (const form of encodedForms(value)) forms.add(form.text);
  }
  return redactor([...forms]);
}
