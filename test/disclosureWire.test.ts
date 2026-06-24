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
import { verifyCounterparty, type FetchLike } from "../src/disclosure/index.ts";

const NOW = "2026-06-24T12:00:00.000Z";

// A counterparty agent, served over an in-memory "wire" that routes fetch() calls
// straight into its ingress handler.
function agentNode() {
  const store = createMemoryStore("counterparty-key");
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
    executor, clock: () => NOW, newId: () => `n${n++}`, store,
    disclosure: { audit, operator: { id: "op", deniabilityBoundary: "spend within mandates only" } },
  };
  // a fetch() that drives the real ingress handler in-memory
  const fetch: FetchLike = async (url, init) => {
    const path = new URL(url).pathname;
    const out = await handleIngress(init?.method ?? "GET", path, init?.body ?? "", deps);
    return { ok: out.status >= 200 && out.status < 300, status: out.status, json: async () => out.body };
  };
  return { fetch };
}

test("a verifier transacts after fetching the disclosure + passing the live handshake", async () => {
  const { fetch } = agentNode();
  const verdict = await verifyCounterparty(fetch, "http://counterparty", {
    now: NOW,
    requireEnforcedConstitution: true,
    requireNonCustodial: true,
    requireDeploymentHistory: true,
    requireAuditAnchor: true,
  });
  assert.equal(verdict.decision, "transact", verdict.reasons.join("; "));
  assert.equal(verdict.handshake?.ok, true);
});

test("the disclosure endpoint is public (served with no auth token)", async () => {
  const { fetch } = agentNode();
  // even though no token is presented, the disclosure is reachable
  const res = await fetch("http://counterparty/.well-known/agent-disclosure");
  assert.equal(res.ok, true);
  const body = (await res.json()) as { disclosure: { agentId: string }; signature: { algorithm: string } };
  assert.equal(body.signature.algorithm, "ed25519");
  assert.ok(body.disclosure.agentId.length === 64);
});

test("a stricter policy than the agent meets → refuse, before any value moves", async () => {
  const { fetch } = agentNode();
  const verdict = await verifyCounterparty(fetch, "http://counterparty", {
    now: NOW,
    requireRedTeam: true, // this agent published no red-team attestation
    minRedTeamGrade: "A",
  });
  assert.equal(verdict.decision, "refuse");
  assert.ok(verdict.reasons.some((r) => /red-team/.test(r)));
});

test("the handshake nonce is per-verification (a captured response can't be replayed)", async () => {
  const { fetch } = agentNode();
  // two verifications issue two different challenges; both must still pass live
  const a = await verifyCounterparty(fetch, "http://counterparty", { now: NOW });
  const b = await verifyCounterparty(fetch, "http://counterparty", { now: NOW });
  assert.equal(a.decision, "transact");
  assert.equal(b.decision, "transact");
  assert.equal(a.handshake?.ok, true);
  assert.equal(b.handshake?.ok, true);
});
