import { test } from "node:test";
import assert from "node:assert/strict";

import { payeeTrust, type TrustLevel } from "../src/core/trust.ts";
import { evaluateGate } from "../src/core/gate.ts";
import { DEFAULT_DENY_RULES } from "../src/core/denyList.ts";
import {
  DEFAULT_GATE_CONFIG,
  type GateContext,
  type Mandate,
  type PaymentIntent,
} from "../src/core/types.ts";

test("payeeTrust grades by settlement history", () => {
  assert.equal(payeeTrust(0), "new");
  assert.equal(payeeTrust(1), "seen");
  assert.equal(payeeTrust(2), "seen");
  assert.equal(payeeTrust(3), "trusted");
});

const NOW = "2026-05-30T12:00:00.000Z";
const mandate: Mandate = {
  id: "m",
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
};
const intent = (over: Partial<PaymentIntent> = {}): PaymentIntent => ({
  id: "pi",
  payee: "p",
  payeeClass: "groceries",
  amount: 80_00,
  currency: "GBP",
  rail: "card",
  rationale: "weekly shop",
  createdAt: NOW,
  ...over,
});
const ctx = (trust: TrustLevel): GateContext => ({
  now: NOW,
  mandates: [mandate],
  periodSpendByMandate: () => [],
  knownPayees: new Set(),
  trustOf: () => trust,
  denyRules: DEFAULT_DENY_RULES,
  config: DEFAULT_GATE_CONFIG,
});

test("trust relaxes scrutiny: trusted auto-executes where new is confirmed", () => {
  const asNew = evaluateGate(intent(), ctx("new"));
  const asTrusted = evaluateGate(intent(), ctx("trusted"));
  assert.equal(asNew.outcome, "confirm_operator"); // new payee
  assert.equal(asTrusted.outcome, "auto_execute");
  assert.ok(asTrusted.risk.score < asNew.risk.score); // trusted is lower-risk
});

test("trust NEVER relaxes the floor: caps still bind for a trusted payee", () => {
  const overCap = evaluateGate(intent({ amount: 600_00 }), ctx("trusted"));
  assert.equal(overCap.outcome, "block");
  assert.ok(overCap.reasons.some((r) => r.includes("per-transaction cap")));
});
