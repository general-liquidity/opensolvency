// Audit-log export + standalone verification — "tamper-evidence as a portable
// utility." The signed, hash-linked chain can be exported to a plain file and
// later verified by anyone holding the operator key, WITHOUT the live store /
// executor / AuditLog instance that produced it. Verification reuses the exact
// AuditLog.verify() logic (re-seeded from the exported entries), so there is no
// second hashing implementation to drift out of sync.
//
// Note: signatures are HMAC-SHA256 (symmetric) — verification needs the operator
// key, so this proves integrity to a holder of that key (the operator or an auditor
// they share it with), not to the public. Asymmetric (Ed25519) signing for public
// verifiability is a future enhancement; the chain + hashes are unaffected.

import { AuditLog, type AuditEntry, type VerifyResult } from "../core/audit.ts";

export type AuditExportFormat = "json" | "jsonl";

/** Serialize the chain to a portable string. `jsonl` (default) is one entry per
 *  line — append-friendly and diff-friendly; `json` is a single array. */
export function exportAuditChain(
  entries: readonly AuditEntry[],
  format: AuditExportFormat = "jsonl",
): string {
  if (format === "json") return JSON.stringify(entries, null, 2);
  return entries.map((e) => JSON.stringify(e)).join("\n");
}

/** Parse an exported chain (either format) back into entries. */
export function parseAuditExport(serialized: string): AuditEntry[] {
  const trimmed = serialized.trim();
  if (!trimmed) return [];
  if (trimmed[0] === "[") return JSON.parse(trimmed) as AuditEntry[];
  return trimmed
    .split("\n")
    .filter((l) => l.trim().length > 0)
    .map((l) => JSON.parse(l) as AuditEntry);
}

/**
 * Verify an EXPORTED chain standalone: recompute every hash link + signature from
 * the exported entries and the operator key. Returns the first break, if any. No
 * store, executor, or original AuditLog needed.
 */
export function verifyAuditExport(serialized: string, operatorKey: string): VerifyResult {
  const entries = parseAuditExport(serialized);
  return new AuditLog(operatorKey, entries).verify();
}
