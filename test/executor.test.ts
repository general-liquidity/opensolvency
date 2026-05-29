import { test } from "node:test";
import assert from "node:assert/strict";

import { AuditLog } from "../src/core/audit.ts";
import { createExecutor } from "../src/core/executor.ts";
import { createMemoryStore } from "../src/store/memoryStore.ts";
import { createRailRegistry } from "../src/rails/registry.ts";
import { createFakeRail } from "../src/rails/fakeRail.ts";
import { DEFAULT_DENY_RULES } from "../src/core/denyList.ts";
import { DEFAULT_GATE_CONFIG, type Mandate, type PaymentIntent } from "../src/core/types.ts";
import type { Store } from "../src/core/store.ts";

const NOW = "2026-05-29T12:00:00.000Z";

function mandate(over: Partial<Mandate> = {}): Mandate {
  return {
    id: "m_groceries",
    label: "groceries",
    scope: { kind: "class", value: "groceries" },
    currency: "GBP",
    allowedRails: ["card"],
    perTxCap: 500_00,
    perPeriodCap: 1000_00,
    period: "week",
    grantedAt: "2026-05-26T00:00:00.000Z",
    expiresAt: "2026-06-26T00:00:00.000Z",
    status: "active",
    ...over,
  };
}

function intent(over: Partial<PaymentIntent> = {}): PaymentIntent {
  return {
    id: "pi_1",
    payee: "tesco",
    payeeClass: "groceries",
    amount: 80_00,
    currency: "GBP",
    rail: "card",
    rationale: "weekly grocery shop",
    createdAt: NOW,
    ...over,
  };
}

function harness(
  opts: {
    failSettle?: boolean;
    circuitBreakerThreshold?: number;
    challengeThresholdMinor?: number;
  } = {},
) {
  const store: Store = createMemoryStore("test-key");
  const audit = new AuditLog(store.operatorKey(), store.loadAudit());
  const rails = createRailRegistry([
    createFakeRail("card", { failOn: () => opts.failSettle === true }),
    createFakeRail("onchain"),
  ]);
  const executor = createExecutor({
    store,
    rails,
    audit,
    config: DEFAULT_GATE_CONFIG,
    denyRules: DEFAULT_DENY_RULES,
    clock: () => NOW,
    circuitBreakerThreshold: opts.circuitBreakerThreshold,
    challengeThresholdMinor: opts.challengeThresholdMinor,
  });
  return { store, audit, executor };
}

test("a known payee in a live mandate settles, and a receipt is written", async () => {
  const { store, executor } = harness();
  store.insertMandate(mandate());
  // Seed a prior settled payment so the payee is 'known' and not novel.
  store.insertIntent({
    intent: intent({ id: "pi_seed" }),
    status: "settled",
    mandateId: "m_groceries",
    reasons: [],
    settledAt: "2026-05-26T09:00:00.000Z",
    receiptId: "rcpt_pi_seed",
  });

  const r = await executor.execute(intent({ id: "pi_live" }));
  assert.equal(r.status, "settled");
  assert.ok(r.receipt);
  assert.equal(store.getReceipt(r.receipt.id)?.intentId, "pi_live");
});

test("an over-cap payment is blocked and never reaches the rail", async () => {
  const { store, executor } = harness();
  store.insertMandate(mandate());
  const r = await executor.execute(intent({ id: "pi_big", amount: 600_00 }));
  assert.equal(r.status, "blocked");
  assert.equal(r.receipt, null);
  assert.equal(store.getIntent("pi_big")?.status, "blocked");
});

test("a novel payee is parked pending, then settles on operator approval", async () => {
  const { store, executor } = harness();
  store.insertMandate(mandate());
  const r = await executor.execute(intent({ id: "pi_new", payee: "new-shop" }));
  assert.equal(r.status, "pending");
  assert.equal(r.receipt, null);

  const approved = await executor.approve("pi_new", "I vouch for new-shop");
  assert.equal(approved.status, "settled");
  assert.ok(approved.receipt);
  assert.equal(store.getIntent("pi_new")?.status, "settled");
});

test("a settlement failure is recorded as failed, not settled", async () => {
  const { store, executor } = harness({ failSettle: true });
  store.insertMandate(mandate());
  store.insertIntent({
    intent: intent({ id: "pi_seed" }),
    status: "settled",
    mandateId: "m_groceries",
    reasons: [],
    settledAt: "2026-05-26T09:00:00.000Z",
    receiptId: "rcpt_pi_seed",
  });
  const r = await executor.execute(intent({ id: "pi_fail" }));
  assert.equal(r.status, "failed");
  assert.equal(r.receipt, null);
});

