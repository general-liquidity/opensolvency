import { test } from "node:test";
import assert from "node:assert/strict";

import { AuditLog } from "../src/core/audit.ts";
import { createExecutor } from "../src/core/executor.ts";
import { createMemoryStore } from "../src/store/memoryStore.ts";
import { createRailRegistry } from "../src/rails/registry.ts";
import { createFakeRail } from "../src/rails/fakeRail.ts";
import { DEFAULT_DENY_RULES } from "../src/core/denyList.ts";
import { DEFAULT_GATE_CONFIG, type Mandate, type PaymentIntent } from "../src/core/types.ts";
import type { Store } from "../src/core/store.ts";
import {
  createX402Proxy,
  handleChallenge,
  selectRequirement,
  type ChallengeContext,
  type ProxyRequest,
  type ProxyResponse,
  type UpstreamFetch,
  type X402Challenge,
  type X402Requirement,
} from "../src/proxy/x402Proxy.ts";

const NOW = "2026-05-29T12:00:00.000Z";

// An x402 mandate: USDC, on-chain, scoped to the "api" service class.
function mandate(over: Partial<Mandate> = {}): Mandate {
  return {
    id: "m_x402",
    label: "x402 apis",
    scope: { kind: "class", value: "api" },
    currency: "USDC",
    allowedRails: ["onchain"],
    perTxCap: 100_000, // 0.10 USDC at 6dp
    perPeriodCap: 1_000_000,
    period: "week",
    grantedAt: "2026-05-26T00:00:00.000Z",
    expiresAt: "2026-06-26T00:00:00.000Z",
    status: "active",
    ...over,
  };
}

function requirement(over: Partial<X402Requirement> = {}): X402Requirement {
  return {
    scheme: "exact",
    network: "base",
    asset: "0xUSDC",
    payTo: "weather-api",
    maxAmountRequired: "50000", // 0.05 USDC — under the 0.10 cap
    resource: "https://weather.example/forecast",
    description: "forecast endpoint",
    ...over,
  };
}

function challenge(reqs: X402Requirement[]): X402Challenge {
  return { x402Version: 1, accepts: reqs };
}

let idCounter = 0;
function ctx(over: Partial<ChallengeContext> = {}): ChallengeContext {
  return {
    newId: () => `pi_x402_${idCounter++}`,
    clock: () => NOW,
    rail: "onchain",
    payeeClassOf: () => "api",
    currencyOf: () => "USDC",
    ...over,
  };
}

function harness() {
  const store: Store = createMemoryStore("test-key");
  const audit = new AuditLog(store.operatorKey(), store.loadAudit());
  const rails = createRailRegistry([
    createFakeRail("onchain"),
    createFakeRail("card"),
  ]);
  const executor = createExecutor({
    store,
    rails,
    audit,
    config: DEFAULT_GATE_CONFIG,
    denyRules: DEFAULT_DENY_RULES,
    clock: () => NOW,
  });
  return { store, audit, executor };
}

// Seed a prior settled payment to a payee so it is 'known' (not novel).
function seedKnown(store: Store, payee: string) {
  const seed: PaymentIntent = {
    id: `seed_${payee}`,
    payee,
    payeeClass: "api",
    amount: 1000,
    currency: "USDC",
    rail: "onchain",
    rationale: "seed known payee",
    createdAt: NOW,
  };
  store.insertIntent({
    intent: seed,
    status: "settled",
    mandateId: "m_x402",
    reasons: [],
    settledAt: "2026-05-26T09:00:00.000Z",
    receiptId: `rcpt_${seed.id}`,
  });
}

// --- the pure decision core --------------------------------------------------

test("selectRequirement picks the cheapest on an acceptable network", () => {
  const chosen = selectRequirement(
    [
      requirement({ maxAmountRequired: "90000", network: "base" }),
      requirement({ maxAmountRequired: "40000", network: "base" }),
      requirement({ maxAmountRequired: "10000", network: "solana" }),
    ],
    ["base"], // operator wallet only pays base → solana excluded despite being cheapest
  );
  assert.ok(chosen);
  assert.equal(chosen.maxAmountRequired, "40000");
  assert.equal(chosen.network, "base");
});

test("within-mandate, known payee, under cap → settles + proceeds", async () => {
  const { store, executor } = harness();
  store.insertMandate(mandate());
  seedKnown(store, "weather-api");

  const decision = await handleChallenge(challenge([requirement()]), executor, ctx());
  assert.equal(decision.outcome, "settle");
  assert.ok(decision.result?.receipt, "a receipt proves it settled");
  assert.equal(decision.result?.status, "settled");
  // The proof the proxy would attach to the retry is the on-chain ref.
  assert.ok(decision.result?.receipt.providerRef.length);
});

test("over-cap requirement → blocked (gate is the source of truth)", async () => {
  const { store, executor } = harness();
  store.insertMandate(mandate());
  seedKnown(store, "weather-api");

  const decision = await handleChallenge(
    challenge([requirement({ maxAmountRequired: "150000" })]), // 0.15 > 0.10 cap
    executor,
    ctx(),
  );
  assert.equal(decision.outcome, "block");
  assert.equal(decision.result?.status, "blocked");
  assert.ok(decision.reasons.some((r) => r.includes("cap")));
});

test("new payee under the irreversible floor → routed to operator (pending)", async () => {
  const { store, executor } = harness();
  store.insertMandate(mandate());
  // no seedKnown → "novel-api" has no settlement history. Keep the price under the
  // hard irreversible-to-unknown floor (5000) so the gate routes rather than blocks.
  const decision = await handleChallenge(
    challenge([requirement({ payTo: "novel-api", maxAmountRequired: "3000" })]),
    executor,
    ctx(),
  );
  assert.equal(decision.outcome, "route_to_operator");
  assert.equal(decision.result?.status, "pending");
  assert.ok(decision.reasons.some((r) => r.includes("new payee")));
});

