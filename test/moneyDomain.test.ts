import { test } from "node:test";
import assert from "node:assert/strict";

import { reconcile, type SettledPayment, type StatementLine } from "../src/finance/reconcile.ts";
import {
  createFakeAccountConnector,
  statementToObservations,
  statementToPayments,
} from "../src/connectors/account.ts";
import { staticKeyProvider, EnvKeyProvider } from "../src/core/keyCustody.ts";
import { templateMandate } from "../src/core/mandateTemplates.ts";

const NOW = "2026-05-30T12:00:00.000Z";

// --- reconciliation ---
test("reconcile matches payments to statement and flags unauthorized spend", () => {
  const payments: SettledPayment[] = [
    { intentId: "pi_1", payee: "tesco", amountMinor: 80_00, currency: "GBP", at: NOW },
    { intentId: "pi_2", payee: "spotify", amountMinor: 10_00, currency: "GBP", at: NOW },
  ];
  const lines: StatementLine[] = [
    { amountMinor: 80_00, currency: "GBP", descriptor: "TESCO", at: "2026-05-30T13:00:00.000Z" },
    { amountMinor: 999_00, currency: "GBP", descriptor: "UNKNOWN CASINO", at: NOW }, // not authorized
  ];
  const r = reconcile(payments, lines);
  assert.equal(r.matched.length, 1);
  assert.equal(r.unmatchedPayments.length, 1); // spotify not yet on statement
  assert.equal(r.unmatchedStatement.length, 1); // the casino line — flag it
  assert.equal(r.unmatchedStatement[0].descriptor, "UNKNOWN CASINO");
});

// --- account connector (non-custodial, read-only) ---
test("the account connector is read-only and feeds reconcile/watch", () => {
  const conn = createFakeAccountConnector({
    balances: [{ account: "current", currency: "GBP", availableMinor: 1200_00 }],
    statement: [{ amountMinor: 80_00, currency: "GBP", descriptor: "TESCO", at: NOW }],
  });
  // Structural non-custodial guarantee: no transfer/pay method exists.
  assert.equal("getBalances" in conn, true);
  assert.equal("transfer" in conn, false);
  assert.equal((conn.getBalances() as { availableMinor: number }[])[0].availableMinor, 1200_00);
  const stmt = conn.getStatement("2026-05-01T00:00:00.000Z") as StatementLine[];
  assert.equal(statementToObservations(stmt)[0].amountMinor, 80_00);
  assert.equal(statementToPayments(stmt)[0].payee, "TESCO");
});

// --- key custody ---
test("key providers supply the audit key from custody, not the DB", () => {
  assert.equal(staticKeyProvider("k123").current().material.toString(), "k123");
  assert.throws(() => staticKeyProvider(""));
  process.env.AGENTWORTH_AUDIT_KEY = "env-key";
  assert.equal(new EnvKeyProvider().current().material.toString(), "env-key");
  delete process.env.AGENTWORTH_AUDIT_KEY;
});

// --- mandate templates ---
test("a mandate template produces a sensible, valid mandate", () => {
  const m = templateMandate("groceries", {
    id: "m1",
    currency: "GBP",
    grantedAt: NOW,
    expiresAt: "2026-12-01T00:00:00.000Z",
  });
  assert.equal(m.scope.kind === "class" && m.scope.value, "groceries");
  assert.ok(m.allowedRails.includes("card"));
  assert.equal(m.period, "week");
  assert.ok(m.perTxCap > 0 && m.perPeriodCap >= m.perTxCap);
});
