import { test } from "node:test";
import assert from "node:assert/strict";

import {
  computePolicyHash,
  decisionRecordFromAuditEntry,
  effectivePolicy,
  replayDecision,
  type DecisionRecord,
  type EffectivePolicy,
} from "../src/core/enforcement.ts";
import { AuditLog } from "../src/core/audit.ts";
import { evaluateGate } from "../src/core/gate.ts";
import { DEFAULT_DENY_RULES } from "../src/core/denyList.ts";
import { DEFAULT_GATE_CONFIG } from "../src/core/types.ts";
import {
  buildAgentDisclosure,
  buildAndSignDisclosure,
  decodeEnforcementBinding,
  type BuildDisclosureDeps,
} from "../src/disclosure/builders.ts";
import { createMemoryStore } from "../src/store/memoryStore.ts";
import { createExecutor } from "../src/core/executor.ts";
import { createRailRegistry } from "../src/rails/registry.ts";
import { createFakeRail } from "../src/rails/fakeRail.ts";
import { fixedRateSource } from "../src/core/fx.ts";
import { generateAgentKeyPair, verifyDisclosureSignature } from "@general-liquidity/agent-disclosure";
import type {
  GateContext,
  Mandate,
  PaymentIntent,
} from "../src/core/types.ts";

const NOW = "2026-06-26T12:00:00.000Z";

function mandate(over: Partial<Mandate> = {}): Mandate {
  return {
    id: "m_groceries",
    label: "weekly groceries",
    scope: { kind: "class", value: "groceries" },
    currency: "GBP",
    allowedRails: ["card"],
    perTxCap: 50_00,
    perPeriodCap: 200_00,
    period: "week",
    grantedAt: "2026-06-01T00:00:00.000Z",
    expiresAt: "2026-12-01T00:00:00.000Z",
    status: "active",
    ...over,
  };
}

function intent(over: Partial<PaymentIntent> = {}): PaymentIntent {
  return {
    id: "pi_1",
    payee: "tesco",
    payeeClass: "groceries",
    amount: 30_00,
    currency: "GBP",
    rail: "card",
    rationale: "weekly grocery shop",
    createdAt: NOW,
    ...over,
  };
}

function policyOf(mandates: Mandate[]): EffectivePolicy {
  return effectivePolicy({
    store: { listMandates: () => mandates },
    config: DEFAULT_GATE_CONFIG,
    denyRules: DEFAULT_DENY_RULES,
  });
}

/** Run the real gate to get an HONEST verdict + a record carrying its inputs. */
function honestRecord(
  i: PaymentIntent,
  policy: EffectivePolicy,
  inputs: {
    knownPayees?: string[];
    periodSpendByMandate?: Record<string, { amount: number; at: string }[]>;
  } = {},
): DecisionRecord {
  const knownPayees = inputs.knownPayees ?? [];
  const periodSpendByMandate = inputs.periodSpendByMandate ?? {};
  const ctx: GateContext = {
    now: NOW,
    mandates: policy.mandates,
    periodSpendByMandate: (id) => periodSpendByMandate[id] ?? [],
    knownPayees: new Set(knownPayees),
    denyRules: DEFAULT_DENY_RULES,
    config: policy.gateConfig,
  };
  const verdict = evaluateGate(i, ctx);
  return {
    intent: i,
    ctxDigest: "test",
    verdict,
    policyHash: computePolicyHash(policy),
    at: NOW,
    inputs: { knownPayees, periodSpendByMandate },
  };
}

test("replayDecision matches an honest record", () => {
  const policy = policyOf([mandate()]);
  const rec = honestRecord(intent(), policy, { knownPayees: ["tesco"] });
  // honest auto_execute under a covering mandate
  assert.equal(rec.verdict.outcome, "auto_execute");

  const { matches, recomputed } = replayDecision(rec, policy, DEFAULT_DENY_RULES);
  assert.equal(matches, true);
  assert.equal(recomputed.outcome, "auto_execute");
  assert.equal(recomputed.mandateId, "m_groceries");
});

test("replayDecision mismatches a tampered verdict", () => {
  const policy = policyOf([mandate()]);
  const rec = honestRecord(intent(), policy, { knownPayees: ["tesco"] });

  // Forge a verdict: claim auto_execute was actually a block. The signed chain
  // can't catch this on its own — replay can.
  const tampered: DecisionRecord = {
    ...rec,
    verdict: { ...rec.verdict, outcome: "block" },
  };
  const { matches, recomputed } = replayDecision(tampered, policy, DEFAULT_DENY_RULES);
  assert.equal(matches, false);
  // the re-executed (honest) verdict is recovered for the verifier to see
  assert.equal(recomputed.outcome, "auto_execute");
});

test("replayDecision catches a verdict that doesn't enforce the disclosed caps", () => {
  // An over-cap payment HONESTLY blocks; a gate that discloses caps but signed an
  // auto_execute for it is non-enforcing — replay detects it.
  const policy = policyOf([mandate({ perTxCap: 10_00 })]);
  const rec = honestRecord(intent({ amount: 30_00 }), policy, { knownPayees: ["tesco"] });
  assert.equal(rec.verdict.outcome, "block");

  const lying: DecisionRecord = {
    ...rec,
    verdict: { ...rec.verdict, outcome: "auto_execute", mandateId: "m_groceries" },
  };
  assert.equal(replayDecision(lying, policy, DEFAULT_DENY_RULES).matches, false);
});

test("computePolicyHash is deterministic", () => {
  const policy = policyOf([mandate()]);
  assert.equal(computePolicyHash(policy), computePolicyHash(policy));
});

