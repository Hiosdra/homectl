// The owners' names for assistants, read once from the broker's assistant list
// (an existing read). A name the owner typed ("Claude Desktop") is what the owner
// sees; until it loads, or when it cannot be read, the id is capitalised instead.
import { useEffect, useState } from "react";
import { type ClientView, ownerCall } from "./api";

export type AssistantNames = Readonly<Record<string, string>>;

export interface AssistantRoster {
  names: AssistantNames;
  // undefined until the list has loaded (or when it cannot be read).
  count: number | undefined;
}

// Names and the number of assistants, from one read of the assistant list.
export function useAssistantRoster(): AssistantRoster {
  const [roster, setRoster] = useState<AssistantRoster>({
    names: {},
    count: undefined,
  });
  useEffect(() => {
    let current = true;
    ownerCall<ClientView[]>("/v1/owner/clients/list")
      .then((list) => {
        if (current)
          setRoster({
            names: Object.fromEntries(
              list.map((client) => [client.id, client.name || client.id]),
            ),
            count: list.length,
          });
      })
      .catch(() => undefined);
    return () => {
      current = false;
    };
  }, []);
  return roster;
}

export function useAssistantNames(): AssistantNames {
  return useAssistantRoster().names;
}
