import test from "node:test";
import assert from "node:assert/strict";

import { AuditLog } from "../src/core/audit.ts";
import type { Mandate } from "../src/core/types.ts";
import { deployerOversightReport } from "../src/compliance/oversight.ts";
import {
  exportCompliancePackage,
  verifyCompliancePackage,
  exportAuditChain,
} from "../src/audit/export.ts";

const KEY = "0123456789abcdef0123456789abcdef";
const T = (h: number) => `2026-06-${10 + h}T12:00:00.000Z`;

// A fixture chain with a known shape:
//   2 auto-executed (agent / auto_execute) — GBP 1000 + 2000
//   1 operator-confirmed (operator_approval / auto_execute) — GBP 3000
//   3 blocked (block) — 1 of which is a deny-list hit
//   plus the mandate.granted / settled / parking entries those imply
function buildChain(): AuditLog {
  const a = new AuditLog(KEY);
  a.append("mandate.granted", { id: "m1", label: "groceries" }, T(0));

  // auto-exec #1
  a.append(
    "gate.decision",
    {
      phase: "agent",
      outcome: "auto_execute",
      reasons: ["within mandate"],
      mandateId: "m1",
      intent: { amount: 1000, currency: "GBP" },
    },
    T(1),
  );
  a.append("payment.settled", { intentId: "pi1", amount: 1000, currency: "GBP" }, T(1));

  // auto-exec #2
  a.append(
    "gate.decision",
    {
      phase: "agent",
      outcome: "auto_execute",
      reasons: ["within mandate"],
      mandateId: "m1",
      intent: { amount: 2000, currency: "GBP" },
    },
    T(2),
  );
  a.append("payment.settled", { intentId: "pi2", amount: 2000, currency: "GBP" }, T(2));

  // operator-confirmed: parked (agent/confirm_operator) then approved (operator_approval/auto_execute)
  a.append(
    "gate.decision",
    {
      phase: "agent",
      outcome: "confirm_operator",
      reasons: ["novel payee"],
      mandateId: "m1",
      intent: { amount: 3000, currency: "GBP" },
    },
    T(3),
  );
  a.append(
    "gate.decision",
    {
      phase: "operator_approval",
      outcome: "auto_execute",
      operatorRationale: "vetted the payee",
      acknowledged: true,
      reasons: ["operator approved"],
      mandateId: "m1",
      intent: { amount: 3000, currency: "GBP" },
    },
    T(3),
  );
  a.append("payment.settled", { intentId: "pi3", amount: 3000, currency: "GBP" }, T(3));

  // blocked #1 — deny-list hit
  a.append(
    "gate.decision",
    {
      phase: "agent",
      outcome: "block",
      reasons: ["deny-list: irreversible payment to a payee with no prior history"],
      mandateId: null,
      intent: { amount: 9999, currency: "GBP" },
    },
    T(4),
  );
  // blocked #2 — cap breach (not deny-list)
  a.append(
    "gate.decision",
    {
      phase: "agent",
      outcome: "block",
      reasons: ["per-tx cap exceeded"],
      mandateId: "m1",
      intent: { amount: 500000, currency: "GBP" },
    },
    T(5),
  );
  // blocked #3 — another deny-list hit, same reason (dedup in reasons list)
  a.append(
    "gate.decision",
    {
      phase: "agent",
      outcome: "block",
      reasons: ["deny-list: irreversible payment to a payee with no prior history"],
      mandateId: null,
      intent: { amount: 6000, currency: "GBP" },
    },
    T(6),
  );

  // revoke at the end
  a.append("mandate.revoked", { id: "m1" }, T(7));
  return a;
}

const PERIOD = { start: "2026-06-09T00:00:00.000Z", end: "2026-06-30T00:00:00.000Z" };

