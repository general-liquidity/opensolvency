// Network reputation — a payee's standing across the wider agentic economy
// (Base/x402 sellers, etc.), distinct from the operator's own per-payee trust
// trajectory. It's an INJECTED input (the live source is a reputation API/feed),
// fed into the gate's risk: a flagged payee is riskier, a good one less so. Like
// every other signal, it informs risk and NEVER relaxes the floor.

import type { ReputationLevel } from "./types.ts";

export interface ReputationSource {
  reputation(payee: string): ReputationLevel | undefined;
}

export const noReputation: ReputationSource = {
  reputation: () => undefined,
};

export function staticReputationSource(
  records: Record<string, ReputationLevel>,
): ReputationSource {
  return { reputation: (payee) => records[payee] };
}
