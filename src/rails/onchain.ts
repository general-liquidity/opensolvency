import { createNetworkRail, type RailClient } from "./networkRail.ts";
import type { PaymentProvider } from "./provider.ts";

export type OnchainClient = RailClient;

/** Direct operator-signed on-chain transfer, distinct from the x402 protocol. */
export function createOnchainRail(client?: OnchainClient): PaymentProvider {
  return createNetworkRail({
    id: "direct-onchain",
    rail: "onchain",
    reversibility: "irreversible",
    settlementFinality: "instant",
    defaultFinality: "final",
    client,
  });
}