function mandates(): Mandate[] {
  return [
    {
      id: "m1",
      label: "groceries",
      scope: { kind: "class", value: "groceries" },
      currency: "GBP",
      allowedRails: ["card"],
      perTxCap: 100000,
      perPeriodCap: 1000000,
      period: "month",
      grantedAt: T(0),
      // revoked → not active at end regardless of expiry
      expiresAt: "2026-12-01T00:00:00.000Z",
      status: "revoked",
    },
    {
      id: "m2",
      label: "saas",
      scope: { kind: "class", value: "saas" },
      currency: "USD",
      allowedRails: ["card"],
      perTxCap: 50000,
      perPeriodCap: 500000,
      period: "month",
      grantedAt: T(0),
      expiresAt: "2026-12-01T00:00:00.000Z",
      status: "active",
    },
  ];
}

test("report counts auto-executed / operator-confirmed / blocked correctly", () => {
  const a = buildChain();
  const report = deployerOversightReport({
    audit: a.entries(),
    mandates: mandates(),
    integrity: a.verify(),
    period: PERIOD,
  });

  assert.equal(report.humanOversight.autoExecuted.count, 2);
  assert.equal(report.humanOversight.operatorConfirmed.count, 1);
  assert.equal(report.humanOversight.blocked.count, 3);
});

test("report sums per-currency totals over the classified spends", () => {
  const a = buildChain();
  const report = deployerOversightReport({
    audit: a.entries(),
    mandates: mandates(),
    integrity: a.verify(),
    period: PERIOD,
  });

  assert.equal(report.humanOversight.autoExecuted.totalByCurrency.GBP, 3000); // 1000 + 2000
  assert.equal(report.humanOversight.operatorConfirmed.totalByCurrency.GBP, 3000);
  assert.equal(report.humanOversight.blocked.totalByCurrency.GBP, 9999 + 500000 + 6000);
  // settled is authoritative for money that actually moved
  assert.equal(report.monitoring.settled.totalByCurrency.GBP, 1000 + 2000 + 3000);
});

test("deny-list hits counted; reasons deduplicated", () => {
  const a = buildChain();
  const report = deployerOversightReport({
    audit: a.entries(),
    mandates: mandates(),
    integrity: a.verify(),
    period: PERIOD,
  });
  assert.equal(report.humanOversight.denyListHits, 2);
  assert.deepEqual(report.humanOversight.denyListReasons, [
    "irreversible payment to a payee with no prior history",
  ]);
});

test("monitoring tracks grants / revokes / active-at-end", () => {
  const a = buildChain();
  const report = deployerOversightReport({
    audit: a.entries(),
    mandates: mandates(),
    integrity: a.verify(),
    period: PERIOD,
  });
  assert.equal(report.monitoring.mandatesGranted, 1);
  assert.equal(report.monitoring.mandatesRevoked, 1);
  // m1 is revoked, m2 is active and unexpired at end
  assert.equal(report.monitoring.mandatesActiveAtEnd, 1);
});

test("all Article 26 sections are present", () => {
  const a = buildChain();
  const report = deployerOversightReport({
    audit: a.entries(),
    mandates: mandates(),
    integrity: a.verify(),
    period: PERIOD,
  });
  assert.equal(report.standard, "EU AI Act Article 26 (deployer obligations)");
  assert.ok(report.humanOversight); // Art. 26(1)/(2)
  assert.ok(report.monitoring); // Art. 26(5)
  assert.ok(report.recordKeeping); // Art. 26(6)
  assert.ok(report.recordKeeping.integrity);
});

test("period window excludes entries outside [start, end)", () => {
  const a = buildChain();
  const narrow = { start: T(1), end: T(3) }; // [hour 1, hour 3) → excludes hour 3 + later
  const report = deployerOversightReport({
    audit: a.entries(),
    mandates: mandates(),
    integrity: a.verify(),
    period: narrow,
  });
  // only the two auto-exec decisions at T(1) and T(2) land
  assert.equal(report.humanOversight.autoExecuted.count, 2);
  assert.equal(report.humanOversight.operatorConfirmed.count, 0);
  assert.equal(report.humanOversight.blocked.count, 0);
});

