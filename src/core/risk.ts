// Spend-risk classifier. Re-domained from Gordon's 11-dimension riskClassifier:
// same "score several dimensions → tier" shape, dimensions swapped from
// trade-risk (vol-adjusted sizing, tail risk, MEV) to spend-risk.
//
// The gate decides what to DO with the tier; this module only computes it.

import type {
  Attestation,
  GateConfig,
  PaymentIntent,
  PriorSpend,
  ReputationLevel,
  Reversibility,
  SpendRisk,
} from "./types.ts";
import type { TrustLevel } from "./trust.ts";

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? Math.round((sorted[mid - 1] + sorted[mid]) / 2)
    : sorted[mid];
}

export function classifySpendRisk(
  intent: PaymentIntent,
  ctx: {
    trust: TrustLevel;
    periodSpend: PriorSpend[];
    config: GateConfig;
    reversibility: Reversibility;
    attestation?: Attestation;
    reputation?: ReputationLevel;
  },
): SpendRisk {
  const reasons: string[] = [];
  let score = 0;

  // Payee network reputation (when evaluated): flagged is riskier, good is less.
  if (ctx.reputation === "flagged") {
    score += 2;
    reasons.push("payee is flagged in network reputation");
  } else if (ctx.reputation === "good") {
    score -= 1;
    reasons.push("payee has good network reputation");
  }

  // Agent identity (when evaluated): an unverified agent is higher-risk; an
  // issuer-attested agent is lower. Undefined ⇒ not evaluated, no effect.
  if (ctx.attestation === "none") {
    score += 1;
    reasons.push("acting agent identity is unverified");
  } else if (ctx.attestation === "registry_attested") {
    score -= 1;
    reasons.push("acting agent is registry-attested");
  }

  const isNovelPayee = ctx.trust === "new";
  if (isNovelPayee) {
    score += 2;
    reasons.push("payee has no prior history");
  } else if (ctx.trust === "trusted") {
    score -= 1; // a repeatedly-paid payee is lower risk (deny-list/caps unaffected)
    reasons.push("trusted payee");
  }

  const baseline = median(ctx.periodSpend.map((s) => s.amount));
  if (baseline > 0 && intent.amount > baseline * ctx.config.anomalyMultiple) {
    score += 2;
    reasons.push(
      `amount is ${ctx.config.anomalyMultiple}x above the period median (${baseline} minor-units)`,
    );
  }

  if (ctx.reversibility === "irreversible" && isNovelPayee) {
    score += 1;
    reasons.push("irreversible settlement to a novel payee");
  }

  const tier: SpendRisk["tier"] =
    score >= 4 ? "high" : score >= 2 ? "medium" : score >= 1 ? "low" : "none";

  return { tier, score, reasons };
}
