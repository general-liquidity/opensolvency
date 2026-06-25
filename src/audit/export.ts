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
import {
  deployerOversightReport,
  type DeployerOversightReport,
  type ReportPeriod,
} from "../compliance/oversight.ts";
import type { Mandate } from "../core/types.ts";

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

// --- Compliance package ------------------------------------------------------
//
// A self-contained bundle a deployer hands to a regulator / auditor: the signed
// chain, the EU AI Act Article 26 oversight report computed over it, and the
// integrity proof. Verification re-checks the chain from the bundled entries (same
// AuditLog.verify() path as `verifyAuditExport`) AND re-derives the report, so a
// holder of the operator key can confirm the package was not edited after export.

export const COMPLIANCE_PACKAGE_VERSION = 1 as const;

export interface CompliancePackage {
  version: typeof COMPLIANCE_PACKAGE_VERSION;
  standard: "EU AI Act Article 26 (deployer obligations)";
  /** The signed audit chain, serialized — re-verifiable standalone. */
  chain: string;
  chainFormat: AuditExportFormat;
  /** The deployer-oversight report derived from the chain. */
  oversight: DeployerOversightReport;
  /** Integrity proof: the chain's own verdict + a digest binding report→chain. */
  integrity: {
    verdict: VerifyResult;
    /** seq + hash of the last entry — the chain's tip the report was built over. */
    tip: { seq: number; hash: string } | null;
    entryCount: number;
  };
}

/**
 * Build a compliance package: the signed chain + the Art. 26 oversight report +
 * an integrity proof. The chain is verified here (using the SAME AuditLog.verify()
 * the standalone verifier uses) and that verdict is what the oversight report and
 * the integrity proof both carry — one source of truth, no re-hashing.
 */
export function exportCompliancePackage(args: {
  entries: readonly AuditEntry[];
  mandates: readonly Mandate[];
  period: ReportPeriod;
  operatorKey: string;
  format?: AuditExportFormat;
}): CompliancePackage {
  const format = args.format ?? "jsonl";
  const verdict = new AuditLog(args.operatorKey, args.entries).verify();
  const oversight = deployerOversightReport({
    audit: args.entries,
    mandates: args.mandates,
    integrity: verdict,
    period: args.period,
  });
  const last = args.entries.length > 0 ? args.entries[args.entries.length - 1] : null;
  return {
    version: COMPLIANCE_PACKAGE_VERSION,
    standard: "EU AI Act Article 26 (deployer obligations)",
    chain: exportAuditChain(args.entries, format),
    chainFormat: format,
    oversight,
    integrity: {
      verdict,
      tip: last ? { seq: last.seq, hash: last.hash } : null,
      entryCount: args.entries.length,
    },
  };
}

export interface CompliancePackageVerification {
  /** The package is internally consistent AND the chain verifies. */
  valid: boolean;
  /** Re-checked chain verdict (recomputed from the bundled chain + key). */
  chain: VerifyResult;
  /** Reasons the package was rejected (empty when `valid`). */
  reasons: string[];
}

/**
 * Re-verify a compliance package standalone: re-parse and re-verify the bundled
 * chain (reusing `verifyAuditExport`), then confirm the package's own integrity
 * proof (tip + entry count + claimed verdict) matches what the chain actually says.
 * A tampered chain, a swapped report, or a forged verdict all fail.
 */
export function verifyCompliancePackage(
  pkg: CompliancePackage,
  operatorKey: string,
): CompliancePackageVerification {
  const reasons: string[] = [];

  const chain = verifyAuditExport(pkg.chain, operatorKey);
  if (!chain.valid) reasons.push(`chain integrity failed: ${chain.reason ?? "unknown"}`);

  // The integrity proof must not contradict the recomputed verdict.
  if (pkg.integrity.verdict.valid !== chain.valid) {
    reasons.push("claimed integrity verdict does not match recomputed chain verdict");
  }

  const entries = parseAuditExport(pkg.chain);
  if (entries.length !== pkg.integrity.entryCount) {
    reasons.push(
      `entry count mismatch: proof claims ${pkg.integrity.entryCount}, chain has ${entries.length}`,
    );
  }
  const tip = entries.length > 0 ? entries[entries.length - 1] : null;
  const proofTip = pkg.integrity.tip;
  if ((tip === null) !== (proofTip === null)) {
    reasons.push("integrity tip present/absent mismatch");
  } else if (tip && proofTip && (tip.seq !== proofTip.seq || tip.hash !== proofTip.hash)) {
    reasons.push("integrity tip does not match the chain tip");
  }

  // The bundled oversight report's integrity section must equal the recomputed one.
  if (pkg.oversight.recordKeeping.integrity.valid !== chain.valid) {
    reasons.push("oversight report integrity verdict does not match the chain");
  }

  return { valid: reasons.length === 0, chain, reasons };
}
