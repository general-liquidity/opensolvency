import { test } from "node:test";
import assert from "node:assert/strict";

import { AgentWorth, createMemoryStore } from "../src/sdk/index.ts";
import type { Mandate, PayeeScope } from "../src/sdk/index.ts";

const NOW = "2026-05-29T12:00:00.000Z";

// A fixed clock makes the whole SDK deterministic — the kernel never reads a
// clock itself, so every decision below is replayable.
function sdk(opts: { challengeThresholdMinor?: number } = {}) {
  return new AgentWorth({
    store: createMemoryStore("test-key"),
    simulation: true,
    clock: () => NOW,
    challengeThresholdMinor: opts.challengeThresholdMinor,
  });
}

const GROCERIES: PayeeScope = { kind: "class", value: "groceries" };

function grantGroceries(os: AgentWorth): Mandate {
  return os.grantMandate({
    label: "weekly groceries",
    scope: GROCERIES,
    currency: "GBP",
    allowedRails: ["card"],
    perTxCap: 500_00,
    perPeriodCap: 1000_00,
    period: "week",
    expiresAt: "2026-06-26T00:00:00.000Z",
  });
}

test("grantMandate records the mandate and a signed audit event", () => {
  const os = sdk();
  const m = grantGroceries(os);

  assert.equal(os.listMandates().length, 1);
  assert.equal(os.getMandate(m.id)?.label, "weekly groceries");
  assert.equal(m.status, "active");
  assert.equal(os.verifyAudit().valid, true);
  assert.ok(os.auditTimeline().some((e) => e.type === "mandate.granted"));
});

test("a known payee inside the mandate, under cap, low risk → auto-execute", async () => {
  const os = sdk();
  grantGroceries(os);

  // First payment to a new payee parks pending; approving it makes the payee
  // 'known' so the second auto-executes.
  const first = await os.pay({
    payee: "tesco",
    payeeClass: "groceries",
    amount: 80_00,
    currency: "GBP",
    rail: "card",
    rationale: "weekly grocery shop",
  });
  assert.equal(first.status, "pending");
  await os.approve(first.intentId, { rationale: "yes, I shop at tesco" });

  const second = await os.pay({
    payee: "tesco",
    payeeClass: "groceries",
    amount: 90_00,
    currency: "GBP",
    rail: "card",
    rationale: "another weekly grocery shop",
  });
  assert.equal(second.status, "settled");
  assert.equal(second.decision.outcome, "auto_execute");
  assert.ok(second.receipt);
  assert.equal(second.verified, true);
});

test("a new payee → pending (a novel payee is never silently paid)", async () => {
  const os = sdk();
  grantGroceries(os);

  const r = await os.pay({
    payee: "new-corner-shop",
    payeeClass: "groceries",
    amount: 40_00,
    currency: "GBP",
    rail: "card",
    rationale: "first time at this shop",
  });
  assert.equal(r.status, "pending");
  assert.equal(r.decision.outcome, "confirm_operator");
  assert.equal(r.receipt, null);
  assert.deepEqual(
    os.pending().map((s) => s.intent.id),
    [r.intentId],
  );
});

test("the SDK forwards notifier and tracer dependencies to the executor", async () => {
  const notifications: string[] = [];
  const events: string[] = [];
  const os = new AgentWorth({
    store: createMemoryStore("test-key"),
    simulation: true,
    clock: () => NOW,
    notifier: {
      async notify(notification) {
        notifications.push(notification.intentId);
      },
    },
    tracer: {
      event(name) {
        events.push(name);
      },
    },
  });
  grantGroceries(os);

  const result = await os.pay({
    id: "pi_notify",
    payee: "new-corner-shop",
    payeeClass: "groceries",
    amount: 40_00,
    currency: "GBP",
    rail: "card",
    rationale: "first time at this shop",
  });

  assert.equal(result.status, "pending");
  assert.deepEqual(notifications, ["pi_notify"]);
  assert.ok(events.includes("gate.decision"));
});

