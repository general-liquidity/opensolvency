// THE EXECUTOR — the only path from a PaymentIntent to a rail.
//
// Every value-moving call funnels through here. The executor builds the gate
// context from the store, runs the pure gate, records the decision to the
// signed audit log, and ONLY settles on `auto_execute` (or on an operator
// `approve`). A rail's `settle` is never reachable any other way.
//
// Harness-engineering refinements layered on the gate:
//  - KILL SWITCH: an operator flag the agent cannot write, checked before any
//    settlement. When engaged, nothing settles.
//  - CIRCUIT BREAKER: trips after N consecutive blocks/failures and freezes
//    auto-execution until the operator resets it (doom-loop / attack containment).
//  - READ-BACK VERIFICATION: after settling, the receipt is verified with the
//    provider and a `payment.verified` event is recorded (propose→commit→verify).
//  - CHALLENGE-RESPONSE: approving a high-risk pending intent requires an explicit
//    acknowledgement, not a bare rationale (anti-rubber-stamp; EU AI Act Art. 14).

import type { AuditLog, AuditEventType } from "./audit.ts";
import { evaluateGate } from "./gate.ts";
import { evaluateRiskChain } from "./riskChain.ts";
import {
  computeContextDigest,
  computePolicyHash,
  effectivePolicy,
  type ReplayInputs,
} from "./enforcement.ts";
import { payeeTrust } from "./trust.ts";
import { convertMinorCrossDecimal, type FxRateSource } from "./fx.ts";
import type { ReputationSource } from "./reputation.ts";
import { RAIL_REVERSIBILITY } from "./types.ts";
import { noopTracer, type Tracer } from "../obs/tracer.ts";
import { noopNotifier, approvalNotification, type Notifier } from "../notify/notifier.ts";
import type { Store, IntentStatus } from "./store.ts";
import type { RailRegistry } from "../rails/registry.ts";
import type {
  Attestation,
  DenyRule,
  GateConfig,
  GateContext,
  GateDecision,
  Mandate,
  PaymentIntent,
  Receipt,
  SpendRisk,
} from "./types.ts";

export interface RefundResult {
  intentId: string;
  ok: boolean;
  refundedMinor: number;
  reason?: string;
}

const KILL_KEY = "kill_switch";
const FAIL_KEY = "consecutive_failures";
const NO_RISK: SpendRisk = { tier: "none", score: 0, reasons: [] };

export interface ExecutorDeps {
  store: Store;
  rails: RailRegistry;
  audit: AuditLog;
  config: GateConfig;
  denyRules: DenyRule[];
  clock: () => string;
  /** Consecutive blocks/failures before the circuit breaker trips (default 4). */
  circuitBreakerThreshold?: number;
  /** Pending intents at/above this amount require challenge-response on approve
   * (default 100000 minor-units). High risk or irreversible always require it. */
  challengeThresholdMinor?: number;
  /** Optional observability sink (OTel, etc.); defaults to no-op. */
  tracer?: Tracer;
  /** Optional out-of-band operator notifier, pinged when a payment needs
   * confirmation. Best-effort — never blocks or alters a gate decision. */
  notifier?: Notifier;
  /** Optional durability barrier, awaited after each payment operation so the
   * operation's writes are durable before it resolves. Async stores (Postgres)
   * wire this to their `flush`; synchronous stores (memory/sqlite) omit it. */
  commit?: () => Promise<void>;
  /** Optional FX rates; enables cross-currency payments against a mandate. */
  fxRates?: FxRateSource;
  /** Optional network reputation source; feeds the gate's risk. */
  reputation?: ReputationSource;
}

export interface ExecuteResult {
  intentId: string;
  status: IntentStatus;
  decision: GateDecision;
  receipt: Receipt | null;
  /** Result of the post-settle read-back; null unless a settlement was attempted. */
  verified: boolean | null;
  /** Set when an approval is withheld pending operator acknowledgement. */
  challenge?: string[];
}