test("every executor action lands in a verifiable audit chain", async () => {
  const { store, audit, executor } = harness();
  store.insertMandate(mandate());
  await executor.execute(intent({ id: "pi_a", amount: 600_00 })); // blocked
  await executor.execute(intent({ id: "pi_b", payee: "new-shop" })); // pending
  await executor.approve("pi_b", "ok"); // settled

  assert.equal(audit.verify().valid, true);
  // gate.decision x3 (block, pending, approval) + payment.settled x1
  const types = audit.entries().map((e) => e.type);
  assert.equal(types.filter((t) => t === "gate.decision").length, 3);
  assert.equal(types.filter((t) => t === "payment.settled").length, 1);
  // The audit log persisted to the store mirrors the in-memory chain.
  assert.equal(store.loadAudit().length, audit.entries().length);
});

test("a hard block cannot be approved away", async () => {
  const { store, executor } = harness();
  store.insertMandate(mandate());
  // Manually park an over-cap intent as pending (simulating a stale pending row),
  // then confirm approval re-runs the gate and still refuses it.
  store.insertIntent({
    intent: intent({ id: "pi_overcap", amount: 600_00 }),
    status: "pending",
    mandateId: "m_groceries",
    reasons: ["(parked)"],
    settledAt: null,
    receiptId: null,
  });
  const r = await executor.approve("pi_overcap", "please just send it");
  assert.equal(r.status, "blocked");
  assert.equal(store.getIntent("pi_overcap")?.status, "blocked");
});

function seedKnown(store: Store) {
  store.insertIntent({
    intent: intent({ id: "pi_seed" }),
    status: "settled",
    mandateId: "m_groceries",
    reasons: [],
    settledAt: "2026-05-26T09:00:00.000Z",
    receiptId: "rcpt_pi_seed",
  });
}

test("the kill switch freezes all settlement until released", async () => {
  const { store, executor } = harness();
  store.insertMandate(mandate());
  seedKnown(store);

  executor.engageKillSwitch();
  const halted = await executor.execute(intent({ id: "pi_killed" }));
  assert.equal(halted.status, "blocked");
  assert.ok(halted.decision.reasons.some((r) => r.includes("kill switch")));
  assert.equal(halted.receipt, null);

  executor.disengageKillSwitch();
  const ok = await executor.execute(intent({ id: "pi_after" }));
  assert.equal(ok.status, "settled");
});

test("the circuit breaker trips after consecutive blocks and freezes execution", async () => {
  const { executor, store } = harness({ circuitBreakerThreshold: 2 });
  store.insertMandate(mandate());
  await executor.execute(intent({ id: "b1", amount: 600_00 })); // block → 1
  await executor.execute(intent({ id: "b2", amount: 600_00 })); // block → 2 (open)
  assert.equal(executor.isCircuitBreakerOpen(), true);

  const halted = await executor.execute(intent({ id: "b3" }));
  assert.equal(halted.status, "blocked");
  assert.ok(halted.decision.reasons.some((r) => r.includes("circuit breaker")));

  executor.resetCircuitBreaker();
  assert.equal(executor.isCircuitBreakerOpen(), false);
});

test("a settled payment is read back and verified", async () => {
  const { store, executor, audit } = harness();
  store.insertMandate(mandate());
  seedKnown(store);
  const r = await executor.execute(intent({ id: "pi_verify" }));
  assert.equal(r.status, "settled");
  assert.equal(r.verified, true);
  assert.ok(audit.entries().some((e) => e.type === "payment.verified"));
});

test("approving a high-value pending intent requires acknowledgement", async () => {
  const { store, executor } = harness({ challengeThresholdMinor: 100 });
  store.insertMandate(mandate());
  const pending = await executor.execute(intent({ id: "pi_chal", payee: "new-shop" }));
  assert.equal(pending.status, "pending");

  const withheld = await executor.approve("pi_chal", "looks fine");
  assert.equal(withheld.status, "pending");
  assert.ok(withheld.challenge && withheld.challenge.length > 0);

  const acked = await executor.approve("pi_chal", "I confirm new-shop", {
    acknowledged: true,
  });
  assert.equal(acked.status, "settled");
});
