// "Watching your back" — transformed. Earlier tools monitored spending and pushed
// personalised, non-punitive notifications. Here it produces structured CONCERNS
// the agent acts on (propose a move/mandate, gated as usual) rather than nagging
// the user. Concerns are facts + a non-punitive suggested action; the
// communication layer decides tone (anxiety-aware). Detection ≠ delivery.

import type { FinancialProfile } from "./profile.ts";
import type { RailKind } from "../core/types.ts";
import { findOptimizations, toConcerns, type MarketRates } from "./optimizations.ts";

export interface SpendObservation {
  amountMinor: number;
  payeeClass: string;
  rail: RailKind;
  highCostCredit?: boolean;
  at: string; // ISO
}

export type ConcernKind =
  | "high_cost_credit_reliance"
  | "essential_overspend"
  | "buffer_erosion"
  | "subscription_creep";

export type Severity = "low" | "medium" | "high";

export interface Concern {
  kind: ConcernKind;
  severity: Severity;
  reason: string;
  /** Framed as an agent action, never a reprimand. */
  suggestion: string;
}

const SUBSCRIPTION_CREEP_THRESHOLD = 3;

export function watchSpending(
  recent: SpendObservation[],
  profile: FinancialProfile,
  market?: MarketRates,
): Concern[] {
  const concerns: Concern[] = [];

  const highCost = recent.filter((s) => s.highCostCredit);
  if (highCost.length >= 1) {
    concerns.push({
      kind: "high_cost_credit_reliance",
      severity: highCost.length >= 3 ? "high" : highCost.length === 2 ? "medium" : "low",
      reason: `${highCost.length} recent payment(s) used high-cost credit`,
      suggestion:
        "offer to consolidate and set up a plan to move off high-cost credit",
    });
  }

  const total = recent.reduce((sum, s) => sum + s.amountMinor, 0);
  if (profile.monthlyIncomeMinor > 0 && total > profile.monthlyIncomeMinor) {
    concerns.push({
      kind: "essential_overspend",
      severity: total > profile.monthlyIncomeMinor * 1.25 ? "high" : "medium",
      reason: "recent spending has exceeded a month's income",
      suggestion: "propose a lighter-touch budget for the rest of the period",
    });
  }

  // Buffer erosion: little cushion AND drawing it down with recent spend.
  const bufferMonths =
    profile.monthlyEssentialSpendMinor > 0
      ? profile.liquidSavingsMinor / profile.monthlyEssentialSpendMinor
      : profile.liquidSavingsMinor > 0
        ? 6
        : 0;
  if (bufferMonths < 1 && total > 0) {
    concerns.push({
      kind: "buffer_erosion",
      severity: bufferMonths < 0.25 ? "high" : "medium",
      reason: "the emergency buffer is under a month and being drawn down",
      suggestion: "offer to ring-fence a small auto-save before the next spend",
    });
  }

  const subs = recent.filter((s) => s.payeeClass === "subscription").length;
  if (subs >= SUBSCRIPTION_CREEP_THRESHOLD) {
    concerns.push({
      kind: "subscription_creep",
      severity: "low",
      reason: `${subs} subscription charges in the window`,
      suggestion: "offer a quick review of recurring subscriptions",
    });
  }

  // "Free money" the operator is leaving on the table — idle cash vs inflation,
  // unswitched bonuses, unused ISA/LISA, scam/FOMO guards. Surfaced through the same
  // non-punitive concern stream when a market source is supplied (else skipped).
  if (market) {
    concerns.push(...toConcerns(findOptimizations(profile, market)));
  }

  return concerns;
}
