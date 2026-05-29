// Reconciliation — match what the agent settled against the operator's real
// account statement. Three outcomes: matched (settled ↔ statement line), unmatched
// payments (we recorded a settlement with no statement line yet — clearing lag or
// a rail problem), and unmatched statement lines (spend on the account with NO
// corresponding payment — i.e. activity the governance plane did not authorize,
// the flag that matters most). Pure + deterministic.

export interface StatementLine {
  amountMinor: number;
  currency: string;
  descriptor: string;
  at: string; // ISO
}

export interface SettledPayment {
  intentId: string;
  payee: string;
  amountMinor: number;
  currency: string;
  at: string; // ISO
}

export interface ReconResult {
  matched: { payment: SettledPayment; line: StatementLine }[];
  /** Settled by us, no statement line yet (clearing lag or rail issue). */
  unmatchedPayments: SettledPayment[];
  /** Statement spend with no authorizing payment — external / UNAUTHORIZED. */
  unmatchedStatement: StatementLine[];
}

const DEFAULT_WINDOW_MS = 3 * 24 * 60 * 60 * 1000; // 3 days clearing window

export function reconcile(
  payments: SettledPayment[],
  lines: StatementLine[],
  opts: { windowMs?: number } = {},
): ReconResult {
  const window = opts.windowMs ?? DEFAULT_WINDOW_MS;
  const remainingLines = [...lines];
  const matched: ReconResult["matched"] = [];
  const unmatchedPayments: SettledPayment[] = [];

  for (const p of payments) {
    const pt = new Date(p.at).getTime();
    const idx = remainingLines.findIndex(
      (l) =>
        l.currency === p.currency &&
        l.amountMinor === p.amountMinor &&
        Math.abs(new Date(l.at).getTime() - pt) <= window,
    );
    if (idx >= 0) {
      matched.push({ payment: p, line: remainingLines[idx] });
      remainingLines.splice(idx, 1);
    } else {
      unmatchedPayments.push(p);
    }
  }

  return { matched, unmatchedPayments, unmatchedStatement: remainingLines };
}