export function createExecutor(deps: ExecutorDeps) {
  const breakerThreshold = deps.circuitBreakerThreshold ?? 4;
  const challengeThreshold = deps.challengeThresholdMinor ?? 100_000;
  const tracer = deps.tracer ?? noopTracer;
  const notifier = deps.notifier ?? noopNotifier;
  const commit = deps.commit ?? (() => Promise.resolve());

  // Run a money-moving operation, then make its writes durable before resolving.
  // `finally` guarantees the barrier runs on every path (settled/pending/blocked/
  // throw); a synchronous store's commit is a no-op, so this is free for them.
  async function withCommit<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } finally {
      await commit();
    }
  }

  function context(
    now: string,
    intent: PaymentIntent,
    attestation?: Attestation,
    reputation = deps.reputation?.reputation(intent.payee),
  ): GateContext {
    const provider = deps.rails.get(intent.rail);
    return {
      now,
      mandates: deps.store.listActiveMandates(now),
      periodSpendByMandate: (id) => deps.store.periodSpend(id, now),
      knownPayees: deps.store.knownPayees(),
      trustOf: (payee) => payeeTrust(deps.store.payeeSettledCount(payee)),
      convert: deps.fxRates
        ? (amount, from, to) => {
            const r = deps.fxRates?.rate(from, to);
            return r === undefined
              ? undefined
              : convertMinorCrossDecimal(amount, r, from, to);
          }
        : undefined,
      attestation,
      reputationOf: reputation !== undefined ? () => reputation : undefined,
      denyRules: deps.denyRules,
      config: deps.config,
      reversibility: provider?.capabilities.reversibility,
    };
  }

  function record(type: AuditEventType, payload: unknown, ts: string): void {
    // Every gate decision is stamped with the policyHash it was evaluated under, so the
    // signed audit chain itself proves *which policy each decision ran under* — the
    // emitter half of Proof-of-Enforcement (a counterparty can replay a sampled decision
    // and confirm the gate enforces the disclosed policy).
    const entry =
      type === "gate.decision"
        ? deps.audit.appendGateDecision(
            payload as Record<string, unknown>,
            computePolicyHash(
              effectivePolicy({ store: deps.store, config: deps.config, denyRules: deps.denyRules }),
            ),
            ts,
          )
        : deps.audit.append(type, payload, ts);
    deps.store.appendAudit(entry);
    const attrs =
      payload && typeof payload === "object"
        ? (payload as Record<string, unknown>)
        : { value: payload };
    tracer.event(type, { ts, ...attrs });
  }

  // --- kill switch + circuit breaker (operator-controlled, agent cannot write) ---
  const isKilled = () => deps.store.getMeta(KILL_KEY) === "1";
  const failures = () => Number(deps.store.getMeta(FAIL_KEY) ?? "0");
  const breakerOpen = () => failures() >= breakerThreshold;
  function recordOutcome(kind: "ok" | "bad"): void {
    deps.store.setMeta(FAIL_KEY, kind === "ok" ? "0" : String(failures() + 1));
  }
  function haltReason(): string | null {
    if (isKilled()) return "kill switch engaged";
    if (breakerOpen()) {
      return `circuit breaker open (${failures()} consecutive blocks/failures)`;
    }
    return null;
  }
  function haltDecision(reason: string): GateDecision {
    return {
      outcome: "block",
      reasons: [`halted: ${reason}`],
      mandateId: null,
      risk: NO_RISK,
      remainingPeriodBudget: null,
    };
  }

  // Move the money for an already-authorized intent, then read it back. Halts and
  // gate decisions are handled by the callers — this only runs after authorization.
  async function settle(
    intent: PaymentIntent,
    now: string,
  ): Promise<{ receipt: Receipt; verified: boolean } | { error: string }> {
    const provider = deps.rails.get(intent.rail);
    if (!provider) return { error: `no provider registered for rail ${intent.rail}` };
    try {
      const receipt = await provider.settle(intent, now);
      deps.store.insertReceipt(receipt);
      record(
        "payment.settled",
        {
          intentId: intent.id,
          receiptId: receipt.id,
          amount: intent.amount,
          currency: intent.currency,
          rail: intent.rail,
        },
        receipt.settledAt,
      );
      // Read-back: confirm the rail actually issued this receipt.
      const verified = provider.verifyReceipt(receipt);
      record(
        "payment.verified",
        { intentId: intent.id, receiptId: receipt.id, ok: verified },
        receipt.settledAt,
      );
      return { receipt, verified };
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      record("payment.failed", { intentId: intent.id, error }, now);
      return { error };
    }
  }

  async function execute(
    intent: PaymentIntent,
    opts: { attestation?: Attestation } = {},
  ): Promise<ExecuteResult> {
    const now = deps.clock();

    const halt = haltReason();
    if (halt) {
      record("payment.halted", { intentId: intent.id, phase: "agent", reason: halt }, now);
      const decision = haltDecision(halt);
      deps.store.insertIntent({
        intent,
        status: "blocked",
        mandateId: null,
        reasons: decision.reasons,
        settledAt: null,
        receiptId: null,
      });
      return { intentId: intent.id, status: "blocked", decision, receipt: null, verified: null };
    }

    const reputation = deps.reputation?.reputation(intent.payee);
    let decision = evaluateGate(
      intent,
      context(now, intent, opts.attestation, reputation),
    );

    // Check if the authorizing mandate is a streaming mandate (period === "day")
    let isStreaming = false;
    if (decision.mandateId) {
      const mand = deps.store.getMandate(decision.mandateId);
      if (mand?.period === "day") {
        isStreaming = true;
      }
    }

    // Evaluate session-level risk chains from the audit logs
    const chainAlert = evaluateRiskChain(intent, deps.audit.entries(), { isStreaming, now });
    if (chainAlert.triggered) {
      if (decision.outcome === "auto_execute") {
        decision = {
          ...decision,
          outcome: "confirm_operator",
          reasons: [...decision.reasons, `RiskChain: ${chainAlert.reason}`],
          suggestedFix: {
            code: "CONFIRM_OPERATOR",
            message: `Requires operator confirmation due to multi-step risk alerts.`,
            parameters: { type: chainAlert.type, reason: chainAlert.reason },
          },
        };
      } else {
        decision = {
          ...decision,
          reasons: [...decision.reasons, `RiskChain: ${chainAlert.reason}`],
        };
      }
    }

    const activeMandates = deps.store.listActiveMandates(now);
    const fxRates = Object.fromEntries(
      activeMandates.flatMap((mandate) => {
        if (!deps.fxRates || mandate.currency === intent.currency) return [];
        const rate = deps.fxRates.rate(intent.currency, mandate.currency);
        return rate === undefined ? [] : [[`${intent.currency}/${mandate.currency}`, rate]];
      }),
    );
    const replayInputs: ReplayInputs = {
      reversibility:
        deps.rails.get(intent.rail)?.capabilities.reversibility ??
        RAIL_REVERSIBILITY[intent.rail],
      trust: payeeTrust(deps.store.payeeSettledCount(intent.payee)),
      knownPayees: [...deps.store.knownPayees()].sort(),
      periodSpendByMandate: Object.fromEntries(
        activeMandates.map((mandate) => [
          mandate.id,
          deps.store.periodSpend(mandate.id, now),
        ]),
      ),
      ...(opts.attestation !== undefined ? { attestation: opts.attestation } : {}),
      ...(reputation !== undefined ? { reputation } : {}),
      ...(Object.keys(fxRates).length > 0 ? { fxRates } : {}),
    };
    // Snapshot the intent + the decision inputs so the audit chain can be REPLAYED
    // deterministically against a candidate mandate set (PayGraph's policy-snapshot
    // insight). The external inputs (reversibility/attestation/reputation/trust) are
    // captured as-of-decision; replay varies the mandates/config, holding these fixed.
    record(
      "gate.decision",
      {
        intentId: intent.id,
        phase: "agent",
        outcome: decision.outcome,
        reasons: decision.reasons,
        mandateId: decision.mandateId,
        riskTier: decision.risk.tier,
        verdict: decision,
        ctxDigest: computeContextDigest(replayInputs),
        intent: {
          id: intent.id,
          payee: intent.payee,
          payeeClass: intent.payeeClass,
          amount: intent.amount,
          currency: intent.currency,
          rail: intent.rail,
          rationale: intent.rationale,
          createdAt: intent.createdAt,
        },
        inputs: replayInputs,
      },
      now,
    );

    if (decision.outcome === "block") {
      deps.store.insertIntent({
        intent,
        status: "blocked",
        mandateId: decision.mandateId,
        reasons: decision.reasons,
        settledAt: null,
        receiptId: null,
      });
      recordOutcome("bad");
      return { intentId: intent.id, status: "blocked", decision, receipt: null, verified: null };
    }

    if (decision.outcome === "confirm_operator") {
      deps.store.insertIntent({
        intent,
        status: "pending",
        mandateId: decision.mandateId,
        reasons: decision.reasons,
        settledAt: null,
        receiptId: null,
      });
      // Best-effort out-of-band ping so the operator doesn't have to poll. Fired
      // and not awaited: a slow/failing notifier must never delay or change the
      // result. Its own errors are swallowed inside notify().
      void notifier.notify(approvalNotification(intent, decision, now));
      return { intentId: intent.id, status: "pending", decision, receipt: null, verified: null };
    }

    const outcome = await settle(intent, now);
    if ("error" in outcome) {
      deps.store.insertIntent({
        intent,
        status: "failed",
        mandateId: decision.mandateId,
        reasons: [outcome.error],
        settledAt: null,
        receiptId: null,
      });
      recordOutcome("bad");
      return { intentId: intent.id, status: "failed", decision, receipt: null, verified: null };
    }
    deps.store.insertIntent({
      intent,
      status: "settled",
      mandateId: decision.mandateId,
      reasons: decision.reasons,
      settledAt: outcome.receipt.settledAt,
      receiptId: outcome.receipt.id,
    });
    recordOutcome("ok");
    return {
      intentId: intent.id,
      status: "settled",
      decision,
      receipt: outcome.receipt,
      verified: outcome.verified,
    };
  }

  function challengeFor(intent: PaymentIntent, decision: GateDecision): string[] {
    const q = [
      `Confirm you recognise the payee "${intent.payee}" and intend to pay ` +
        `${intent.amount} ${intent.currency}.`,
    ];
    const reversibility =
      deps.rails.get(intent.rail)?.capabilities.reversibility ??
      RAIL_REVERSIBILITY[intent.rail];
    if (reversibility === "irreversible") {
      q.push("This settles IRREVERSIBLY — confirm you accept it cannot be clawed back.");
    }
    if (decision.risk.tier === "high") {
      q.push(`Risk is elevated (${decision.risk.reasons.join("; ")}) — confirm anyway?`);
    }
    q.push("Confirm there is no safer alternative you'd prefer.");
    return q;
  }

  // Operator authorizes a previously-pending intent. The gate is re-run on current
  // state: a HARD block (deny-list/caps) cannot be approved away; a confirm-tier
  // reason is the operator's to override. High-risk intents additionally require an
  // explicit `acknowledged` (challenge-response), not a bare rationale.
  async function approve(
    intentId: string,
    operatorRationale: string,
    opts: { acknowledged?: boolean } = {},
  ): Promise<ExecuteResult> {
    const stored = deps.store.getIntent(intentId);
    if (!stored) throw new Error(`intent ${intentId} not found`);
    if (stored.status !== "pending") {
      throw new Error(`intent ${intentId} is ${stored.status}, not pending`);
    }
    const now = deps.clock();

    const halt = haltReason();
    if (halt) {
      record("payment.halted", { intentId, phase: "operator_approval", reason: halt }, now);
      return {
        intentId,
        status: "blocked",
        decision: haltDecision(halt),
        receipt: null,
        verified: null,
      };
    }

    const decision = evaluateGate(stored.intent, context(now, stored.intent));
    record(
      "gate.decision",
      {
        intentId,
        phase: "operator_approval",
        outcome: decision.outcome,
        operatorRationale,
        acknowledged: opts.acknowledged === true,
        reasons: decision.reasons,
        mandateId: decision.mandateId,
      },
      now,
    );

    if (decision.outcome === "block") {
      deps.store.updateIntent(intentId, { status: "blocked", reasons: decision.reasons });
      recordOutcome("bad");
      return { intentId, status: "blocked", decision, receipt: null, verified: null };
    }

    // Challenge-response: high-risk / irreversible / large needs explicit ack.
    const reversibility =
      deps.rails.get(stored.intent.rail)?.capabilities.reversibility ??
      RAIL_REVERSIBILITY[stored.intent.rail];
    const requiresChallenge =
      decision.risk.tier === "high" ||
      reversibility === "irreversible" ||
      stored.intent.amount >= challengeThreshold;
    if (requiresChallenge && opts.acknowledged !== true) {
      return {
        intentId,
        status: "pending",
        decision,
        receipt: null,
        verified: null,
        challenge: challengeFor(stored.intent, decision),
      };
    }

    const outcome = await settle(stored.intent, now);
    if ("error" in outcome) {
      deps.store.updateIntent(intentId, { status: "failed", reasons: [outcome.error] });
      recordOutcome("bad");
      return { intentId, status: "failed", decision, receipt: null, verified: null };
    }
    deps.store.updateIntent(intentId, {
      status: "settled",
      settledAt: outcome.receipt.settledAt,
      receiptId: outcome.receipt.id,
    });
    recordOutcome("ok");
    return {
      intentId,
      status: "settled",
      decision,
      receipt: outcome.receipt,
      verified: outcome.verified,
    };
  }

  // Reverse a settled payment on a reversible rail and free the budget. Refusing
  // an irreversible refund is a safety property, not a limitation.
  async function refund(
    intentId: string,
    opts: { amountMinor?: number; reason?: string } = {},
  ): Promise<RefundResult> {
    const stored = deps.store.getIntent(intentId);
    if (!stored) throw new Error(`intent ${intentId} not found`);
    const already = stored.refundedMinor ?? 0;
    if (stored.status !== "settled") {
      return { intentId, ok: false, refundedMinor: already, reason: `not settled (${stored.status})` };
    }
    const provider = deps.rails.get(stored.intent.rail);
    if (!provider) return { intentId, ok: false, refundedMinor: already, reason: "no provider" };
    if (provider.capabilities.reversibility !== "reversible") {
      return { intentId, ok: false, refundedMinor: already, reason: "settlement is irreversible — cannot refund" };
    }
    if (!provider.refund) {
      return { intentId, ok: false, refundedMinor: already, reason: "rail does not support refunds" };
    }
    const amount = opts.amountMinor ?? stored.intent.amount - already;
    if (amount <= 0 || already + amount > stored.intent.amount) {
      return { intentId, ok: false, refundedMinor: already, reason: "invalid refund amount" };
    }
    const receipt = stored.receiptId ? deps.store.getReceipt(stored.receiptId) : undefined;
    if (!receipt) return { intentId, ok: false, refundedMinor: already, reason: "no receipt" };

    const now = deps.clock();
    const { refundRef } = await provider.refund(receipt, amount, now);
    const refundedMinor = already + amount;
    deps.store.updateIntent(intentId, { refundedMinor });
    record("payment.refunded", { intentId, amount, refundRef, reason: opts.reason }, now);
    return { intentId, ok: true, refundedMinor };
  }

  function amendMandate(id: string, patch: Partial<Mandate>): void {
    deps.store.updateMandate(id, patch);
    record("mandate.amended", { id, patch }, deps.clock());
  }
  function extendMandate(id: string, expiresAt: string): void {
    deps.store.updateMandate(id, { expiresAt });
    record("mandate.amended", { id, extendedTo: expiresAt }, deps.clock());
  }

  return {
    execute: (intent: PaymentIntent, opts?: { attestation?: Attestation }) =>
      withCommit(() => execute(intent, opts)),
    approve: (intentId: string, operatorRationale: string, opts?: { acknowledged?: boolean }) =>
      withCommit(() => approve(intentId, operatorRationale, opts)),
    refund: (intentId: string, opts?: { amountMinor?: number; reason?: string }) =>
      withCommit(() => refund(intentId, opts)),
    amendMandate,
    extendMandate,
    // Operator controls — NOT exposed to the agent as tools.
    engageKillSwitch: () => deps.store.setMeta(KILL_KEY, "1"),
    disengageKillSwitch: () => deps.store.setMeta(KILL_KEY, "0"),
    isKillSwitchEngaged: () => isKilled(),
    resetCircuitBreaker: () => deps.store.setMeta(FAIL_KEY, "0"),
    isCircuitBreakerOpen: () => breakerOpen(),
    consecutiveFailures: () => failures(),
  };
}

export type Executor = ReturnType<typeof createExecutor>;
