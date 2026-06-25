// EU AI Act Article 26 — deployer-oversight report.
//
// Article 26 puts obligations on the DEPLOYER of a high-risk AI system (here: the
// operator running an agent that spends money). This module projects OpenSolvency's
// signed audit chain + mandate set into the three obligations a regulator checks:
//
//   - human oversight (Art. 26(1)/(2)): the intervention points — what the agent
//     auto-executed under a mandate vs what the operator had to confirm vs what was
//     structurally blocked, plus the deny-list (the non-overridable floor).
//   - record-keeping (Art. 26(6)): the audit logs are kept and tamper-evident —
//     the chain integrity verdict, computed from the signed hash-linked log.
//   - monitoring (Art. 26(5)): authorizations granted/revoked over the period and
//     the spend the system actually moved.
//
// PURE. No I/O, no clock. Everything is derived from the entries + mandates the
// caller already holds, exactly like the rest of the kernel. The integrity verdict
// reuses AuditLog.verify() — there is no second hashing implementation here.

import type { AuditEntry, AuditEventType, VerifyResult } from "../core/audit.ts";
import type { Mandate } from "../core/types.ts";

/** Half-open [start, end) ISO window the report covers. Entries with `ts` inside
 * the window are counted; mandates are reported by their grant/revoke instants. */
export interface ReportPeriod {
  start: string; // ISO (inclusive)
  end: string; // ISO (exclusive)
}

/** A single spend, classified by the human-oversight path it took. */
export type SpendDisposition = "auto_executed" | "operator_confirmed" | "blocked";

export interface SpendBucket {
  count: number;
  /** Summed minor-units, per currency — money is never cross-currency added. */
  totalByCurrency: Record<string, number>;
}

/** Art. 26(1)/(2) — the human-oversight surface. */
export interface HumanOversightSection {
  /** Agent moved money under a mandate with no live human in the loop. */
  autoExecuted: SpendBucket;
  /** Gate parked the spend; a human operator explicitly confirmed it. */
  operatorConfirmed: SpendBucket;
  /** Structurally refused — caps, halt/kill-switch, or the deny-list. */
  blocked: SpendBucket;
  /** Count of blocks attributable to the non-overridable hard deny-list. */
  denyListHits: number;
  /** The distinct deny-list reasons that fired, for the regulator's narrative. */
  denyListReasons: string[];
}

/** Art. 26(5) — monitoring: the authorizations and the realized spend. */
export interface MonitoringSection {
  mandatesGranted: number;
  mandatesRevoked: number;
  /** Mandates active (granted, not revoked, not expired) at `period.end`. */
  mandatesActiveAtEnd: number;
  /** Settlements that actually moved money in the window (read-back confirmed or
   * not — `settled` means the rail issued a receipt). Per-currency totals. */
  settled: SpendBucket;
}

/** Art. 26(6) — record-keeping: the logs are kept and tamper-evident. */
export interface RecordKeepingSection {
  /** Total signed entries in the chain (whole chain, not just the window — the
   * integrity proof is over the entire linked log). */
  totalEntries: number;
  /** Entries whose `ts` falls inside the reporting window. */
  entriesInPeriod: number;
  /** Chain integrity verdict from AuditLog.verify(). */
  integrity: VerifyResult;
}

export interface DeployerOversightReport {
  standard: "EU AI Act Article 26 (deployer obligations)";
  period: ReportPeriod;
  humanOversight: HumanOversightSection;
  monitoring: MonitoringSection;
  recordKeeping: RecordKeepingSection;
}

export interface DeployerOversightInput {
  /** The full signed entries (oldest first) — typically `audit.entries()`. */
  audit: readonly AuditEntry[];
  /** The mandate set as of the report — typically `store.listMandates()`. */
  mandates: readonly Mandate[];
  /** Independently-computed chain integrity verdict (`audit.verify()` /
   * `verifyAuditExport`). Injected so this module stays pure and never re-hashes. */
  integrity: VerifyResult;
  period: ReportPeriod;
}

const DENY_PREFIX = "deny-list:";

function inPeriod(ts: string, period: ReportPeriod): boolean {
  return ts >= period.start && ts < period.end;
}

