import test from "node:test";
import assert from "node:assert/strict";

import { AuditLog } from "../src/core/audit.ts";
import { createMemoryStore } from "../src/store/memoryStore.ts";
import { scoreSpendTrust, REFERENCE_SUBMISSIONS } from "../src/benchmark/spendTrust.ts";
import type { Mandate } from "../src/core/types.ts";
import {
  generateAgentKeyPair,
  buildAndSignDisclosure,
  buildAgentDisclosure,
  verifyDisclosureSignature,
  evaluateDisclosure,
  signDisclosure,
  type BuildDisclosureDeps,
} from "../src/disclosure/index.ts";

const NOW = "2026-06-24T12:00:00.000Z";

function deps(): BuildDisclosureDeps {
  const store = createMemoryStore("op-key");
  store.insertMandate({
    id: "m1", label: "groceries", scope: { kind: "class", value: "groceries" }, currency: "GBP",
    allowedRails: ["card"], perTxCap: 500_00, perPeriodCap: 1000_00, period: "week",
    grantedAt: "2026-06-20T00:00:00.000Z", expiresAt: "2026-07-20T00:00:00.000Z", status: "active",
  } satisfies Mandate);
  const audit = new AuditLog(store.operatorKey());
  audit.append("gate.decision", { intentId: "pi1", outcome: "auto_execute" }, NOW);
  audit.append("payment.settled", { intentId: "pi1" }, NOW);
  audit.append("gate.decision", { intentId: "pi2", outcome: "block" }, NOW);

  return {
    store, audit,
    agentKey: generateAgentKeyPair(),
    systemPrompt: "You are the operator's spending agent. Every payment passes the gate.",
    operator: { id: "op_xyz", deniabilityBoundary: "Authorizes spend within mandates only.", attestation: { scheme: "AIP", level: "registry_attested" } },
    now: NOW, nonce: "nonce-1",
    spendTrust: { corpus: { name: "spendtrust", version: "0.1.1" }, result: scoreSpendTrust(REFERENCE_SUBMISSIONS[0]) },
  };
}

test("builds a disclosure populated from the live gate / mandates / audit / spendtrust", () => {
  const d = buildAgentDisclosure(deps());
  // constitution comes from the enforced deny-list
  assert.equal(d.constitution.enforced, true);
  assert.ok(d.constitution.hardConstraints.some((c) => c.id === "irreversible_to_unknown_payee"));
  // capital from the granted mandate
  assert.equal(d.capital.mandates[0].label, "groceries");
  assert.equal(d.capital.custody, "non_custodial");
  // history from the audit chain (2 gate decisions, 1 settle, 1 block)
  assert.equal(d.history.summary.totalDecisions, 2);
  assert.equal(d.history.summary.settledCount, 1);
  assert.equal(d.history.summary.blockedCount, 1);
  assert.notEqual(d.auditAnchor, "0".repeat(64)); // bound to a real chain head
  // red-team from the trustworthy reference agent → grade A
  assert.equal(d.redTeam?.result.grade, "A");
  // agentId is the signing public key
  assert.equal(d.agentId.length, 64);
});

test("a built+signed disclosure verifies, and a counterparty policy says transact", () => {
  const signed = buildAndSignDisclosure(deps());
  assert.equal(verifyDisclosureSignature(signed).ok, true);

  const verdict = evaluateDisclosure(signed, {
    now: NOW,
    requireEnforcedConstitution: true,
    requiredHardConstraints: ["irreversible_to_unknown_payee"],
    requireRedTeam: true,
    minRedTeamGrade: "B",
    requireNonCustodial: true,
    minAttestationLevel: "signed",
    requireDeploymentHistory: true,
    requireAuditAnchor: true,
  });
  assert.equal(verdict.decision, "transact", verdict.reasons.join("; "));
});

test("tampering with the signed disclosure breaks the signature", () => {
  const signed = buildAndSignDisclosure(deps());
  // raise the per-tx cap after signing
  signed.disclosure.capital.mandates[0].perTxCapMinor = 9_999_99;
  assert.equal(verifyDisclosureSignature(signed).ok, false);
});

test("a forged agentId (signed by a different key) is rejected", () => {
  const signed = buildAndSignDisclosure(deps());
  signed.disclosure.agentId = "f".repeat(64); // claim a different identity (not re-signed)
  const r = verifyDisclosureSignature(signed);
  assert.equal(r.ok, false);
  // ADP v2 verifies the signature before the agentId↔key binding; since agentId is part
  // of the signed document, tampering it is caught as a signature mismatch either way.
  assert.match(r.reason ?? "", /signature mismatch|agentId/);
});

test("policy refuses when the red-team grade is too low", () => {
  const d = deps();
  // attest a failing agent (the injector → hard fail, grade F)
  d.spendTrust = { corpus: { name: "spendtrust", version: "0.1.1" }, result: scoreSpendTrust(REFERENCE_SUBMISSIONS[2]) };
  const signed = buildAndSignDisclosure(d);
  const verdict = evaluateDisclosure(signed, { now: NOW, requireRedTeam: true, minRedTeamGrade: "B" });
  assert.equal(verdict.decision, "refuse");
  assert.ok(verdict.reasons.some((r) => /grade/.test(r)));
});

test("policy refuses a stale disclosure", () => {
  const signed = buildAndSignDisclosure(deps());
  const verdict = evaluateDisclosure(signed, { now: "2026-07-01T00:00:00.000Z" }); // past validUntil
  assert.equal(verdict.decision, "refuse");
  assert.ok(verdict.reasons.some((r) => /fresh/.test(r)));
});

test("an unenforced constitution is refused under requireEnforcedConstitution", () => {
  const d = buildAgentDisclosure(deps());
  d.constitution.enforced = false;
  const signed = signDisclosure(d, deps().agentKey); // re-sign with a key (sig will still bind agentId of THIS key)
  // re-point agentId to the re-signing key so the signature check passes and we isolate the policy check
  const verdict = evaluateDisclosure(
    { ...signed, disclosure: { ...d, agentId: signed.signature.publicKey } },
    { now: NOW, requireValidSignature: false, requireEnforcedConstitution: true },
  );
  assert.equal(verdict.decision, "refuse");
  assert.ok(verdict.reasons.some((r) => /enforced/.test(r)));
});
