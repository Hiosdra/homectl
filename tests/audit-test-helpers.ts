export async function waitFor<T>(
  read: () => T | Promise<T>,
  predicate: (value: T) => boolean,
  description: string,
): Promise<T> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const value = await read();
    if (predicate(value)) return value;
    await Bun.sleep(20);
  }
  throw new Error(`Timed out waiting for ${description}`);
}
