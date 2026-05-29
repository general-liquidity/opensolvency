// Multi-currency / FX. A mandate is denominated in one currency; a payment in a
// different currency is converted to the mandate's currency so caps + budget are
// always enforced in the mandate's terms. Rates come from an injected source (no
// hardcoded rates). If no rate exists, the gate treats the mandate as not covering
// the payment (→ operator confirmation), never a silent mis-conversion.
//
// Assumes both currencies share a minor-unit scale (e.g. 2 decimals: GBP pence ↔
// USD cents). Cross-decimal currencies (e.g. JPY, 0 decimals) need a scale factor
// — a known limitation, flagged rather than faked.

export interface FxRateSource {
  /** Units of `to` per unit of `from`; undefined if unknown. */
  rate(from: string, to: string): number | undefined;
}

export function fixedRateSource(rates: Record<string, number>): FxRateSource {
  return {
    rate: (from, to) => (from === to ? 1 : rates[`${from}/${to}`]),
  };
}

export function convertMinor(amountMinor: number, rate: number): number {
  return Math.round(amountMinor * rate);
}
