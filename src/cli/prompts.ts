import { createInterface } from "node:readline/promises";
export async function confirm(prompt: string, signal?: AbortSignal) {
  const input = createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  try {
    return /^(y|yes)$/i.test(
      (await input.question(`${prompt} [y/N]: `, { signal })).trim(),
    );
  } finally {
    input.close();
  }
}
