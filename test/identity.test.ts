import { test } from "node:test";
import assert from "node:assert/strict";

import {
  noopVerifier,
  staticIdentityVerifier,
} from "../src/identity/verifier.ts";
import { evaluateGate } from "../src/core/gate.ts";
import { DEFAULT_DENY_RULES } from "../src/core/denyList.ts";
import {
  DEFAULT_GATE_CONFIG,
  type Attestation,
  type GateContext,
  type Mandate,
  type PaymentIntent,
} from "../src/core/types.ts";

test("the static verifier matches registered agents; noop attests nothing", async () => {
  const verifier = staticIdentityVerifier({
    "agent-a": { agentId: "agent-a", principal: "tiberiu", attestation: "registry_attested" },
  });
  const ok = await verifier.verify("agent-a");
  assert.equal(ok.verified, true);
  assert.equal(ok.identity.principal, "tiberiu");
  assert.equal(ok.identity.attestation, "registry_attested");

  const unknown = await verifier.verify("agent-x");
  assert.equal(unknown.verified, false);
  assert.equal(unknown.identity.attestation, "none");

  assert.equal((await noopVerifier.verify("anything")).verified, false);
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
  payee: "tesco",
  payeeClass: "groceries",
  amount: 80_00,
  currency: "GBP",
  rail: "card",
  rationale: "weekly shop",
  createdAt: NOW,
  ...over,
});
const ctx = (attestation?: Attestation): GateContext => ({
  now: NOW,
  mandates: [mandate],
  periodSpendByMandate: () => [],
  knownPayees: new Set(["tesco"]),
  denyRules: DEFAULT_DENY_RULES,
  config: DEFAULT_GATE_CONFIG,
  attestation,
});

test("an unverified agent is riskier than a registry-attested one", () => {
  const unverified = evaluateGate(intent(), ctx("none"));
  const attested = evaluateGate(intent(), ctx("registry_attested"));
  assert.ok(unverified.risk.score > attested.risk.score);
  assert.ok(unverified.risk.reasons.some((r) => r.includes("unverified")));
});

test("attestation NEVER relaxes the floor (over-cap still blocks, even attested)", () => {
  const d = evaluateGate(intent({ amount: 600_00 }), ctx("registry_attested"));
  assert.equal(d.outcome, "block");
  assert.ok(d.reasons.some((r) => r.includes("per-transaction cap")));
});

test("attestation is opt-in: undefined leaves risk unchanged", () => {
  const withoutSignal = evaluateGate(intent(), ctx(undefined));
  assert.ok(!withoutSignal.risk.reasons.some((r) => r.includes("agent")));
});
