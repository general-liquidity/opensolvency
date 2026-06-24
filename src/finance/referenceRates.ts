// Frozen reference UK market constants for the optimization watcher, so the agent's
// "free money" suggestions work out of the box without a live rates feed. These are
// MARKET-level defaults (inflation, best instant-access savings rate, ISA/LISA
// allowances + the LISA government bonus). Per-operator data — their own cash
// accounts, how much ISA/LISA they've actually used, externally-flagged risk
// patterns — is merged on top via referenceMarketRates(overrides).
//
// This is a SNAPSHOT, not a live source: refresh it periodically. The interview
// cohort is UK university students, hence the UK allowances/bonus.

import type { MarketRates } from "./optimizations.ts";

export const REFERENCE_MARKET_RATES: MarketRates = {
  inflationRate: 0.03, // UK CPI, snapshot — cash earning less than this loses value
  bestSavingsRate: 0.045, // best widely-available instant-access rate, snapshot
  cashAccounts: [], // per-operator — merge in via referenceMarketRates(overrides)
  switchOffers: [], // per-operator availability — merge in
  isaAllowanceMinor: 2_000_000, // £20,000 annual ISA allowance
  isaUsedMinor: 0, // per-operator — merge in
  lisaAllowanceMinor: 400_000, // £4,000 annual LISA allowance
  lisaUsedMinor: 0, // per-operator — merge in
  lisaBonusRate: 0.25, // 25% government top-up on LISA contributions
  riskFlags: [], // per-operator — merge in
};

/** The reference market constants with the operator's own data merged on top. */
export function referenceMarketRates(overrides: Partial<MarketRates> = {}): MarketRates {
  return { ...REFERENCE_MARKET_RATES, ...overrides };
}