test("an unconfigured SDK fails closed instead of reporting a fake settlement", async () => {
  const os = new AgentWorth({
    store: createMemoryStore("test-key"),
    clock: () => NOW,
  });
  grantGroceries(os);
  os.store.insertIntent({
    intent: {
      id: "seed",
      payee: "tesco",
      payeeClass: "groceries",
      amount: 1,
      currency: "GBP",
      rail: "card",
      rationale: "operator-vetted payee",
      createdAt: NOW,
    },
    status: "settled",
    mandateId: os.listMandates()[0].id,
    reasons: [],
    settledAt: NOW,
    receiptId: "r_seed",
  });

  const result = await os.pay({
    payee: "tesco",
    payeeClass: "groceries",
    amount: 40_00,
    currency: "GBP",
    rail: "card",
    rationale: "weekly grocery shop",
  });

  assert.equal(result.status, "failed");
  assert.equal(result.receipt, null);
  assert.match(os.getIntent(result.intentId)?.reasons.join(" ") ?? "", /no provider/);
});

test("over-cap → block, and it never reaches a rail", async () => {
  const os = sdk();
  grantGroceries(os);

  const r = await os.pay({
    payee: "tesco",
    payeeClass: "groceries",
    amount: 600_00, // > £500 per-tx cap
    currency: "GBP",
    rail: "card",
    rationale: "huge grocery shop",
  });
  assert.equal(r.status, "blocked");
  assert.equal(r.decision.outcome, "block");
  assert.equal(r.receipt, null);
  assert.equal(os.getIntent(r.intentId)?.status, "blocked");
});

test("approve settles a pending intent", async () => {
  const os = sdk();
  grantGroceries(os);

  const pending = await os.pay({
    payee: "new-deli",
    payeeClass: "groceries",
    amount: 30_00,
    currency: "GBP",
    rail: "card",
    rationale: "lunch from the new deli",
  });
  assert.equal(pending.status, "pending");

  const approved = await os.approve(pending.intentId, {
    rationale: "I vouch for the new deli",
  });
  assert.equal(approved.status, "settled");
  assert.ok(approved.receipt);
  assert.equal(os.getIntent(pending.intentId)?.status, "settled");
  assert.equal(os.pending().length, 0);
});

test("a no-mandate payment routes to the operator, not auto-execute", async () => {
  const os = sdk();
  // No mandate granted at all.
  const r = await os.pay({
    payee: "tesco",
    payeeClass: "groceries",
    amount: 10_00,
    currency: "GBP",
    rail: "card",
    rationale: "ungoverned attempt",
  });
  assert.equal(r.status, "pending");
  assert.equal(r.decision.mandateId, null);
});

test("the deny-list blocks an irreversible send to an unknown payee", async () => {
  const os = sdk();
  os.grantMandate({
    label: "onchain saas",
    scope: { kind: "class", value: "saas" },
    currency: "USDC",
    allowedRails: ["onchain"],
    perTxCap: 1000_00,
    perPeriodCap: 5000_00,
    period: "month",
    expiresAt: "2026-12-31T00:00:00.000Z",
  });
  const r = await os.pay({
    payee: "unknown-wallet",
    payeeClass: "saas",
    amount: 200_00, // above the £50 irreversible-to-unknown floor
    currency: "USDC",
    rail: "onchain",
    rationale: "pay the new onchain service",
  });
  assert.equal(r.status, "blocked");
  assert.ok(r.decision.reasons.some((x) => x.includes("deny-list")));
});

