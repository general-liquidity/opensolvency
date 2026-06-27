import { test } from "node:test";
import assert from "node:assert/strict";

import { AuditLog } from "../src/core/audit.ts";
import { createExecutor } from "../src/core/executor.ts";
import { createMemoryStore } from "../src/store/memoryStore.ts";
import { DEFAULT_DENY_RULES } from "../src/core/denyList.ts";
import { DEFAULT_GATE_CONFIG, type Mandate, type PaymentIntent } from "../src/core/types.ts";
import { createRailRegistry } from "../src/rails/registry.ts";
import { createFakeRail } from "../src/rails/fakeRail.ts";
import { createX402Rail } from "../src/rails/x402.ts";
import { createOnchainRail } from "../src/rails/onchain.ts";
import { createAgenticCommerceRail } from "../src/rails/agentic-commerce.ts";
import { createUcpRail } from "../src/rails/ucp.ts";
import { createMppRail } from "../src/rails/mpp.ts";
import { createVisaIntelligentCommerceRail } from "../src/rails/visaIntelligentCommerce.ts";
import { createMastercardAgentPayRail } from "../src/rails/mastercardAgentPay.ts";
import type { PaymentProvider } from "../src/rails/provider.ts";
import type { RailClient } from "../src/rails/networkRail.ts";

const NOW = "2026-05-29T12:00:00.000Z";

const ALL: Array<{ id: string; rail: string; make: (c?: RailClient) => PaymentProvider }> = [
  { id: "x402", rail: "onchain", make: createX402Rail },
  { id: "direct-onchain", rail: "onchain", make: createOnchainRail },
  { id: "agentic-commerce", rail: "checkout", make: createAgenticCommerceRail },
  { id: "ucp", rail: "checkout", make: createUcpRail },
  { id: "mpp", rail: "checkout", make: createMppRail },
  { id: "visa-intelligent-commerce", rail: "card", make: createVisaIntelligentCommerceRail },
  { id: "mastercard-agent-pay", rail: "card", make: createMastercardAgentPayRail },
];

const intent: PaymentIntent = {
  id: "pi_1",
  payee: "acme",
  payeeClass: "saas",
  amount: 1000,
  currency: "USD",
  rail: "onchain",
  rationale: "subscription renewal",
  createdAt: NOW,
};

test("every adapter declares the correct capabilities", () => {
  for (const { id, rail, make } of ALL) {
    const cap = make().capabilities;
    assert.equal(cap.id, id);
    assert.equal(cap.rail, rail);
    assert.ok(["reversible", "irreversible"].includes(cap.reversibility));
  }
});

test("an UNCONFIGURED real rail fails safe (throws, never fabricates)", async () => {
  for (const { id, make } of ALL) {
    await assert.rejects(
      async () => make().settle(intent, NOW),
      (e: Error) => e.message.includes(id) && /not configured/.test(e.message),
      `${id} should refuse to settle without a client`,
    );
  }
});

test("a configured adapter settles and shapes a verifiable receipt", async () => {
  const client: RailClient = {
    settle: () => ({ providerRef: "tx_abc123" }),
  };
  const rail = createX402Rail(client);
  const receipt = await rail.settle(intent, NOW);
  assert.equal(receipt.intentId, "pi_1");
  assert.equal(receipt.providerRef, "tx_abc123");
  assert.equal(receipt.finality, "final"); // x402 is irreversible
  assert.equal(rail.verifyReceipt(receipt), true);
});

// The safety property at the executor level: routing an authorized payment to an
// unconfigured real rail records `failed` with NO receipt — never a phantom pay.
test("executor records an unconfigured-rail settlement as failed, no receipt", async () => {
  const store = createMemoryStore("k");
  store.insertMandate({
    id: "m",
    label: "saas",
    scope: { kind: "class", value: "saas" },
    currency: "USD",
    allowedRails: ["onchain"],
    perTxCap: 100_00,
    perPeriodCap: 100_00,
    period: "month",
    grantedAt: "2026-05-01T00:00:00.000Z",
    expiresAt: "2026-12-01T00:00:00.000Z",
    status: "active",
  } satisfies Mandate);
  // Seed a settled payment so the payee is known (so the gate auto-executes).
  store.insertIntent({
    intent: { ...intent, id: "seed" },
    status: "settled",
    mandateId: "m",
    reasons: [],
    settledAt: "2026-05-02T00:00:00.000Z",
    receiptId: "r",
  });
  const executor = createExecutor({
    store,
    rails: createRailRegistry([createX402Rail()], { onchain: "x402" }),
    audit: new AuditLog(store.operatorKey()),
    config: DEFAULT_GATE_CONFIG,
    denyRules: DEFAULT_DENY_RULES,
    clock: () => NOW,
  });
  const r = await executor.execute({ ...intent, id: "pi_live" });
  assert.equal(r.status, "failed");
  assert.equal(r.receipt, null);
});

test("the registry routes a rail kind to the chosen protocol", () => {
  const registry = createRailRegistry(
    [createVisaIntelligentCommerceRail(), createMastercardAgentPayRail(), createFakeRail("onchain")],
    { card: "mastercard-agent-pay" },
  );
  assert.equal(registry.get("card")?.capabilities.id, "mastercard-agent-pay");
  assert.equal(registry.get("onchain")?.capabilities.id, "fake-onchain");
  assert.equal(registry.byId("visa-intelligent-commerce")?.capabilities.rail, "card");
  assert.equal(registry.ids().length, 3);
});

test("a contended rail kind with no route resolves deterministically to undefined", () => {
  // ACP, UCP and MPP all serve "checkout": with no route the registry must not
  // silently pick the first-registered — it returns undefined (fail-safe).
  const ambiguous = createRailRegistry([
    createAgenticCommerceRail(),
    createUcpRail(),
    createMppRail(),
  ]);
  assert.equal(ambiguous.get("checkout"), undefined);

  // An explicit route disambiguates deterministically.
  const routed = createRailRegistry([createAgenticCommerceRail(), createUcpRail(), createMppRail()], {
    checkout: "ucp",
  });
  assert.equal(routed.get("checkout")?.capabilities.id, "ucp");
});
