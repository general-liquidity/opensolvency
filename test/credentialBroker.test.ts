import { test } from "node:test";
import assert from "node:assert/strict";
import { CredentialBroker, BROKERED_SECRET } from "../src/core/credentialBroker.ts";
import type { PaymentProvider } from "../src/rails/provider.ts";
import type { PaymentIntent, Receipt } from "../src/core/types.ts";

test("CredentialBroker stores credentials and injects them during settlement", async () => {
  const broker = new CredentialBroker();
  broker.storeCredential("stripe_prod_key", "sk_test_12345");

  // Create a mock provider that verifies the secret is injected
  let lastSettleIntent: any = null;
  const mockBaseProvider: PaymentProvider = {
    capabilities: {
      id: "stripe-card",
      rail: "card",
      reversibility: "reversible",
      settlementFinality: "instant",
    },
    settle(intent: PaymentIntent, now: string): Receipt {
      lastSettleIntent = intent;
      return {
        id: "rcpt_1",
        intentId: intent.id,
        rail: "card",
        amount: intent.amount,
        currency: intent.currency,
        settledAt: now,
        providerRef: "stripe_ch_1",
        finality: "final",
      };
    },
    verifyReceipt: () => true,
  };

  const brokeredProvider = broker.brokerProvider(mockBaseProvider, "stripe_prod_key");

  // Perform settlement
  const intentPayload: PaymentIntent = {
    id: "pi_1",
    payee: "stripe_merchant",
    payeeClass: "saas",
    amount: 10_00,
    currency: "USD",
    rail: "card",
    rationale: "brokered pay",
    createdAt: "2026-06-01T00:00:00Z",
  };

  const receipt = await brokeredProvider.settle(intentPayload, "2026-06-01T00:00:00Z");

  assert.equal(receipt.id, "rcpt_1");
  assert.ok(lastSettleIntent);
  // The secret rides under a Symbol key — readable by an adapter that imports it…
  assert.equal(lastSettleIntent[BROKERED_SECRET], "sk_test_12345");
  // …but invisible to enumeration / JSON logging, so it can't leak into an audit line.
  assert.equal(JSON.stringify(lastSettleIntent).includes("sk_test_12345"), false);
  assert.equal(Object.keys(lastSettleIntent).includes("_brokeredSecret"), false);
});

test("CredentialBroker instances are isolated (no shared global vault)", () => {
  const a = new CredentialBroker();
  const b = new CredentialBroker();
  a.storeCredential("k", "secret-a");
  // b never stored "k" — a's credential must not be visible to b.
  assert.equal(b.hasCredential("k"), false);
  assert.equal(a.hasCredential("k"), true);
});

test("CredentialBroker throws when credential key is not registered", async () => {
  const mockBaseProvider: PaymentProvider = {
    capabilities: {
      id: "test",
      rail: "card",
      reversibility: "reversible",
      settlementFinality: "instant",
    },
    settle: () => {
      throw new Error("should not be called");
    },
    verifyReceipt: () => true,
  };

  const brokeredProvider = new CredentialBroker().brokerProvider(mockBaseProvider, "missing_key");

  const intentPayload: PaymentIntent = {
    id: "pi_1",
    payee: "any",
    payeeClass: "any",
    amount: 10_00,
    currency: "USD",
    rail: "card",
    rationale: "brokered pay",
    createdAt: "2026-06-01T00:00:00Z",
  };

  await assert.rejects(
    async () => {
      await brokeredProvider.settle(intentPayload, "2026-06-01T00:00:00Z");
    },
    /CredentialBroker: credential "missing_key" is not registered or configured/,
  );
});