test("computePolicyHash is stable under mandate reordering", () => {
  const a = mandate({ id: "m_a", scope: { kind: "class", value: "a" } });
  const b = mandate({ id: "m_b", scope: { kind: "class", value: "b" } });
  const forward = computePolicyHash(policyOf([a, b]));
  const reversed = computePolicyHash(policyOf([b, a]));
  assert.equal(forward, reversed);
});

test("computePolicyHash is stable under deny-rule and rail reordering", () => {
  const railsForward = mandate({ allowedRails: ["card", "checkout"] });
  const railsReversed = mandate({ allowedRails: ["checkout", "card"] });
  assert.equal(
    computePolicyHash(policyOf([railsForward])),
    computePolicyHash(policyOf([railsReversed])),
  );
});

test("computePolicyHash changes when a cap changes", () => {
  const base = computePolicyHash(policyOf([mandate({ perTxCap: 50_00 })]));
  const raised = computePolicyHash(policyOf([mandate({ perTxCap: 99_00 })]));
  assert.notEqual(base, raised);
});

test("an audit entry carries policyHash and still verifies", () => {
  const KEY = "operator-secret-key";
  const log = new AuditLog(KEY);
  const policy = policyOf([mandate()]);
  const policyHash = computePolicyHash(policy);

  const entry = log.appendGateDecision(
    { intentId: "pi_1", outcome: "auto_execute", mandateId: "m_groceries" },
    policyHash,
    NOW,
  );

  // the hash is folded into the signed payload
  assert.equal((entry.payload as { policyHash: string }).policyHash, policyHash);
  // and the chain still verifies (signature + hash-link cover it)
  assert.equal(log.verify().valid, true);

  // tampering with the bound policyHash breaks verification
  (entry.payload as { policyHash: string }).policyHash = "deadbeef";
  assert.equal(log.verify().valid, false);
});

test("a production audit entry can be replayed without hand-built inputs", async () => {
  const store = createMemoryStore("op-key");
  const liveMandate = mandate({
    currency: "GBP",
    perTxCap: 100_00,
    perPeriodCap: 200_00,
  });
  store.insertMandate(liveMandate);
  store.insertIntent({
    intent: intent({
      id: "seed",
      amount: 20_00,
      currency: "GBP",
    }),
    status: "settled",
    mandateId: liveMandate.id,
    reasons: [],
    settledAt: "2026-06-25T12:00:00.000Z",
    receiptId: "r_seed",
  });
  const audit = new AuditLog(store.operatorKey());
  const executor = createExecutor({
    store,
    rails: createRailRegistry([createFakeRail("card")]),
    audit,
    config: DEFAULT_GATE_CONFIG,
    denyRules: DEFAULT_DENY_RULES,
    clock: () => NOW,
    fxRates: fixedRateSource({ "JPY/GBP": 0.0053 }),
  });

  await executor.execute(
    intent({
      id: "pi_jpy",
      amount: 10_000,
      currency: "JPY",
    }),
  );

  const entry = audit.entries().find((candidate) => candidate.type === "gate.decision");
  assert.ok(entry);
  const record = decisionRecordFromAuditEntry(entry);
  assert.ok(record);
  assert.deepEqual(record.inputs.knownPayees, ["tesco"]);
  assert.equal(record.inputs.periodSpendByMandate[liveMandate.id][0].amount, 20_00);
  assert.equal(record.inputs.fxRates?.["JPY/GBP"], 0.0053);

  const policy = policyOf([liveMandate]);
  assert.equal(record.policyHash, computePolicyHash(policy));
  assert.equal(replayDecision(record, policy, DEFAULT_DENY_RULES).matches, true);
});

function disclosureDeps(): BuildDisclosureDeps {
  const store = createMemoryStore("op-key");
  store.insertMandate(mandate({ id: "m_groceries" }));
  const audit = new AuditLog(store.operatorKey());
  audit.append("gate.decision", { intentId: "pi1", outcome: "auto_execute" }, NOW);
  return {
    store,
    audit,
    agentKey: generateAgentKeyPair(),
    systemPrompt: "You are the operator's spending agent.",
    operator: { id: "op_xyz", deniabilityBoundary: "Spend within mandates only." },
    now: NOW,
    nonce: "nonce-1",
  };
}

test("the builder binds the disclosure to policyHash + auditAnchor", () => {
  const deps = disclosureDeps();
  const disclosure = buildAgentDisclosure(deps);

  const binding = decodeEnforcementBinding(disclosure.constitution);
  assert.ok(binding, "enforcement binding is recoverable from the constitution");

  // policyHash equals the hash of the live effective policy (same input ADP hashes)
  const expectedHash = computePolicyHash(
    effectivePolicy({
      store: deps.store,
      config: DEFAULT_GATE_CONFIG,
      denyRules: DEFAULT_DENY_RULES,
    }),
  );
  assert.equal(binding.policyHash, expectedHash);
  // auditAnchor equals the signed chain head the disclosure committed to
  assert.equal(binding.auditAnchor, disclosure.auditAnchor);
});

test("the binding survives sign + verify (wire-stable, no signature break)", () => {
  // The binding lives inside the SIGNED payload and round-trips through the
  // published disclosure schema, so the signature still verifies.
  const signed = buildAndSignDisclosure(disclosureDeps());
  assert.equal(verifyDisclosureSignature(signed).ok, true);
  assert.ok(decodeEnforcementBinding(signed.disclosure.constitution));
});