test("a hard block cannot be approved away", async () => {
  const os = sdk();
  grantGroceries(os);
  // Park an over-cap intent pending, then confirm approval re-runs the gate.
  const big = await os.pay({
    payee: "new-shop",
    payeeClass: "groceries",
    amount: 40_00,
    currency: "GBP",
    rail: "card",
    rationale: "small first payment",
  });
  assert.equal(big.status, "pending");
  // Amend the cap below the parked amount, then approve: the gate re-runs on
  // current state and a cap breach cannot be approved away.
  assert.ok(big.decision.mandateId);
  os.amendMandate(big.decision.mandateId, { perTxCap: 10_00 });
  const r = await os.approve(big.intentId, { rationale: "please just send it" });
  assert.equal(r.status, "blocked");
});

test("a foreign payment with no FX rate is not covered → routes to operator", async () => {
  const os = sdk();
  grantGroceries(os); // GBP mandate, no FX configured
  const r = await os.pay({
    payee: "euro-shop",
    payeeClass: "groceries",
    amount: 50_00,
    currency: "EUR",
    rail: "card",
    rationale: "a payment in euros, no rate available",
  });
  assert.equal(r.status, "pending");
  assert.equal(r.decision.mandateId, null);
});

test("the full lifecycle leaves a verifiable audit chain", async () => {
  const os = sdk();
  grantGroceries(os);
  await os.pay({
    payee: "tesco",
    payeeClass: "groceries",
    amount: 600_00,
    currency: "GBP",
    rail: "card",
    rationale: "blocked over-cap shop",
  }); // blocked
  const pend = await os.pay({
    payee: "new-shop",
    payeeClass: "groceries",
    amount: 30_00,
    currency: "GBP",
    rail: "card",
    rationale: "a small first shop",
  }); // pending
  await os.approve(pend.intentId, { rationale: "ok" }); // settled

  assert.equal(os.verifyAudit().valid, true);
  const types = os.auditTimeline().map((e) => e.type);
  assert.ok(types.includes("mandate.granted"));
  assert.equal(types.filter((t) => t === "gate.decision").length, 3);
  assert.equal(types.filter((t) => t === "payment.settled").length, 1);
  // The store's persisted chain mirrors the in-memory audit log.
  assert.equal(os.store.loadAudit().length, os.auditTimeline().length);
});

test("high-value approval requires acknowledgement (challenge-response)", async () => {
  const os = sdk({ challengeThresholdMinor: 100 });
  grantGroceries(os);

  const pending = await os.pay({
    payee: "new-shop",
    payeeClass: "groceries",
    amount: 200_00,
    currency: "GBP",
    rail: "card",
    rationale: "a larger first shop",
  });
  assert.equal(pending.status, "pending");

  const withheld = await os.approve(pending.intentId, { rationale: "looks fine" });
  assert.equal(withheld.status, "pending");
  assert.ok(withheld.challenge && withheld.challenge.length > 0);

  const acked = await os.approve(pending.intentId, {
    rationale: "I confirm new-shop",
    ack: true,
  });
  assert.equal(acked.status, "settled");
});

test("the kill switch freezes settlement; revoke kills authority", async () => {
  const os = sdk();
  const m = grantGroceries(os);

  os.engageKillSwitch();
  assert.equal(os.isKillSwitchEngaged(), true);
  const killed = await os.pay({
    payee: "tesco",
    payeeClass: "groceries",
    amount: 20_00,
    currency: "GBP",
    rail: "card",
    rationale: "blocked by the kill switch",
  });
  assert.equal(killed.status, "blocked");
  assert.ok(killed.decision.reasons.some((r) => r.includes("kill switch")));

  os.disengageKillSwitch();
  os.revokeMandate(m.id);
  assert.equal(os.getMandate(m.id)?.status, "revoked");
  // With the only mandate revoked, a covered payment routes to the operator.
  const r = await os.pay({
    payee: "tesco",
    payeeClass: "groceries",
    amount: 20_00,
    currency: "GBP",
    rail: "card",
    rationale: "no live mandate now",
  });
  assert.equal(r.status, "pending");
  assert.equal(r.decision.mandateId, null);
});