test("integrity verdict PASSES for an intact chain", () => {
  const a = buildChain();
  const report = deployerOversightReport({
    audit: a.entries(),
    mandates: mandates(),
    integrity: a.verify(),
    period: PERIOD,
  });
  assert.equal(report.recordKeeping.integrity.valid, true);
  assert.equal(report.recordKeeping.integrity.brokenAt, null);
});

test("integrity verdict FAILS for a tampered chain", () => {
  const a = buildChain();
  const tampered = a.entries().map((e) => ({ ...e }));
  (tampered[2] as { payload: unknown }).payload = { intentId: "pi1", amount: 999999, currency: "GBP" };
  const verdict = new AuditLog(KEY, tampered).verify();
  const report = deployerOversightReport({
    audit: tampered,
    mandates: mandates(),
    integrity: verdict,
    period: PERIOD,
  });
  assert.equal(report.recordKeeping.integrity.valid, false);
  assert.equal(report.recordKeeping.integrity.brokenAt, 2);
});

// --- compliance package -------------------------------------------------------

test("compliance package bundles chain + report + integrity proof", () => {
  const a = buildChain();
  const pkg = exportCompliancePackage({
    entries: a.entries(),
    mandates: mandates(),
    period: PERIOD,
    operatorKey: KEY,
  });
  assert.equal(pkg.version, 1);
  assert.equal(pkg.oversight.humanOversight.autoExecuted.count, 2);
  assert.equal(pkg.integrity.entryCount, a.entries().length);
  assert.equal(pkg.integrity.tip?.seq, a.entries().length - 1);
  assert.equal(pkg.integrity.verdict.valid, true);
});

test("an intact compliance package verifies standalone with the operator key", () => {
  const a = buildChain();
  const pkg = exportCompliancePackage({
    entries: a.entries(),
    mandates: mandates(),
    period: PERIOD,
    operatorKey: KEY,
  });
  const v = verifyCompliancePackage(pkg, KEY);
  assert.equal(v.valid, true);
  assert.deepEqual(v.reasons, []);
  assert.equal(v.chain.valid, true);
});

test("a tampered compliance-package chain fails verification", () => {
  const a = buildChain();
  const pkg = exportCompliancePackage({
    entries: a.entries(),
    mandates: mandates(),
    period: PERIOD,
    operatorKey: KEY,
  });
  // tamper the bundled chain
  const entries = a.entries().map((e) => ({ ...e }));
  (entries[2] as { payload: unknown }).payload = { hacked: true };
  pkg.chain = exportAuditChain(entries);
  const v = verifyCompliancePackage(pkg, KEY);
  assert.equal(v.valid, false);
  assert.equal(v.chain.valid, false);
  assert.ok(v.reasons.some((r) => /chain integrity failed/.test(r)));
});

test("a forged integrity verdict is caught", () => {
  const a = buildChain();
  const pkg = exportCompliancePackage({
    entries: a.entries(),
    mandates: mandates(),
    period: PERIOD,
    operatorKey: KEY,
  });
  // tamper the chain but lie about it in the proof (claim still valid)
  const entries = a.entries().map((e) => ({ ...e }));
  (entries[1] as { payload: unknown }).payload = { hacked: true };
  pkg.chain = exportAuditChain(entries);
  // verdict left as valid:true → contradiction must be detected
  const v = verifyCompliancePackage(pkg, KEY);
  assert.equal(v.valid, false);
  assert.ok(
    v.reasons.some((r) => /verdict does not match/.test(r)),
    `reasons: ${v.reasons.join("; ")}`,
  );
});

test("the wrong key fails package verification", () => {
  const a = buildChain();
  const pkg = exportCompliancePackage({
    entries: a.entries(),
    mandates: mandates(),
    period: PERIOD,
    operatorKey: KEY,
  });
  const v = verifyCompliancePackage(pkg, "ffffffffffffffffffffffffffffffff");
  assert.equal(v.valid, false);
  assert.equal(v.chain.valid, false);
});
