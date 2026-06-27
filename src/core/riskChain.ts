import type { AuditEntry } from "./audit.ts";
import type { PaymentIntent } from "./types.ts";

export interface RiskChainAlert {
  triggered: boolean;
  type: "NONE" | "SMURFING" | "PROBING";
  reason?: string;
}

/**
 * Stateful risk-chain tracker that inspects recent audit logs to identify
 * multi-step spend exfiltration patterns (smurfing or mandate probing).
 */
export function evaluateRiskChain(
  intent: PaymentIntent,
  entries: readonly AuditEntry[],
  opts: { isStreaming?: boolean; windowMinutes?: number } = {},
): RiskChainAlert {
  const windowMinutes = opts.windowMinutes ?? 15;
  const nowMs = new Date(intent.createdAt).getTime();
  const windowMs = windowMinutes * 60 * 1000;
  const startMs = nowMs - windowMs;

  // Filter gate decisions in the window
  const recentDecisions = entries
    .filter((e) => e.type === "gate.decision" && new Date(e.ts).getTime() >= startMs)
    .map((e) => e.payload as any)
    .filter((p) => p && typeof p === "object" && p.intent);

  // 1. Micropayment Slicing / Smurfing detection (bypassed for streaming mandates):
  if (!opts.isStreaming) {
    const samePayeeDecisions = recentDecisions.filter(
      (d) => d.intent.payee === intent.payee && d.outcome === "auto_execute",
    );

    if (samePayeeDecisions.length >= 3) {
      const totalAmount =
        samePayeeDecisions.reduce((sum, d) => sum + d.intent.amount, 0) + intent.amount;
      return {
        triggered: true,
        type: "SMURFING",
        reason:
          `Smurfing/Slicing alert: ${samePayeeDecisions.length + 1} auto-executed payments ` +
          `to "${intent.payee}" within ${windowMinutes}m, totaling ${totalAmount} minor-units.`,
      };
    }
  }

  // 2. Mandate Bypass Probing:
  // Detect if the agent is repeatedly testing different payees/classes to find active mandates
  const nonAllowedDecisions = recentDecisions.filter(
    (d) => d.outcome === "block" || d.outcome === "confirm_operator",
  );
  const distinctPayees = new Set(nonAllowedDecisions.map((d) => d.intent.payee));
  distinctPayees.add(intent.payee);

  if (nonAllowedDecisions.length >= 4 && distinctPayees.size >= 2) {
    return {
      triggered: true,
      type: "PROBING",
      reason:
        `Probing/Scan alert: ${nonAllowedDecisions.length} blocked or pending payment intents ` +
        `across ${distinctPayees.size} distinct payees within ${windowMinutes}m.`,
    };
  }

  return { triggered: false, type: "NONE" };
}
