// AML structuring heuristic — an OPTIONAL ComplianceProvider that flags (never
// blocks) a classic "smurfing" pattern: a cluster of payments sized just under a
// reporting/scrutiny threshold within a window. This is a `flagged` source, so
// it raises spend-risk via reputationFromCompliance; the sanctions ListScreener
// stays the must-have block path. Pure: the caller injects the prior payments
// and `now`, like the rest of the kernel (no clock, no I/O).

import type { ComplianceProvider, ComplianceVerdict } from "./sanctions.ts";
import type { PaymentIntent, PriorSpend } from "../core/types.ts";

export interface StructuringOptions {
  /** the reporting/scrutiny threshold in minor-units (e.g. £10,000 = 1_000_000) */
  thresholdMinor: number;
  /** how far below the threshold still counts as "just under" (default 10%) */
  marginFraction?: number;
  /** window in minutes over which to count just-under payments (default 1440 = 24h) */
  windowMinutes?: number;
  /** count (incl. this intent) at/above which to flag (default 3) */
  minCount?: number;
  /** risk bump emitted on a flag (default 2) */
  riskBump?: number;
  id?: string;
}

/**
 * Flags structuring: this payment plus prior period payments are each "just
 * under" the threshold and there are enough of them in the window. The caller
 * supplies `now` and the relevant prior payments (the gate already fetches
 * per-mandate period spend); this provider stays pure.
 */
export function makeStructuringScreener(
  opts: StructuringOptions,
  ctx: { now: string; recentPayments: (intent: PaymentIntent) => PriorSpend[] },
): ComplianceProvider {
  const margin = opts.marginFraction ?? 0.1;
  const windowMs = (opts.windowMinutes ?? 1440) * 60_000;
  const minCount = opts.minCount ?? 3;
  const riskBump = opts.riskBump ?? 2;
  const lower = Math.floor(opts.thresholdMinor * (1 - margin));

  const justUnder = (amount: number) =>
    amount >= lower && amount < opts.thresholdMinor;

  return {
    id: opts.id ?? "aml-structuring",
    screen(intent: PaymentIntent): ComplianceVerdict {
      if (!justUnder(intent.amount)) return { status: "clear" };
      const windowStart = new Date(
        new Date(ctx.now).getTime() - windowMs,
      ).toISOString();
      const priorJustUnder = ctx
        .recentPayments(intent)
        .filter((s) => s.at >= windowStart && justUnder(s.amount)).length;
      const total = priorJustUnder + 1; // include this intent
      if (total >= minCount) {
        return {
          status: "flagged",
          riskBump,
          reasons: [
            `possible structuring: ${total} payments just under the ` +
              `${opts.thresholdMinor} threshold within the window`,
          ],
        };
      }
      return { status: "clear" };
    },
  };
}
