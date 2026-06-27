import { test } from "node:test";
import assert from "node:assert/strict";

import {
  buildPaymentMandateContent,
  bindTransactionId,
  mandateToAp2Constraints,
} from "../src/rails/ap2/mandate.ts";
import { createAp2Rail, type Ap2Client } from "../src/rails/ap2/ap2Rail.ts";
import { AuditLog } from "../src/core/audit.ts";
import { createExecutor } from "../src/core/executor.ts";
import { createMemoryStore } from "../src/store/memoryStore.ts";
import { createRailRegistry } from "../src/rails/registry.ts";
import { DEFAULT_DENY_RULES } from "../src/core/denyList.ts";
import { DEFAULT_GATE_CONFIG, type Mandate, type PaymentIntent } from "../src/core/types.ts";

const NOW = "2026-05-30T12:00:00.000Z";
const intent = (over: Partial<PaymentIntent> = {}): PaymentIntent => ({
  id: "pi_1",
  payee: "merchant-x",
  payeeClass: "retail",
  amount: 279_99,
  currency: "USD",
  rail: "checkout",
  rationale: "agentic purchase",
  createdAt: NOW,
  ...over,
});

test("the payment mandate content models the AP2 v1 schema (minor units)", () => {
  const m = buildPaymentMandateContent(intent(), {
    instrument: { id: "card-1", type: "card" },
  });
  assert.equal(m.vct, "mandate.payment.1");
  assert.equal(m.payee.id, "merchant-x");
  assert.deepEqual(m.payment_amount, { amount: 279_99, currency: "USD" });
  assert.equal(m.payment_instrument.type, "card");
});

test("transaction_id binds the payment mandate to the checkout (base64url hash)", () => {
  const a = bindTransactionId("checkout-jwt-abc");
  const b = bindTransactionId("checkout-jwt-abc");
  const c = bindTransactionId("checkout-jwt-xyz");
  assert.equal(a, b); // deterministic
  assert.notEqual(a, c); // distinct checkout → distinct binding
  assert.ok(!/[+/=]/.test(a)); // base64url (no +,/,=)
});

// THE RESONANCE: an AgentWorth mandate IS an AP2 open Payment Mandate's constraints.
test("an AgentWorth mandate maps onto AP2 open-mandate constraints", () => {
  const mandate: Mandate = {
    id: "m",
    label: "groceries",
    scope: { kind: "allowlist", values: ["tesco", "sainsburys"] },
    currency: "GBP",
    allowedRails: ["card"],
    perTxCap: 500_00,
    perPeriodCap: 1000_00,
    period: "week",
    grantedAt: NOW,
    expiresAt: "2026-06-26T00:00:00.000Z",
    status: "active",
  };
  const c = mandateToAp2Constraints(mandate);
  const amountRange = c.find((x) => x.type === "payment.amount_range");
  const budget = c.find((x) => x.type === "payment.budget");
  const payees = c.find((x) => x.type === "payment.allowed_payees");
  const window = c.find((x) => x.type === "payment.execution_date");
  assert.equal(amountRange?.type === "payment.amount_range" && amountRange.max, 500_00);
  assert.equal(budget?.type === "payment.budget" && budget.max, 1000_00);
  assert.equal(payees?.type === "payment.allowed_payees" && payees.payees.length, 2);
  assert.equal(
    window?.type === "payment.execution_date" && window.not_after,
    "2026-06-26T00:00:00.000Z",
  );
});

test("the AP2 rail fails safe when unconfigured", async () => {
  const rail = createAp2Rail();
  await assert.rejects(() => Promise.resolve(rail.settle(intent(), NOW)));
});

test("end-to-end: AP2 settles through the gate via an injected client", async () => {
  const client: Ap2Client = {
    present: () => ({
      status: "Success",
      iss: "credential-provider",
      iat: 0,
      reference: "ref-1",
      payment_id: "ap2_pay_123",
    }),
  };
  const store = createMemoryStore("k");
  store.insertMandate({
    id: "m",
    label: "retail",
    scope: { kind: "class", value: "retail" },
    currency: "USD",
    allowedRails: ["checkout"],
    perTxCap: 500_00,
    perPeriodCap: 2000_00,
    period: "month",
    grantedAt: "2026-05-01T00:00:00.000Z",
    expiresAt: "2026-12-01T00:00:00.000Z",
    status: "active",
  } satisfies Mandate);
  // Seed so merchant-x is a known payee → auto-execute.
  store.insertIntent({
    intent: intent({ id: "seed" }),
    status: "settled",
    mandateId: "m",
    reasons: [],
    settledAt: "2026-05-02T00:00:00.000Z",
    receiptId: "r",
  });
  const executor = createExecutor({
    store,
    rails: createRailRegistry([createAp2Rail({ client })]),
    audit: new AuditLog(store.operatorKey()),
    config: DEFAULT_GATE_CONFIG,
    denyRules: DEFAULT_DENY_RULES,
    clock: () => NOW,
  });
  const r = await executor.execute(intent({ id: "pi_live" }));
  assert.equal(r.status, "settled");
  assert.equal(r.receipt?.providerRef, "ap2_pay_123");
  assert.equal(r.verified, true);
});
