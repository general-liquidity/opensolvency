import test from "node:test";
import assert from "node:assert/strict";

import { handleIngress, type IngressDeps } from "../src/ingress/server.ts";
import { AuditLog } from "../src/core/audit.ts";
import { createExecutor } from "../src/core/executor.ts";
import { createMemoryStore } from "../src/store/memoryStore.ts";
import { createRailRegistry } from "../src/rails/registry.ts";
import { createFakeRail } from "../src/rails/fakeRail.ts";
import { DEFAULT_DENY_RULES } from "../src/core/denyList.ts";
import { DEFAULT_GATE_CONFIG, type Mandate } from "../src/core/types.ts";
import type { FetchLike } from "@general-liquidity/agent-disclosure";
import {
  requireCounterpartyDisclosure,
  disclosePreSettle,
  mutualSettleGuard,
} from "../src/disclosure/settleGuard.ts";

const NOW = "2026-06-24T12:00:00.000Z";

// A counterparty agent, served over an in-memory "wire" that routes fetch() calls
// straight into its ingress handler (mirrors test/disclosureWire.test.ts).
function agentNode(operatorId = "op") {
  const store = createMemoryStore(`${operatorId}-key`);
  store.insertMandate({
    id: "m1", label: "groceries", scope: { kind: "class", value: "groceries" }, currency: "GBP",
    allowedRails: ["card"], perTxCap: 500_00, perPeriodCap: 1000_00, period: "week",
    grantedAt: "2026-06-20T00:00:00.000Z", expiresAt: "2026-07-20T00:00:00.000Z", status: "active",
  } satisfies Mandate);
  const audit = new AuditLog(store.operatorKey());
  audit.append("gate.decision", { intentId: "pi1", outcome: "auto_execute" }, NOW);
  audit.append("payment.settled", { intentId: "pi1" }, NOW);

  const executor = createExecutor({
    store, rails: createRailRegistry([createFakeRail("card")]), audit,
    config: DEFAULT_GATE_CONFIG, denyRules: DEFAULT_DENY_RULES, clock: () => NOW,
  });
  let n = 0;
  const deps: IngressDeps = {
    executor, clock: () => NOW, newId: () => `${operatorId}-n${n++}`, store,
    disclosure: { audit, operator: { id: operatorId, deniabilityBoundary: "spend within mandates only" } },
  };
  const fetch: FetchLike = async (url, init) => {
    const path = new URL(url).pathname;
    const out = await handleIngress(init?.method ?? "GET", path, init?.body ?? "", deps);
    return { ok: out.status >= 200 && out.status < 300, status: out.status, json: async () => out.body };
  };
  return { fetch };
}

// A fetch that always fails the transport — an unreachable payee.
const unreachableFetch: FetchLike = async () => {
  throw new Error("ECONNREFUSED");
};

test("a compliant payee clears -> allow (value may move)", async () => {
  const { fetch } = agentNode();
  const { allow, verdict } = await requireCounterpartyDisclosure({
    fetch,
    payeeBaseUrl: "http://payee",
    policy: { now: NOW, requireEnforcedConstitution: true, requireNonCustodial: true, requireAuditAnchor: true },
  });
  assert.equal(allow, true, verdict.reasons.join("; "));
  assert.equal(verdict.decision, "transact");
});

test("a stricter policy than the payee meets -> refuse, before any value moves", async () => {
  const { fetch } = agentNode();
  const { allow, verdict } = await requireCounterpartyDisclosure({
    fetch,
    payeeBaseUrl: "http://payee",
    policy: { now: NOW, requireRedTeam: true, minRedTeamGrade: "A" },
  });
  assert.equal(allow, false);
  assert.ok(verdict.reasons.some((r) => /red-team/.test(r)));
});

test("an unreachable payee -> fail-closed refuse", async () => {
  const { allow, verdict } = await requireCounterpartyDisclosure({
    fetch: unreachableFetch,
    payeeBaseUrl: "http://payee",
    policy: { now: NOW },
  });
  assert.equal(allow, false);
  assert.equal(verdict.decision, "refuse");
});

test("disclosePreSettle: a rail with no configured disclosure URL -> allow with the documented note", async () => {
  const decision = await disclosePreSettle("x402", undefined, { fetch: unreachableFetch, policy: { now: NOW } });
  assert.equal(decision.allow, true);
  assert.match(decision.reason ?? "", /no disclosure endpoint/);
});

test("disclosePreSettle: a configured, compliant payee -> allow", async () => {
  const { fetch } = agentNode();
  const decision = await disclosePreSettle("ap2", "http://payee", {
    fetch,
    policy: { now: NOW, requireEnforcedConstitution: true, requireNonCustodial: true },
  });
  assert.equal(decision.allow, true, decision.reason);
});

test("disclosePreSettle: a configured payee that fails policy -> refuse, with the rail named", async () => {
  const { fetch } = agentNode();
  const decision = await disclosePreSettle("ap2", "http://payee", {
    fetch,
    policy: { now: NOW, requireRedTeam: true, minRedTeamGrade: "A" },
  });
  assert.equal(decision.allow, false);
  assert.match(decision.reason ?? "", /^rail ap2:/);
});

test("mutualSettleGuard: transacts when both sides clear", async () => {
  const us = agentNode("us");
  const them = agentNode("them");
  const { allow, verdict } = await mutualSettleGuard({
    ourFetch: us.fetch,
    ourBaseUrl: "http://us",
    theirFetch: them.fetch,
    theirBaseUrl: "http://them",
    ourPolicy: { now: NOW, requireEnforcedConstitution: true, requireNonCustodial: true },
    theirPolicy: { now: NOW, requireEnforcedConstitution: true, requireNonCustodial: true },
  });
  assert.equal(allow, true, verdict.reasons.join("; "));
  assert.equal(verdict.decision, "transact");
});

test("mutualSettleGuard: refuses when one side fails", async () => {
  const us = agentNode("us");
  const them = agentNode("them");
  const { allow, verdict } = await mutualSettleGuard({
    ourFetch: us.fetch,
    ourBaseUrl: "http://us",
    theirFetch: them.fetch,
    theirBaseUrl: "http://them",
    // We demand a red-team grade the counterparty does not publish -> our leg refuses.
    ourPolicy: { now: NOW, requireRedTeam: true, minRedTeamGrade: "A" },
    theirPolicy: { now: NOW, requireEnforcedConstitution: true, requireNonCustodial: true },
  });
  assert.equal(allow, false);
  assert.equal(verdict.decision, "refuse");
});
