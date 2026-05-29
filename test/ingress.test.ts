import { test } from "node:test";
import assert from "node:assert/strict";

import { AuditLog } from "../src/core/audit.ts";
import { createExecutor } from "../src/core/executor.ts";
import { createMemoryStore } from "../src/store/memoryStore.ts";
import { createRailRegistry } from "../src/rails/registry.ts";
import { createFakeRail } from "../src/rails/fakeRail.ts";
import { DEFAULT_DENY_RULES } from "../src/core/denyList.ts";
import { DEFAULT_GATE_CONFIG, type Mandate } from "../src/core/types.ts";
import { handleIngress, type IngressDeps } from "../src/ingress/server.ts";

const NOW = "2026-05-30T12:00:00.000Z";

function deps(): IngressDeps {
  const store = createMemoryStore("k");
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
  store.insertIntent({
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
    receiptId: "r",
  });
  const executor = createExecutor({
    store,
    rails: createRailRegistry([createFakeRail("card")]),
    audit: new AuditLog(store.operatorKey()),
    config: DEFAULT_GATE_CONFIG,
    denyRules: DEFAULT_DENY_RULES,
    clock: () => NOW,
  });
  let n = 0;
  return { executor, clock: () => NOW, newId: () => `pi_${n++}` };
}

const req = (payee: string, amount: number) =>
  JSON.stringify({ payee, payeeClass: "groceries", amount, currency: "GBP", rail: "card", rationale: "ingress request" });

test("an inbound covered, under-cap request auto-settles (200)", async () => {
  const r = await handleIngress("POST", "/payment-intent", req("tesco", 80_00), deps());
  assert.equal(r.status, 200);
});

test("an inbound new-payee request is accepted pending operator confirm (202)", async () => {
  const r = await handleIngress("POST", "/payment-intent", req("new-shop", 80_00), deps());
  assert.equal(r.status, 202);
});

test("an inbound over-cap request is blocked (403)", async () => {
  const r = await handleIngress("POST", "/payment-intent", req("tesco", 600_00), deps());
  assert.equal(r.status, 403);
});

test("a malformed request is rejected (400)", async () => {
  const r = await handleIngress("POST", "/payment-intent", "{not json", deps());
  assert.equal(r.status, 400);
});

test("status + health endpoints report safely", async () => {
  const d = deps();
  d.executor.engageKillSwitch();
  const status = await handleIngress("GET", "/status", "", d);
  assert.equal(status.status, 200);
  assert.equal((status.body as { killSwitch: boolean }).killSwitch, true);
  const health = await handleIngress("GET", "/health", "", d);
  assert.equal(health.status, 200);
});

test("an inbound request is frozen by the kill switch", async () => {
  const d = deps();
  d.executor.engageKillSwitch();
  const r = await handleIngress("POST", "/payment-intent", req("tesco", 80_00), d);
  assert.equal(r.status, 403); // halted
});
