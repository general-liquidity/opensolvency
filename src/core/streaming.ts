// Streaming / recurring mandates for micropayment rates (x402-style). A streaming
// mandate is an ordinary Mandate tuned for high-frequency, tiny payments: a small
// per-tx cap, a generous per-period cap, and a daily period that renews. The gate
// already contains a stream via two independent guards — the velocity ceiling
// (max payments per window) and the rolling period budget — so no new gate
// machinery is needed; this helper just encodes the preset, and the spike test
// (streaming.test.ts) proves the gate holds under burst load.

import type { Mandate, RailKind } from "./types.ts";

export interface StreamingMandateSpec {
  id: string;
  label: string;
  scope: Mandate["scope"];
  currency: string;
  grantedAt: string;
  expiresAt: string;
  rail?: RailKind; // default onchain (micropayments settle on-chain)
  perTxCapMinor?: number; // default 100 (e.g. $0.0001 USDC)
  perPeriodCapMinor?: number; // default 1_000_000 (e.g. $1 USDC/day)
}

export function streamingMandate(spec: StreamingMandateSpec): Mandate {
  return {
    id: spec.id,
    label: spec.label,
    scope: spec.scope,
    currency: spec.currency,
    allowedRails: [spec.rail ?? "onchain"],
    perTxCap: spec.perTxCapMinor ?? 100,
    perPeriodCap: spec.perPeriodCapMinor ?? 1_000_000,
    period: "day",
    grantedAt: spec.grantedAt,
    expiresAt: spec.expiresAt,
    status: "active",
  };
}
