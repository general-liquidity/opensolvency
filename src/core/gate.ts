// THE GATE — the single invariant the whole product is built to enforce:
//
//   An agent payment can AUTO-EXECUTE only inside a live operator mandate that
//   covers it, under its caps, below the risk/velocity thresholds, and clear of
//   the deny-list. Everything else routes to the operator or is blocked.
//
// This is a pure function. It is the harness invariant, NOT a tool-level
// convention the agent could forget to call (the FinancialClaw failure mode):
// the executor is wired so that NOTHING reaches a rail without a gate decision
// of `auto_execute`, or an operator confirm that the gate itself recorded.

import { classifySpendRisk } from "./risk.ts";
import { RAIL_REVERSIBILITY } from "./types.ts";
import type {
  GateContext,
  GateDecision,
  Mandate,
  PaymentIntent,
  PriorSpend,
  SpendRisk,
} from "./types.ts";

function isLiveMandate(m: Mandate, now: string): boolean {
  return m.status === "active" && m.expiresAt > now;
}

function covers(
  m: Mandate,
  intent: PaymentIntent,
  convert?: (amountMinor: number, from: string, to: string) => number | undefined,
): boolean {
  if (!m.allowedRails.includes(intent.rail)) return false;
  const scopeOk =
    m.scope.kind === "class"
      ? m.scope.value === intent.payeeClass
      : m.scope.values.includes(intent.payee);
  if (!scopeOk) return false;
  if (m.currency === intent.currency) return true;
  // Cross-currency: covered only if a rate is available to convert into the mandate.
  return convert ? convert(intent.amount, intent.currency, m.currency) !== undefined : false;
}

