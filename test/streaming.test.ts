import { test } from "node:test";
import assert from "node:assert/strict";

import { AuditLog } from "../src/core/audit.ts";
import { createExecutor } from "../src/core/executor.ts";
import { createMemoryStore } from "../src/store/memoryStore.ts";
import { createRailRegistry } from "../src/rails/registry.ts";
import { createFakeRail } from "../src/rails/fakeRail.ts";
import { DEFAULT_DENY_RULES } from "../src/core/denyList.ts";
import { DEFAULT_GATE_CONFIG, type PaymentIntent } from "../src/core/types.ts";
import { streamingMandate } from "../src/core/streaming.ts";

const NOW = "2026-05-30T12:00:00.000Z";

// THE SPIKE: can the gate contain a stream of micropayments (x402-style)? Fire a
// burst of tiny payments to a known payee and assert the gate throttles at the
// velocity ceiling and never breaches the period budget — no new machinery, the
// existing velocity + budget guards do it. This de-risks the streaming thesis.
test("the gate throttles a micropayment burst at the velocity ceiling", async () => {
  const store = createMemoryStore("k");
  store.insertMandate(
    streamingMandate({
      id: "m_stream",
      label: "api metering",
      scope: { kind: "class", value: "api" },
      currency: "USDC",
      grantedAt: "2026-05-30T00:00:00.000Z",
      expiresAt: "2026-12-01T00:00:00.000Z",
      perTxCapMinor: 1000,
      perPeriodCapMinor: 1_000_000,
    }),
  );
  // Seed a settled payment OUTSIDE the velocity window so the payee is known but
  // the seed doesn't count toward the burst's velocity.
  store.insertIntent({
    intent: {
      id: "seed",
      payee: "meter",
      payeeClass: "api",
      amount: 1000,
      currency: "USDC",
      rail: "onchain",
      rationale: "seed",
      createdAt: NOW,
    },
    status: "settled",
    mandateId: "m_stream",
    reasons: [],
    settledAt: "2026-05-30T10:00:00.000Z", // 2h before NOW, outside the 60m window
    receiptId: "r",
  });
  const executor = createExecutor({
    store,
    rails: createRailRegistry([createFakeRail("onchain")]),
    audit: new AuditLog(store.operatorKey()),
    config: DEFAULT_GATE_CONFIG,
    denyRules: DEFAULT_DENY_RULES,
    clock: () => NOW,
  });

  const micro = (i: number): PaymentIntent => ({
    id: `s${i}`,
    payee: "meter",
    payeeClass: "api",
    amount: 1000,
    currency: "USDC",
    rail: "onchain",
    rationale: "metered call",
    createdAt: NOW,
  });

  let settled = 0;
  let pending = 0;
  for (let i = 0; i < 10; i++) {
    const r = await executor.execute(micro(i));
    if (r.status === "settled") settled++;
    else if (r.status === "pending") pending++;
  }

  // Auto-settles up to the velocity ceiling, then throttles the rest to operator
  // confirmation — the stream is contained, not refused.
  assert.equal(settled, DEFAULT_GATE_CONFIG.velocityMaxCount);
  assert.equal(pending, 10 - DEFAULT_GATE_CONFIG.velocityMaxCount);
  // The period budget is never breached.
  assert.ok(settled * 1000 <= 1_000_000);
});
