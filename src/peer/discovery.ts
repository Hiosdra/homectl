import { randomUUID } from "node:crypto";
import { networkInterfaces } from "node:os";
import mdns from "multicast-dns";

const service = "_homectl._tcp.local";
export type Discovered = { id: string; address: string; expiresAt: number };
export function discovery(
  port: number,
  advertise: () => boolean,
  interfaceIP?: string,
) {
  const id = randomUUID();
  const instance = `${id}.${service}`;
  const host = `${id}.local`;
  const found = new Map<string, Discovered>();
  const dns = mdns({ interface: interfaceIP });
  let error: string | undefined;
  dns.on("error", () => {
    error = "LAN discovery unavailable; use a manual IP address";
  });
  function announce(ttl = 15) {
    const addresses = Object.values(networkInterfaces())
      .flat()
      .filter(
        (a) =>
          a &&
          a.family === "IPv4" &&
          !a.internal &&
          (!interfaceIP || a.address === interfaceIP),
      )
      .map((a) => a?.address)
      .filter((a): a is string => Boolean(a));
    dns.respond({
      answers: [
        { name: service, type: "PTR", ttl, data: instance },
        {
          name: instance,
          type: "SRV",
          ttl,
          data: { port, target: host, priority: 0, weight: 0 },
        },
        {
          name: instance,
          type: "TXT",
          ttl,
          data: [Buffer.from("version=1"), Buffer.from("pairing=1")],
        },
        ...addresses.map((address) => ({
          name: host,
          type: "A" as const,
          ttl,
          data: address,
        })),
      ],
    });
  }
  dns.on("query", (q) => {
    if (advertise() && q.questions.some((v) => v.name === service)) announce();
  });
  dns.on("response", (r, remote) => {
    for (const answer of [...r.answers, ...r.additionals])
      if (
        answer.type === "SRV" &&
        answer.name.endsWith(`.${service}`) &&
        answer.name !== instance &&
        answer.data.port > 0
      ) {
        const peerId = answer.name.slice(0, -service.length - 1);
        if (!/^[a-f0-9-]{36}$/.test(peerId)) continue;
        if (answer.ttl === 0) found.delete(peerId);
        else
          found.set(peerId, {
            id: peerId,
            address: `http://${remote.address}:${answer.data.port}`,
            expiresAt: Date.now() + Math.min(answer.ttl ?? 15, 30) * 1000,
          });
      }
  });
  const timer = setInterval(() => {
    for (const [k, v] of found) if (v.expiresAt < Date.now()) found.delete(k);
    dns.query(service, "PTR");
    if (advertise()) announce();
  }, 5000);
  timer.unref();
  return {
    list: () => ({ devices: [...found.values()], error }),
    close: () => {
      clearInterval(timer);
      if (advertise()) announce(0);
      dns.destroy();
    },
  };
}