export function evaluateGate(
  intent: PaymentIntent,
  ctx: GateContext,
): GateDecision {
  const noRisk: SpendRisk = { tier: "none", score: 0, reasons: [] };

  const block = (
    reasons: string[],
    mandateId: string | null = null,
    suggestedFix?: import("./types.ts").SafeFix,
  ): GateDecision => ({
    outcome: "block",
    reasons,
    mandateId,
    risk: noRisk,
    remainingPeriodBudget: null,
    suggestedFix,
  });

  // 1. Boundary validation — never trust an unstructured intent.
  if (!Number.isInteger(intent.amount) || intent.amount <= 0) {
    return block(["amount must be a positive integer in minor-units"]);
  }
  if (intent.rationale.trim().length < ctx.config.minRationaleChars) {
    return block(
      [`rationale must be at least ${ctx.config.minRationaleChars} characters`],
      null,
      {
        code: "EXPAND_RATIONALE",
        message: `Add more details to rationale (must be at least ${ctx.config.minRationaleChars} characters)`,
      },
    );
  }

  // Reversibility of the provider that will settle this — injected by the
  // executor from the resolved rail, falling back to the RailKind's static value.
  const reversibility = ctx.reversibility ?? RAIL_REVERSIBILITY[intent.rail];

  // 2. Hard deny-list — unconditional, before any mandate or trust.
  for (const rule of ctx.denyRules) {
    if (rule.match(intent, { knownPayees: ctx.knownPayees, reversibility })) {
      return block(
        [`deny-list: ${rule.reason}`],
        null,
        {
          code: "DENY_LIST_BYPASS",
          message: "Payment is on a hard deny-list. Verify payee or request operator override.",
        },
      );
    }
  }

  // 3. Authority — there must be a live mandate that covers this payment.
  const mandate = ctx.mandates.find(
    (m) => isLiveMandate(m, ctx.now) && covers(m, intent, ctx.convert),
  );
  if (!mandate) {
    return {
      outcome: "confirm_operator",
      reasons: [
        "no live mandate covers this payment — operator authorization required",
      ],
      mandateId: null,
      risk: noRisk,
      remainingPeriodBudget: null,
      suggestedFix: {
        code: "GRANT_MANDATE",
        message: `Run 'agentworth mandate grant --label target --class ${intent.payeeClass} ...'`,
        parameters: { payeeClass: intent.payeeClass, payee: intent.payee },
      },
    };
  }

  // Spend attributable to the authorizing mandate in its current period — only
  // now that the mandate is selected can we score budget, velocity, and anomaly.
  const periodSpend: PriorSpend[] = ctx.periodSpendByMandate(mandate.id);
  const trust =
    ctx.trustOf?.(intent.payee) ??
    (ctx.knownPayees.has(intent.payee) ? "seen" : "new");
  const risk = classifySpendRisk(intent, {
    trust,
    periodSpend,
    config: ctx.config,
    reversibility,
    attestation: ctx.attestation,
    reputation: ctx.reputationOf?.(intent.payee),
  });

  // 4. Caps — the agent may never exceed the granted authority. Cross-currency
  //    payments are measured in the mandate's currency (covers() ensured a rate).
  const amountInMandate =
    mandate.currency === intent.currency
      ? intent.amount
      : (ctx.convert?.(intent.amount, intent.currency, mandate.currency) ?? intent.amount);
  if (amountInMandate > mandate.perTxCap) {
    return {
      outcome: "block",
      reasons: [
        `amount ${amountInMandate} ${mandate.currency} exceeds per-transaction ` +
          `cap ${mandate.perTxCap}`,
      ],
      mandateId: mandate.id,
      risk,
      remainingPeriodBudget: null,
      suggestedFix: {
        code: "INCREASE_TX_CAP",
        message: `Exceeds per-transaction limit of ${mandate.perTxCap} ${mandate.currency}. Request operator to increase cap or split payment.`,
        parameters: { mandateId: mandate.id, limit: mandate.perTxCap },
      },
    };
  }
  const spent = periodSpend.reduce((sum, s) => sum + s.amount, 0);
  const remaining = mandate.perPeriodCap - spent - amountInMandate;
  if (remaining < 0) {
    return {
      outcome: "block",
      reasons: [
        `amount ${intent.amount} would exceed the ${mandate.period} budget ` +
          `(${spent} already spent of ${mandate.perPeriodCap})`,
      ],
      mandateId: mandate.id,
      risk,
      remainingPeriodBudget: null,
      suggestedFix: {
        code: "INCREASE_PERIOD_CAP",
        message: `Exceeds period budget (${spent} spent of ${mandate.perPeriodCap}). Request operator to increase period cap.`,
        parameters: { mandateId: mandate.id, limit: mandate.perPeriodCap, spent },
      },
    };
  }

  // 5. Within authority, but elevated signals route to the operator rather than
  //    auto-executing. A novel payee is never silently paid.
  const reasons: string[] = [];
  if (trust === "new") reasons.push("new payee");

  const windowStart = new Date(
    new Date(ctx.now).getTime() - ctx.config.velocityWindowMinutes * 60_000,
  ).toISOString();
  const recentCount = periodSpend.filter((s) => s.at >= windowStart).length;
  if (recentCount >= ctx.config.velocityMaxCount) {
    reasons.push(
      `velocity ceiling: ${recentCount} payments in the last ` +
        `${ctx.config.velocityWindowMinutes}m`,
    );
  }

  if (risk.tier === "high") reasons.push("elevated spend-risk");

  if (reasons.length > 0) {
    return {
      outcome: "confirm_operator",
      reasons,
      mandateId: mandate.id,
      risk,
      remainingPeriodBudget: remaining,
      suggestedFix: {
        code: "CONFIRM_OPERATOR",
        message: `Requires operator confirmation. Ask operator to approve intent ID ${intent.id}.`,
        parameters: { intentId: intent.id },
      },
    };
  }

  // 6. Covered, capped, low-risk → the agent may pay autonomously.
  return {
    outcome: "auto_execute",
    reasons: ["within live mandate, under caps, low risk"],
    mandateId: mandate.id,
    risk,
    remainingPeriodBudget: remaining,
  };
}

export { isLiveMandate, covers };
