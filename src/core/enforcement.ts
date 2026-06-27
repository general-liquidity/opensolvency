// PROOF-OF-ENFORCEMENT (PoE) — the keystone.
//
// ADP's `constitution.enforced: true` is, on its own, an assertion. This module
// turns it into a CRYPTOGRAPHICALLY FALSIFIABLE claim, backed by AgentWorth's
// deterministic, signed, hash-linked audit chain:
//
//   1. `effectivePolicy(deps)` snapshots the governing policy at decision time.
//   2. `computePolicyHash(policy)` hashes it via ADP's exported `canonicalize`
//      (RFC 8785 JCS) + node:crypto sha256 — so AgentWorth and ADP hash IDENTICALLY.
//   3. `replayDecision(record, policy)` re-runs the PURE `evaluateGate` over a
//      recorded decision's captured inputs under the disclosed policy and
//      compares to the signed verdict. A gate that does not enforce what it
//      discloses is now DETECTED, not just asserted.
//
// Determinism is load-bearing: replay must read no clock and do no I/O, so the
// DecisionRecord carries every input the gate consumed at decision time.

import { createHash } from "node:crypto";
import { canonicalize } from "@general-liquidity/agent-disclosure";

import { evaluateGate } from "./gate.ts";
import { convertMinorCrossDecimal } from "./fx.ts";
import type { AuditEntry } from "./audit.ts";
import type { Store } from "./store.ts";
import type {
  Attestation,
  DenyRule,
  GateConfig,
  GateContext,
  GateDecision,
  Mandate,
  PaymentIntent,
  PriorSpend,
  ReputationLevel,
  Reversibility,
} from "./types.ts";
import type { TrustLevel } from "./trust.ts";

/** The risk-relevant subset of the gate config, surfaced separately so the
 *  disclosed policy names the parameters that drive `classifySpendRisk`. */
export interface RiskConfig {
  velocityWindowMinutes: number;
  velocityMaxCount: number;
  anomalyMultiple: number;
}

/**
 * The effective governing policy at decision time — the exact thing the gate was
 * running. Hashing this binds a disclosure to the live gate. Arrays are NORMALIZED
 * (mandates sorted by id, denyRuleIds sorted) so the hash is stable under
 * reordering; only stable deny-rule `id`s are hashed, never their closures.
 */
export interface EffectivePolicy {
  mandates: Mandate[];
  gateConfig: GateConfig;
  denyRuleIds: string[];
  riskConfig: RiskConfig;
}

/**
 * A single recorded gate decision, anchored to the audit chain via `policyHash`.
 * Carries the captured inputs so `replayDecision` can rebuild a PURE GateContext
 * with no clock or I/O.
 */
export interface DecisionRecord {
  intent: PaymentIntent;
  /** digest of the decision inputs (reversibility/attestation/reputation/trust) */
  ctxDigest: string;
  verdict: GateDecision;
  policyHash: string;
  at: string; // ISO — the `now` the gate was evaluated at
  /** the inputs captured as-of-decision, so replay is deterministic */
  inputs: ReplayInputs;
}

/** The non-policy inputs the gate consumed, captured at decision time so replay
 *  holds them fixed while varying the disclosed policy. */
export interface ReplayInputs {
  reversibility?: Reversibility;
  attestation?: Attestation;
  reputation?: ReputationLevel;
  trust?: TrustLevel;
  /** payees with prior settled history at decision time (novelty check) */
  knownPayees: string[];
  /** spend attributable to each mandate in its current period, by mandate id */
  periodSpendByMandate: Record<string, PriorSpend[]>;
  /** major-unit FX rates used by the decision, keyed as `FROM/TO` */
  fxRates?: Record<string, number>;
}

/** What the live handshake returns and the disclosure builder embeds a
 *  commitment to: which policy is running, anchored to the signed audit head. */
export interface PoEAttestation {
  policyHash: string;
  /** the signed audit head the recent decisions are anchored to */
  auditHead: string;
  recentDecisions?: DecisionRecord[];
  generatedAt: string;
}

/** Snapshot the governing policy from the live runtime. The mandate set + gate
 *  config + deny-rule ids + risk config the gate was actually running. */
export function effectivePolicy(deps: {
  store: Pick<Store, "listMandates">;
  config: GateConfig;
  denyRules: DenyRule[];
}): EffectivePolicy {
  const mandates = [...deps.store.listMandates()].sort((a, b) =>
    a.id < b.id ? -1 : a.id > b.id ? 1 : 0,
  );
  const denyRuleIds = deps.denyRules.map((r) => r.id).sort();
  return {
    mandates,
    gateConfig: deps.config,
    denyRuleIds,
    riskConfig: {
      velocityWindowMinutes: deps.config.velocityWindowMinutes,
      velocityMaxCount: deps.config.velocityMaxCount,
      anomalyMultiple: deps.config.anomalyMultiple,
    },
  };
}

