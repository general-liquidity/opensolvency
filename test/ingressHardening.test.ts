import test from "node:test";
import assert from "node:assert/strict";

import { createRateLimiter } from "../src/ingress/rateLimit.ts";
import { isLoopbackHost } from "../src/ingress/auth.ts";
import { replayIfSeen, rememberKey, idempotencyMetaKey } from "../src/ingress/idempotency.ts";
import { handleIngress, type IngressDeps } from "../src/ingress/server.ts";
import { AuditLog } from "../src/core/audit.ts";
import { createExecutor } from "../src/core/executor.ts";
import { createMemoryStore } from "../src/store/memoryStore.ts";
import { createRailRegistry } from "../src/rails/registry.ts";
import { createFakeRail } from "../src/rails/fakeRail.ts";
import { DEFAULT_DENY_RULES } from "../src/core/denyList.ts";
import { DEFAULT_GATE_CONFIG } from "../src/core/types.ts";

const NOW = "2026-06-24T12:00:00.000Z";

// ── rate limiter ─────────────────────────────────────────────────────────────
test("rate limiter allows up to max per window, then blocks with retry-after", () => {
  let t = 0;
  const rl = createRateLimiter({ windowMs: 1000, max: 2, now: () => t });
  assert.equal(rl.check("ip").ok, true);
  assert.equal(rl.check("ip").ok, true);
  const blocked = rl.check("ip");
  assert.equal(blocked.ok, false);
  assert.ok((blocked.retryAfterMs ?? 0) > 0);
  // window rolls over
  t = 1000;
  assert.equal(rl.check("ip").ok, true);
});

test("rate limiter is per-key", () => {
  const rl = createRateLimiter({ windowMs: 1000, max: 1, now: () => 0 });
  assert.equal(rl.check("a").ok, true);
  assert.equal(rl.check("b").ok, true); // different key, own bucket
  assert.equal(rl.check("a").ok, false);
});

// ── idempotency helpers ──────────────────────────────────────────────────────
test("idempotency: unseen key replays nothing; remembered key replays the intent", () => {
  const store = createMemoryStore("k");
  assert.equal(replayIfSeen(store, "key-1"), null);
  store.insertIntent({
    intent: { id: "pi_7", payee: "p", payeeClass: "c", amount: 100, currency: "GBP", rail: "card", rationale: "x".repeat(12), createdAt: NOW },
    status: "settled", mandateId: "m", reasons: ["ok"], settledAt: NOW, receiptId: "r1",
  });
  rememberKey(store, "key-1", "pi_7");
  assert.equal(store.getMeta(idempotencyMetaKey("key-1")), "pi_7");
  const replay = replayIfSeen(store, "key-1");
  assert.ok(replay);
  assert.equal(replay.status, 200);
  assert.equal(replay.body.intentId, "pi_7");
  assert.equal(replay.body.idempotentReplay, true);
});

// ── idempotency through the handler (the gate runs ONCE) ─────────────────────
function deps(): IngressDeps {
  const store = createMemoryStore("k");
  const executor = createExecutor({
    store, rails: createRailRegistry([createFakeRail("card")]), audit: new AuditLog(store.operatorKey()),
    config: DEFAULT_GATE_CONFIG, denyRules: DEFAULT_DENY_RULES, clock: () => NOW,
  });
  let n = 0;
  return { executor, store, clock: () => NOW, newId: () => `pi_${n++}` };
}

const intentBody = JSON.stringify({
  payee: "newvendor", payeeClass: "misc", amount: 100_00, currency: "GBP",
  rail: "card", rationale: "a payment with no covering mandate",
});

test("a retried payment-intent with the same Idempotency-Key creates ONE intent", async () => {
  const d = deps();
  const first = await handleIngress("POST", "/payment-intent", intentBody, d, undefined, "idem-A");
  const second = await handleIngress("POST", "/payment-intent", intentBody, d, undefined, "idem-A");
  // same intent id returned both times
  assert.equal((first.body as any).intentId, (second.body as any).intentId);
  // the replay is flagged, and only ONE intent exists in the store
  assert.equal((second.body as any).idempotentReplay, true);
  assert.equal(d.store!.listPendingIntents().length, 1);
});

test("different Idempotency-Keys create distinct intents", async () => {
  const d = deps();
  const a = await handleIngress("POST", "/payment-intent", intentBody, d, undefined, "k-a");
  const b = await handleIngress("POST", "/payment-intent", intentBody, d, undefined, "k-b");
  assert.notEqual((a.body as any).intentId, (b.body as any).intentId);
  assert.equal(d.store!.listPendingIntents().length, 2);
});

// ── fail-closed bind guard ───────────────────────────────────────────────────
test("loopback hosts are recognized (the public-bind-without-token guard)", () => {
  for (const h of ["127.0.0.1", "localhost", "::1"]) assert.equal(isLoopbackHost(h), true);
  for (const h of ["0.0.0.0", "10.0.0.5", "example.com"]) assert.equal(isLoopbackHost(h), false);
});

// ── /ready ───────────────────────────────────────────────────────────────────
test("/ready reports readiness + halt state, without auth even when a token is set", async () => {
  const d = { ...deps(), ingressToken: () => "secret" };
  const r = await handleIngress("GET", "/ready", "", d);
  assert.equal(r.status, 200);
  assert.equal((r.body as any).ready, true);
  assert.equal((r.body as any).killSwitch, false);
});
