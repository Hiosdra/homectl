// What an assistant is called on screen. Names are typed by the owner, so two can
// match ("Claude" twice). Only then is the id added after the name, quietly, so each
// row and sentence says which one it means. Pure functions, so they test without a
// browser.

export interface NamedAssistant {
  id: string;
  name?: string;
}

function shownName(client: NamedAssistant): string {
  return (client.name || client.id).trim();
}

// Lower case, so "Claude" and "claude" count as the same name.
function nameKey(client: NamedAssistant): string {
  return shownName(client).toLowerCase();
}

// The ids of every assistant whose name is shared with another one.
export function sharedNameIds(clients: readonly NamedAssistant[]): Set<string> {
  const counts = new Map<string, number>();
  for (const client of clients)
    counts.set(nameKey(client), (counts.get(nameKey(client)) ?? 0) + 1);
  return new Set(
    clients
      .filter((client) => (counts.get(nameKey(client)) ?? 0) > 1)
      .map((client) => client.id),
  );
}

// The label for each id: the name, with " · id" added only where the name is shared.
export function assistantLabels(
  clients: readonly NamedAssistant[],
): Record<string, string> {
  const shared = sharedNameIds(clients);
  return Object.fromEntries(
    clients.map((client) => [
      client.id,
      shared.has(client.id)
        ? `${shownName(client)} · ${client.id}`
        : shownName(client),
    ]),
  );
}