test("new payee above the irreversible floor → hard block (never routed)", async () => {
  const { store, executor } = harness();
  store.insertMandate(mandate());
  // An irreversible (on-chain) send to a never-seen payee above the floor is the
  // classic agentic-payment footgun: the deny-list refuses it outright.
  const decision = await handleChallenge(
    challenge([requirement({ payTo: "novel-api", maxAmountRequired: "50000" })]),
    executor,
    ctx(),
  );
  assert.equal(decision.outcome, "block");
  assert.equal(decision.result?.status, "blocked");
  assert.ok(decision.reasons.some((r) => r.includes("deny-list")));
});

test("no covering mandate → routed to operator (no auto-pay)", async () => {
  const { executor } = harness();
  // no mandate inserted at all; sub-floor amount so it's a route, not a deny.
  const decision = await handleChallenge(
    challenge([requirement({ maxAmountRequired: "3000" })]),
    executor,
    ctx(),
  );
  assert.equal(decision.outcome, "route_to_operator");
  assert.equal(decision.result?.status, "pending");
});

test("no requirement on an acceptable network → no_requirement", async () => {
  const { executor } = harness();
  const decision = await handleChallenge(
    challenge([requirement({ network: "solana" })]),
    executor,
    ctx({ networks: ["base"] }),
  );
  assert.equal(decision.outcome, "no_requirement");
  assert.equal(decision.result, null);
});

// --- the forward proxy round-trip against a fake upstream --------------------

/** A fake upstream that gates the resource behind a 402 until a proof arrives. */
function payingUpstream(
  reqOver: Partial<X402Requirement> = {},
): { upstream: UpstreamFetch; calls: Array<{ proof?: string }> } {
  const calls: Array<{ proof?: string }> = [];
  const chal: X402Challenge = challenge([requirement(reqOver)]);
  const upstream: UpstreamFetch = async (_req: ProxyRequest, proof?: string): Promise<ProxyResponse> => {
    calls.push({ proof });
    if (proof) {
      return { status: 200, headers: { "content-type": "text/plain" }, body: "FORECAST: sunny" };
    }
    return {
      status: 402,
      headers: { "content-type": "application/json" },
      body: JSON.stringify(chal),
    };
  };
  return { upstream, calls };
}

const agentReq: ProxyRequest = {
  method: "GET",
  url: "https://weather.example/forecast",
  headers: { host: "weather.example" },
};

test("forward: 402 within mandate → settle + retry with proof → 200 to the agent", async () => {
  const { store, executor } = harness();
  store.insertMandate(mandate());
  seedKnown(store, "weather-api");
  const { upstream, calls } = payingUpstream();
  const proxy = createX402Proxy({ executor, upstream, ctx: ctx() });

  const res = await proxy.forward(agentReq);
  assert.equal(res.status, 200);
  assert.equal(res.body, "FORECAST: sunny");
  // Two upstream calls: the unpaid probe, then the paid retry carrying a proof.
  assert.equal(calls.length, 2);
  assert.equal(calls[0].proof, undefined);
  assert.ok(calls[1].proof && calls[1].proof.length > 0);
});

test("forward: 402 over cap → 403 to the agent, no paid retry", async () => {
  const { store, executor } = harness();
  store.insertMandate(mandate({ perTxCap: 10_000 })); // 0.01 cap < 0.05 price
  seedKnown(store, "weather-api");
  const { upstream, calls } = payingUpstream();
  const proxy = createX402Proxy({ executor, upstream, ctx: ctx() });

  const res = await proxy.forward(agentReq);
  assert.equal(res.status, 403);
  assert.equal(calls.length, 1); // never retried
  assert.equal(res.headers["x-opensolvency"], "blocked");
});

test("forward: 402 new payee → 402 pending-operator to the agent", async () => {
  const { store, executor } = harness();
  store.insertMandate(mandate());
  // no seedKnown → payee is novel; sub-floor price so the gate routes, not denies.
  const { upstream, calls } = payingUpstream({ maxAmountRequired: "3000" });
  const proxy = createX402Proxy({ executor, upstream, ctx: ctx() });

  const res = await proxy.forward(agentReq);
  assert.equal(res.status, 402);
  assert.equal(res.headers["x-opensolvency"], "pending-operator");
  assert.equal(calls.length, 1); // not paid, not retried
  const parsed = JSON.parse(res.body) as { outcome: string; intentId: string };
  assert.equal(parsed.outcome, "route_to_operator");
  assert.ok(parsed.intentId);
});

test("forward: a non-402 upstream is a transparent passthrough", async () => {
  const { executor } = harness();
  const upstream: UpstreamFetch = async () => ({
    status: 200,
    headers: {},
    body: "no paywall here",
  });
  const proxy = createX402Proxy({ executor, upstream, ctx: ctx() });
  const res = await proxy.forward(agentReq);
  assert.equal(res.status, 200);
  assert.equal(res.body, "no paywall here");
});

test("forward: a custom proof builder is attached on the retry", async () => {
  const { store, executor } = harness();
  store.insertMandate(mandate());
  seedKnown(store, "weather-api");
  const { upstream, calls } = payingUpstream();
  const proxy = createX402Proxy({
    executor,
    upstream,
    ctx: ctx(),
    buildProof: (result) => `X-PAYMENT ${result.receipt?.id}`,
  });

  const res = await proxy.forward(agentReq);
  assert.equal(res.status, 200);
  assert.ok(calls[1].proof?.startsWith("X-PAYMENT rcpt_"));
});
