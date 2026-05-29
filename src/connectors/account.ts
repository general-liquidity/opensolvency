// Non-custodial account connection. The operator connects their OWN bank/exchange
// accounts READ-ONLY, so OpenSolvency can read balances + statements (to ground
// the profile and reconcile against reality) — but the interface has NO method
// that moves money. That's the non-custodial guarantee made structural: the
// connector can observe, never transact. Actual settlement happens on a rail
// through the operator's own wallet/account, never here.

import type { StatementLine, SettledPayment } from "../finance/reconcile.ts";
import type { SpendObservation } from "../finance/watch.ts";
import type { RailKind } from "../core/types.ts";

export interface AccountBalance {
  account: string;
  currency: string;
  availableMinor: number;
}

export interface AccountConnector {
  getBalances(): Promise<AccountBalance[]> | AccountBalance[];
  getStatement(sinceISO: string): Promise<StatementLine[]> | StatementLine[];
  // Intentionally NO transfer/pay method — read-only by design.
}

export function createFakeAccountConnector(data: {
  balances: AccountBalance[];
  statement: StatementLine[];
}): AccountConnector {
  return {
    getBalances: () => data.balances,
    getStatement: (sinceISO) =>
      data.statement.filter((l) => l.at >= sinceISO),
  };
}

/** Statement lines → spend observations, so "watching your back" can run over the
 * operator's real account activity (not just synthetic input). */
export function statementToObservations(
  lines: StatementLine[],
  rail: RailKind = "card",
): SpendObservation[] {
  return lines.map((l) => ({
    amountMinor: l.amountMinor,
    payeeClass: l.descriptor,
    rail,
    at: l.at,
  }));
}

/** Statement lines → settled-payment shape, for reconciliation input. */
export function statementToPayments(lines: StatementLine[]): SettledPayment[] {
  return lines.map((l, i) => ({
    intentId: `stmt_${i}`,
    payee: l.descriptor,
    amountMinor: l.amountMinor,
    currency: l.currency,
    at: l.at,
  }));
}