function emptyBucket(): SpendBucket {
  return { count: 0, totalByCurrency: {} };
}

function addToBucket(
  bucket: SpendBucket,
  amount: number | undefined,
  currency: string | undefined,
): void {
  bucket.count += 1;
  if (typeof amount === "number" && typeof currency === "string") {
    bucket.totalByCurrency[currency] = (bucket.totalByCurrency[currency] ?? 0) + amount;
  }
}

// The `gate.decision` payload shape we read. Recorded by the executor; only the
// fields this report needs are typed here (the entry payload is `unknown`).
interface GateDecisionPayload {
  phase?: "agent" | "operator_approval";
  outcome?: "auto_execute" | "confirm_operator" | "block";
  reasons?: string[];
  intent?: { amount?: number; currency?: string };
}

interface SettledPayload {
  amount?: number;
  currency?: string;
}

function asPayload<T>(entry: AuditEntry): T {
  return entry.payload as T;
}

/**
 * Project the audit chain + mandates into an EU AI Act Article 26 deployer-oversight
 * report. Deterministic and side-effect free.
 *
 * Classification of the human-oversight surface keys off `gate.decision` entries,
 * which carry both the outcome and (on the agent phase) the intent amount:
 *   - auto_executed:      phase=agent,            outcome=auto_execute
 *   - operator_confirmed: phase=operator_approval, outcome=auto_execute
 *   - blocked:            any phase,               outcome=block
 * The parking event (phase=agent, outcome=confirm_operator) is the precursor to an
 * operator decision, not a terminal spend, so it is not bucketed — the terminal
 * operator_approval decision is. Settlement totals come from `payment.settled`,
 * which is the authoritative record that money actually moved.
 */
export function deployerOversightReport(
  input: DeployerOversightInput,
): DeployerOversightReport {
  const { audit, mandates, integrity, period } = input;

  const humanOversight: HumanOversightSection = {
    autoExecuted: emptyBucket(),
    operatorConfirmed: emptyBucket(),
    blocked: emptyBucket(),
    denyListHits: 0,
    denyListReasons: [],
  };
  const denyReasons = new Set<string>();

  const monitoring: MonitoringSection = {
    mandatesGranted: 0,
    mandatesRevoked: 0,
    mandatesActiveAtEnd: 0,
    settled: emptyBucket(),
  };

  let entriesInPeriod = 0;

  for (const entry of audit) {
    if (!inPeriod(entry.ts, period)) continue;
    entriesInPeriod += 1;

    switch (entry.type as AuditEventType) {
      case "mandate.granted":
        monitoring.mandatesGranted += 1;
        break;
      case "mandate.revoked":
        monitoring.mandatesRevoked += 1;
        break;
      case "payment.settled": {
        const p = asPayload<SettledPayload>(entry);
        addToBucket(monitoring.settled, p.amount, p.currency);
        break;
      }
      case "gate.decision": {
        const p = asPayload<GateDecisionPayload>(entry);
        if (p.outcome === "block") {
          addToBucket(humanOversight.blocked, p.intent?.amount, p.intent?.currency);
          for (const reason of p.reasons ?? []) {
            if (reason.startsWith(DENY_PREFIX)) {
              humanOversight.denyListHits += 1;
              denyReasons.add(reason.slice(DENY_PREFIX.length).trim());
            }
          }
        } else if (p.outcome === "auto_execute") {
          const bucket =
            p.phase === "operator_approval"
              ? humanOversight.operatorConfirmed
              : humanOversight.autoExecuted;
          addToBucket(bucket, p.intent?.amount, p.intent?.currency);
        }
        // confirm_operator is the parking event, not a terminal spend — skipped.
        break;
      }
      default:
        break;
    }
  }

  humanOversight.denyListReasons = [...denyReasons].sort();

  monitoring.mandatesActiveAtEnd = mandates.filter(
    (m) =>
      m.status === "active" &&
      m.grantedAt < period.end &&
      m.expiresAt > period.end,
  ).length;

  return {
    standard: "EU AI Act Article 26 (deployer obligations)",
    period,
    humanOversight,
    monitoring,
    recordKeeping: {
      totalEntries: audit.length,
      entriesInPeriod,
      integrity,
    },
  };
}
