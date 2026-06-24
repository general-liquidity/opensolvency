import test from "node:test";
import assert from "node:assert/strict";

import { exportAuditChain, parseAuditExport, verifyAuditExport } from "../src/audit/export.ts";
import { AuditLog } from "../src/core/audit.ts";

const KEY = "0123456789abcdef0123456789abcdef";
const NOW = "2026-06-24T12:00:00.000Z";

function chain(): AuditLog {
  const a = new AuditLog(KEY);
  a.append("mandate.granted", { id: "m1" }, NOW);
  a.append("gate.decision", { intentId: "pi1", outcome: "auto_execute" }, NOW);
  a.append("payment.settled", { intentId: "pi1", receiptId: "r1" }, NOW);
  return a;
}

test("export round-trips through both formats", () => {
  const a = chain();
  for (const fmt of ["jsonl", "json"] as const) {
    const parsed = parseAuditExport(exportAuditChain(a.entries(), fmt));
    assert.equal(parsed.length, 3);
    assert.equal(parsed[2].type, "payment.settled");
  }
});

test("an exported chain verifies standalone with the operator key", () => {
  const dump = exportAuditChain(chain().entries());
  const r = verifyAuditExport(dump, KEY);
  assert.equal(r.valid, true);
  assert.equal(r.brokenAt, null);
});

test("a tampered exported entry fails standalone verification", () => {
  const entries = chain().entries().map((e) => ({ ...e }));
  // tamper with the settled amount-bearing payload of seq 2
  (entries[2] as { payload: unknown }).payload = { intentId: "pi1", receiptId: "HACKED" };
  const dump = exportAuditChain(entries);
  const r = verifyAuditExport(dump, KEY);
  assert.equal(r.valid, false);
  assert.equal(r.brokenAt, 2);
});

test("the wrong key fails verification (signature mismatch)", () => {
  const dump = exportAuditChain(chain().entries());
  const r = verifyAuditExport(dump, "ffffffffffffffffffffffffffffffff");
  assert.equal(r.valid, false);
  assert.match(r.reason ?? "", /signature/);
});
