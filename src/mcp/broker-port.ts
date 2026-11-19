// The stdio MCP server's route to the broker: it finds the running daemon and
// calls its agent API with this agent's client token. Discovery happens on
// every call, so a broker started after the MCP server still works.
import { callBroker, clientToken, findEndpoint } from "../broker/client";
import type { Endpoint } from "../broker/paths";
import { HomectlError } from "../types";
import type { AgentPort } from "./tools";

export const NO_BROKER =
  "The homectl broker is not running. Start it with `home-ctl daemon run` (or `home-ctl daemon install`), then try again.";
export const NO_TOKEN =
  "This agent is not connected to homectl. The owner connects it with `home-ctl agent connect codex|claude|other --hosts <list>`.";

export interface BrokerPortOptions {
  inventoryPath?: string;
  endpoint?: () => Promise<Endpoint | undefined>;
  token?: () => Promise<string | undefined>;
}

export function brokerPort(options: BrokerPortOptions = {}): AgentPort {
  const endpoint =
    options.endpoint ?? (() => findEndpoint(options.inventoryPath));
  const token = options.token ?? clientToken;
  return {
    async call(path, input) {
      const found = await endpoint();
      if (!found) throw new HomectlError(5, NO_BROKER);
      const secret = await token();
      if (!secret) throw new HomectlError(3, NO_TOKEN);
      return callBroker(path, input, {
        endpoint: found,
        authorization: `Bearer ${secret}`,
      });
    },
  };
}
