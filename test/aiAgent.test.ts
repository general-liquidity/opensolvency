import { test } from "node:test";
import assert from "node:assert/strict";

import { AuditLog } from "../src/core/audit.ts";
import { createExecutor } from "../src/core/executor.ts";
import { createMemoryStore } from "../src/store/memoryStore.ts";
import { createRailRegistry } from "../src/rails/registry.ts";
import { createFakeRail } from "../src/rails/fakeRail.ts";
import { DEFAULT_DENY_RULES } from "../src/core/denyList.ts";
import { DEFAULT_GATE_CONFIG, type Mandate } from "../src/core/types.ts";
import { runPaymentToolCall, runAiAgent } from "../src/agent/aiAgent.ts";
import type { Store } from "../src/core/store.ts";

const NOW = "2026-05-29T12:00:00.000Z";

function harness() {
  const store: Store = createMemoryStore("test-key");
  store.insertMandate({
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
  } satisfies Mandate);
  const audit = new AuditLog(store.operatorKey());
  let n = 0;
  const executor = createExecutor({
    store,
    rails: createRailRegistry([createFakeRail("card")]),
    audit,
    config: DEFAULT_GATE_CONFIG,
    denyRules: DEFAULT_DENY_RULES,
    clock: () => NOW,
  });
  return {
    store,
    executor,
    clock: () => NOW,
    newId: () => `pi_${n++}`,
  };
}

const draft = {
  payee: "tesco",
  payeeClass: "groceries",
  currency: "GBP",
  rail: "card" as const,
  rationale: "weekly shop",
};

// The security-critical property: the tool the agent calls is gate-enforced.
test("the pay-tool handler routes a new payee to pending (not auto-paid)", async () => {
  const h = harness();
  const r = await runPaymentToolCall({ ...draft, amount: 80_00 }, h);
  assert.equal(r.status, "pending");
});

test("the pay-tool handler blocks an over-cap payment", async () => {
  const h = harness();
  const r = await runPaymentToolCall({ ...draft, amount: 600_00 }, h);
  assert.equal(r.status, "blocked");
  assert.ok(r.decision.reasons.some((x) => x.includes("per-transaction cap")));
});

test("the pay-tool handler auto-settles a known payee under cap", async () => {
  const h = harness();
  // Seed a settled payment so tesco is known.
  h.store.insertIntent({
    intent: {
      id: "seed",
      payee: "tesco",
      payeeClass: "groceries",
      amount: 80_00,
      currency: "GBP",
      rail: "card",
      rationale: "seed",
      createdAt: NOW,
    },
    status: "settled",
    mandateId: "m_groceries",
    reasons: [],
    settledAt: "2026-05-26T09:00:00.000Z",
    receiptId: "rcpt_seed",
  });
  const r = await runPaymentToolCall({ ...draft, amount: 80_00 }, h);
  assert.equal(r.status, "settled");
  assert.ok(r.receipt);
});

// Full loop through the Vercel AI SDK with a mock model: the model "decides" to
// pay over-cap; the gate-enforced tool blocks it inside the SDK loop.
test("the AI SDK loop still cannot bypass the gate (mock model, over-cap → blocked)", async () => {
  const { MockLanguageModelV3 } = await import("ai/test");
  const h = harness();
  let call = 0;
  const usage = {
    inputTokens: { total: 10, noCache: 10, cacheRead: undefined, cacheWrite: undefined },
    outputTokens: { total: 5, text: 5, reasoning: undefined },
  };
  const model = new MockLanguageModelV3({
    doGenerate: async () => {
      call += 1;
      if (call === 1) {
        return {
          content: [
            {
              type: "tool-call" as const,
              toolCallId: "c1",
              toolName: "pay",
              input: JSON.stringify({ ...draft, amount: 600_00 }),
            },
          ],
          finishReason: { unified: "tool-calls" as const, raw: undefined },
          usage,
          warnings: [],
        };
      }
      return {
        content: [{ type: "text" as const, text: "Payment was blocked by the gate." }],
        finishReason: { unified: "stop" as const, raw: undefined },
        usage,
        warnings: [],
      };
    },
  });

  const r = await runAiAgent("buy the whole store", {
    model,
    executor: h.executor,
    store: h.store,
    clock: h.clock,
    newId: h.newId,
    maxSteps: 4,
  });
  assert.equal(r.executions.length, 1);
  assert.equal(r.executions[0].status, "blocked");
});
