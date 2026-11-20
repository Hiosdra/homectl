// The owners' names for assistants, read once from the broker's assistant list
// (an existing read). A name the owner typed ("Claude Desktop") is what the owner
// sees; until it loads, or when it cannot be read, the id is capitalised instead.
import { useEffect, useState } from "react";
import { type ClientView, ownerCall } from "./api";

export type AssistantNames = Readonly<Record<string, string>>;

export function useAssistantNames(): AssistantNames {
  const [names, setNames] = useState<AssistantNames>({});
  useEffect(() => {
    let current = true;
    ownerCall<ClientView[]>("/v1/owner/clients/list")
      .then((list) => {
        if (current)
          setNames(
            Object.fromEntries(
              list.map((client) => [client.id, client.name || client.id]),
            ),
          );
      })
      .catch(() => undefined);
    return () => {
      current = false;
    };
  }, []);
  return names;
}