/**
 * Deterministic policy hash: sha256_hex(canonicalize(normalizedPolicy)).
 *
 * `canonicalize` is ADP's exported RFC-8785 JCS serializer, so AgentWorth and ADP hash
 * the SAME EffectivePolicy to the SAME bytes. Arrays are normalized first
 * (mandates by id, denyRuleIds sorted) so reordering does not change the hash;
 * mandate objects are projected to a stable field set so unrelated additions
 * don't silently shift the binding.
 */
export function computePolicyHash(policy: EffectivePolicy): string {
  const normalized = {
    mandates: [...policy.mandates]
      .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
      .map((m) => ({
        id: m.id,
        scope: m.scope,
        currency: m.currency,
        allowedRails: [...m.allowedRails].sort(),
        perTxCap: m.perTxCap,
        perPeriodCap: m.perPeriodCap,
        period: m.period,
        expiresAt: m.expiresAt,
        status: m.status,
      })),
    gateConfig: {
      minRationaleChars: policy.gateConfig.minRationaleChars,
      velocityWindowMinutes: policy.gateConfig.velocityWindowMinutes,
      velocityMaxCount: policy.gateConfig.velocityMaxCount,
      anomalyMultiple: policy.gateConfig.anomalyMultiple,
    },
    denyRuleIds: [...policy.denyRuleIds].sort(),
    riskConfig: {
      velocityWindowMinutes: policy.riskConfig.velocityWindowMinutes,
      velocityMaxCount: policy.riskConfig.velocityMaxCount,
      anomalyMultiple: policy.riskConfig.anomalyMultiple,
    },
  };
  return createHash("sha256").update(canonicalize(normalized)).digest("hex");
}

/** Stable commitment to the non-policy inputs captured for one decision. */
export function computeContextDigest(inputs: ReplayInputs): string {
  return createHash("sha256").update(canonicalize(inputs)).digest("hex");
}

/** Convert a production `gate.decision` audit entry into the replay shape. */
export function decisionRecordFromAuditEntry(
  entry: AuditEntry,
): DecisionRecord | undefined {
  if (entry.type !== "gate.decision" || !entry.payload || typeof entry.payload !== "object") {
    return undefined;
  }
  const payload = entry.payload as {
    phase?: string;
    intent?: PaymentIntent;
    verdict?: GateDecision;
    policyHash?: string;
    inputs?: ReplayInputs;
    ctxDigest?: string;
  };
  if (
    payload.phase !== "agent" ||
    !payload.intent ||
    !payload.verdict ||
    !payload.policyHash ||
    !payload.inputs
  ) {
    return undefined;
  }
  return {
    intent: payload.intent,
    verdict: payload.verdict,
    policyHash: payload.policyHash,
    at: entry.ts,
    inputs: payload.inputs,
    ctxDigest: payload.ctxDigest ?? computeContextDigest(payload.inputs),
  };
}

/**
 * Re-run the PURE gate over a recorded decision's captured inputs under the
 * disclosed policy and compare to the signed verdict. No clock, no I/O — fully
 * deterministic. The deny-rule predicates come from the live `policyDenyRules`
 * the verifier supplies; their ids are what the policy hash committed to.
 */
export function replayDecision(
  record: DecisionRecord,
  policy: EffectivePolicy,
  policyDenyRules: DenyRule[],
): { matches: boolean; recomputed: GateDecision } {
  const known = new Set(record.inputs.knownPayees);
  const ctx: GateContext = {
    now: record.at,
    mandates: policy.mandates,
    periodSpendByMandate: (id) => record.inputs.periodSpendByMandate[id] ?? [],
    knownPayees: known,
    trustOf: record.inputs.trust ? () => record.inputs.trust as TrustLevel : undefined,
    reputationOf: record.inputs.reputation
      ? () => record.inputs.reputation
      : undefined,
    convert: record.inputs.fxRates
      ? (amount, from, to) => {
          const rate = record.inputs.fxRates?.[`${from}/${to}`];
          return rate === undefined
            ? undefined
            : convertMinorCrossDecimal(amount, rate, from, to);
        }
      : undefined,
    attestation: record.inputs.attestation,
    denyRules: policyDenyRules,
    config: policy.gateConfig,
    reversibility: record.inputs.reversibility,
  };
  const recomputed = evaluateGate(record.intent, ctx);
  return { matches: verdictsEqual(recomputed, record.verdict), recomputed };
}

/** Structural verdict comparison — outcome + authorizing mandate + risk tier +
 *  remaining budget are the load-bearing fields; reason strings are not part of
 *  the enforcement claim (they're explanatory, not the decision). */
function verdictsEqual(a: GateDecision, b: GateDecision): boolean {
  return (
    a.outcome === b.outcome &&
    a.mandateId === b.mandateId &&
    a.risk.tier === b.risk.tier &&
    a.remainingPeriodBudget === b.remainingPeriodBudget
  );
}
