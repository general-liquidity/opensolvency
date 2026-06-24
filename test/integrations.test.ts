import test from "node:test";
import assert from "node:assert/strict";

import { gatedPay, createGatedPayTool, GATED_PAY_NAME, gatedPayInputSchema } from "../src/integrations/index.ts";
import { AuditLog } from "../src/core/audit.ts";
import { createExecutor } from "../src/core/executor.ts";
import { createMemoryStore } from "../src/store/memoryStore.ts";
import { createRailRegistry } from "../src/rails/registry.ts";
import { createFakeRail } from "../src/rails/fakeRail.ts";
import { DEFAULT_DENY_RULES } from "../src/core/denyList.ts";
import { DEFAULT_GATE_CONFIG, type Mandate } from "../src/core/types.ts";

const NOW = "2026-06-24T12:00:00.000Z";

function deps() {
  const store = createMemoryStore("k");
  store.insertMandate({
    id: "m", label: "groceries", scope: { kind: "class", value: "groceries" }, currency: "GBP",
    allowedRails: ["card"], perTxCap: 500_00, perPeriodCap: 1000_00, period: "week",
    grantedAt: "2026-06-20T00:00:00.000Z", expiresAt: "2026-07-20T00:00:00.000Z", status: "active",
  } satisfies Mandate);
  const executor = createExecutor({
    store, rails: createRailRegistry([createFakeRail("card")]), audit: new AuditLog(store.operatorKey()),
    config: DEFAULT_GATE_CONFIG, denyRules: DEFAULT_DENY_RULES, clock: () => NOW,
  });
  let n = 0;
  return { executor, clock: () => NOW, newId: () => `pi_${n++}`, store };
}

const draft = (over = {}) => ({
  payee: "newgrocer", payeeClass: "groceries", amount: 80_00, currency: "GBP" as const,
  rail: "card" as const, rationale: "the weekly grocery shop", ...over,
});

test("gatedPay routes through the gate — over-cap is blocked, money never moves", async () => {
  const d = deps();
  const r = await gatedPay(d, draft({ amount: 600_00 }));
  assert.equal(r.status, "blocked");
  assert.equal(r.receiptId, null);
  assert.ok(Array.isArray(r.reasons));
});

test("gatedPay parks a new payee for operator approval (pending), not a silent settle", async () => {
  const r = await gatedPay(deps(), draft());
  assert.equal(r.status, "pending");
  assert.match(r.intentId, /^pi_/);
});

test("gatedPay resolves clock/newId defaults when omitted (only executor required)", async () => {
  const d = deps();
  const r = await gatedPay({ executor: d.executor }, draft({ amount: 600_00 }));
  assert.equal(r.status, "blocked");
});

test("createGatedPayTool returns an AI SDK tool that executes through the gate", async () => {
  const d = deps();
  const t = createGatedPayTool(d);
  assert.ok(t.execute);
  // invoke the tool's execute like the AI SDK loop would
  const out = await t.execute!(draft({ amount: 600_00 }), { toolCallId: "c1", messages: [] } as never);
  assert.equal((out as { status: string }).status, "blocked");
});

test("the shared tool name + schema are exported for wrapping into other frameworks", () => {
  assert.equal(GATED_PAY_NAME, "pay");
  assert.ok(gatedPayInputSchema); // a zod schema other framework adapters reuse
});
