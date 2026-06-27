// Free-money / optimization watcher — the killer first feature.
//
// The field research (in-depth student interviews) found a recurring,
// expensive pattern: students KNOW free money exists but never claim it. Cash
// sits at 0%/low interest eaten by inflation (#3, #8); they don't switch banks
// for ~£200/yr bonuses or better savings rates even though "2 hours for £200 is
// worth it" — the minimum-wage mindset (#11, #7); ISA/LISA allowance goes unused;
// and scam (#16, scammed twice) / FOMO crypto losses (#16, −£2k) quietly bleed
// capital. The agent should DO the boring optimization the human won't — propose
// the concrete switch, not explain that switching exists.
//
// This module is pure + deterministic: it takes a FinancialProfile plus an
// INJECTED market source (a seam, NOT a live API — same shape as the FX rate
// source in core/fx.ts) and emits action-first optimizations, sorted by £/year
// desc, that map onto watch.ts's Concern shape so they flow through the harness.

import type { FinancialProfile } from "./profile.ts";
import type { Concern, ConcernKind, Severity } from "./watch.ts";

// ── The injected market seam (no live API) ───────────────────────────────────
// The caller closes over already-fetched data — current best rates, the user's
// idle-cash accounts, available switch-bonus offers, and any flagged scam/FOMO
// patterns. Like FxRateSource: a deterministic source, injected, never read live.

/** One pot of the operator's cash and the rate it currently earns. */
export interface CashAccount {
  /** stable account id (also the bank/provider the switch would move FROM) */
  id: string;
  /** the account's provider/bank, for the switch-from copy */
  provider: string;
  balanceMinor: number;
  /** annual interest rate as a fraction (0.0 = 0%, 0.045 = 4.5%) */
  annualRate: number;
}

/** A bank-switch incentive currently on the table (e.g. "£200 to switch"). */
export interface SwitchOffer {
  provider: string;
  bonusMinor: number;
  /** plain-words requirement, surfaced in the action ("2 direct debits + £1k in") */
  requirement: string;
}

/** Patterns an external monitor has already flagged — passed in, not inferred
 * from raw transactions here. Flag-only + non-punitive by design. */
export interface RiskFlag {
  kind: "scam_pattern" | "fomo_chasing";
  /** plain-words description of what was seen, used verbatim in the reason */
  detail: string;
  /** money already at risk / lost, if known (minor-units); drives ordering */
  exposureMinor?: number;
}

export interface MarketRates {
  /** annual inflation rate as a fraction (0.04 = 4%) — cash below this loses value */
  inflationRate: number;
  /** best generally-available instant-access savings rate (fraction) */
  bestSavingsRate: number;
  /** the operator's idle-cash accounts (balances + the rate each earns) */
  cashAccounts: CashAccount[];
  /** switch bonuses currently available */
  switchOffers: SwitchOffer[];
  /** annual ISA contribution allowance, minor-units (e.g. £20,000 = 2_000_000) */
  isaAllowanceMinor: number;
  /** ISA allowance already used this year, minor-units */
  isaUsedMinor: number;
  /** annual LISA allowance, minor-units (e.g. £4,000 = 400_000) */
  lisaAllowanceMinor: number;
  /** LISA used this year, minor-units */
  lisaUsedMinor: number;
  /** the LISA government top-up rate (0.25 = 25% bonus on contributions) */
  lisaBonusRate: number;
  /** patterns an external monitor has already flagged (scam / FOMO) */
  riskFlags: RiskFlag[];
}

/** What the operator can plausibly funnel into a LISA from spare savings. */
function fundableLisaMinor(
  profile: FinancialProfile,
  remainingAllowanceMinor: number,
): number {
  // Don't propose locking away the emergency buffer: only count savings above a
  // one-month essential cushion as fundable. LISA is long-horizon money.
  const cushion = profile.monthlyEssentialSpendMinor;
  const spare = Math.max(0, profile.liquidSavingsMinor - cushion);
  return Math.min(remainingAllowanceMinor, spare);
}

// ── The optimization output ──────────────────────────────────────────────────

export type OptimizationKind =
  | "idle_cash_inflation"
  | "missed_savings_rate"
  | "missed_switch_bonus"
  | "unused_isa_allowance"
  | "unused_lisa_allowance"
  | "scam_pattern"
  | "fomo_chasing";

/** An action-first "free money" find. Each one names the win in plain words, the
 * £/year value, the concrete next action, and a severity. */
export interface Optimization {
  id: OptimizationKind;
  /** the win in plain words */
  win: string;
  /** annual value of acting, minor-units (0 for flag-only guardrails) */
  valuePerYearMinor: number;
  /** the concrete next action the agent would DO/propose — not an explanation */
  action: string;
  severity: Severity;
}

const ROUND = Math.round;

/** Find every free-money / optimization win for this profile + market, sorted by
 * £/year value desc. Pure + deterministic. */
export function findOptimizations(
  profile: FinancialProfile,
  market: MarketRates,
): Optimization[] {
  const out: Optimization[] = [];

  // 1. Idle cash losing to inflation: any account below the inflation rate is
  //    shrinking in real terms (#3, #8). The "loss" is the real-terms erosion vs
  //    holding pace with inflation.
  for (const acct of market.cashAccounts) {
    if (acct.balanceMinor > 0 && acct.annualRate < market.inflationRate) {
      const realLossPerYear = ROUND(
        acct.balanceMinor * (market.inflationRate - acct.annualRate),
      );
      out.push({
        id: "idle_cash_inflation",
        win: `£${minor(acct.balanceMinor)} in ${acct.provider} earns ${pct(acct.annualRate)} while inflation is ${pct(market.inflationRate)} — it's shrinking in real terms`,
        valuePerYearMinor: realLossPerYear,
        action: `move idle cash out of ${acct.provider} into an instant-access account paying at least inflation`,
        severity: severityFromValue(realLossPerYear, profile),
      });
    }
  }

  // 2. Better savings rate available elsewhere: the gain from moving each pot to
  //    the best generally-available rate (the switch students never make, #7).
  for (const acct of market.cashAccounts) {
    if (acct.balanceMinor > 0 && acct.annualRate < market.bestSavingsRate) {
      const gainPerYear = ROUND(
        acct.balanceMinor * (market.bestSavingsRate - acct.annualRate),
      );
      // Don't double-count the inflation-loss find: only surface a switch when
      // the *better-rate* gain is meaningfully positive on its own.
      if (gainPerYear <= 0) continue;
      out.push({
        id: "missed_savings_rate",
        win: `${acct.provider} pays ${pct(acct.annualRate)}; the best easy-access rate is ${pct(market.bestSavingsRate)} on the same £${minor(acct.balanceMinor)}`,
        valuePerYearMinor: gainPerYear,
        action: `open the higher-rate easy-access account and move the £${minor(acct.balanceMinor)} from ${acct.provider}`,
        severity: severityFromValue(gainPerYear, profile),
      });
    }
  }

  // 3. Bank-switch bonus on the table: ~£200/yr for ~2 hours' work — the
  //    minimum-wage-mindset win (#11). A one-off bonus, surfaced as its £ value.
  for (const offer of market.switchOffers) {
    if (offer.bonusMinor > 0) {
      out.push({
        id: "missed_switch_bonus",
        win: `${offer.provider} is paying £${minor(offer.bonusMinor)} to switch — free money for a couple of hours' admin`,
        valuePerYearMinor: offer.bonusMinor,
        action: `start a current-account switch to ${offer.provider} (${offer.requirement})`,
        severity: severityFromValue(offer.bonusMinor, profile),
      });
    }
  }

  // 4. Unused ISA allowance: tax-free headroom that resets each year — use it or
  //    lose it. Value = tax-advantaged growth on the savings that could go in,
  //    capped to the spare savings the operator actually has.
  const isaRemaining = Math.max(
    0,
    market.isaAllowanceMinor - market.isaUsedMinor,
  );
  if (isaRemaining > 0 && profile.liquidSavingsMinor > 0) {
    const movable = Math.min(isaRemaining, profile.liquidSavingsMinor);
    // The win is the rate earned tax-free instead of in a taxable account; we use
    // the best savings rate as the proxy for the foregone tax-free return.
    const valuePerYear = ROUND(movable * market.bestSavingsRate);
    out.push({
      id: "unused_isa_allowance",
      win: `£${minor(isaRemaining)} of this year's ISA allowance is unused — tax-free room that resets and won't carry over`,
      valuePerYearMinor: valuePerYear,
      action: `open/transfer £${minor(movable)} of savings into an ISA before the allowance resets`,
      severity: severityFromValue(valuePerYear, profile),
    });
  }

  // 5. Unused LISA allowance: a 25% government top-up is the single biggest
  //    free-money line for a student saving for a first home. Value = the bonus
  //    on what they can plausibly fund (not the buffer).
  const lisaRemaining = Math.max(
    0,
    market.lisaAllowanceMinor - market.lisaUsedMinor,
  );
  if (lisaRemaining > 0) {
    const fundable = fundableLisaMinor(profile, lisaRemaining);
    if (fundable > 0) {
      const bonus = ROUND(fundable * market.lisaBonusRate);
      out.push({
        id: "unused_lisa_allowance",
        win: `the LISA pays a ${pct(market.lisaBonusRate)} government bonus — £${minor(fundable)} contributed earns £${minor(bonus)} free`,
        valuePerYearMinor: bonus,
        action: `pay £${minor(fundable)} of spare savings into a LISA to claim the ${pct(market.lisaBonusRate)} top-up`,
        severity: severityFromValue(bonus, profile),
      });
    }
  }

  // 6 + 7. Guardrails — flag-only, non-punitive (#16: scammed twice; −£2k FOMO).
  //        These are losses, not gains: surfaced so the agent intervenes, never
  //        to reprimand. valuePerYear carries the known exposure so they sort
  //        sensibly among the wins.
  for (const flag of market.riskFlags) {
    if (flag.kind === "scam_pattern") {
      out.push({
        id: "scam_pattern",
        win: `possible scam exposure spotted: ${flag.detail}`,
        valuePerYearMinor: flag.exposureMinor ?? 0,
        action:
          "pause and verify before any payment to this destination; offer to check it together",
        severity: "high",
      });
    } else {
      out.push({
        id: "fomo_chasing",
        win: `looks like chasing a hyped move: ${flag.detail}`,
        valuePerYearMinor: flag.exposureMinor ?? 0,
        action:
          "offer a cooling-off check and a position-size sanity test before committing",
        severity: flag.exposureMinor && flag.exposureMinor > 0 ? "high" : "medium",
      });
    }
  }

  return out.sort((a, b) => b.valuePerYearMinor - a.valuePerYearMinor);
}

// ── Mapping onto the watch.ts Concern stream ─────────────────────────────────
// The harness already consumes Concerns; optimizations ARE concerns (facts + a
// non-punitive suggested action). We reuse watch.ts's shape so they flow through
// the same surface rather than inventing a parallel one. The optimization kinds
// don't all have a 1:1 ConcernKind, so the money wins fold into a single
// "missed_free_money" concept and the guardrails reuse the closest existing kind.

/** Map an OptimizationKind to the nearest existing watch.ts ConcernKind for
 * routing — without minting a new ConcernKind (which would mean editing
 * watch.ts). The action-first framing is preserved in the Concern's suggestion. */
const CONCERN_KIND_OF: Record<OptimizationKind, ConcernKind> = {
  // Money left on the table is a buffer/efficiency concern — the closest existing
  // routing kind without minting a new ConcernKind (which would edit watch.ts).
  idle_cash_inflation: "buffer_erosion",
  missed_savings_rate: "buffer_erosion",
  missed_switch_bonus: "buffer_erosion",
  unused_isa_allowance: "buffer_erosion",
  unused_lisa_allowance: "buffer_erosion",
  // Scam exposure routes like the most urgent money-protection concern we have.
  scam_pattern: "high_cost_credit_reliance",
  fomo_chasing: "high_cost_credit_reliance",
};

/** Convert optimizations into watch.ts Concerns so they flow through the harness'
 * existing concern surface. Pure mapping; preserves the action-first framing in
 * `suggestion` and folds the £/year value into the human-readable `reason`. */
export function toConcerns(opts: Optimization[]): Concern[] {
  return opts.map((o) => ({
    kind: CONCERN_KIND_OF[o.id],
    severity: o.severity,
    reason:
      o.valuePerYearMinor > 0
        ? `${o.win} (~£${minor(o.valuePerYearMinor)}/yr)`
        : o.win,
    suggestion: o.action,
  }));
}

// ── helpers ──────────────────────────────────────────────────────────────────

/** Minor-units → a plain pounds string (2-decimal assumption, as elsewhere). */
function minor(amountMinor: number): string {
  const pounds = amountMinor / 100;
  return Number.isInteger(pounds) ? String(pounds) : pounds.toFixed(2);
}

/** Fraction → a percent string, trimming a trailing ".0". */
function pct(rate: number): string {
  const p = rate * 100;
  return `${Number.isInteger(p) ? String(p) : p.toFixed(1)}%`;
}

/** Severity scaled to the operator's situation: a £200 win is "high" for a
 * student on a thin income, "low" for an established earner. We anchor to monthly
 * income so the same £ value isn't equally urgent for everyone. */
function severityFromValue(
  valuePerYearMinor: number,
  profile: FinancialProfile,
): Severity {
  const monthlyIncome = profile.monthlyIncomeMinor;
  if (monthlyIncome <= 0) {
    // No income anchor: fall back to absolute bands (£300 / £75).
    if (valuePerYearMinor >= 30_000) return "high";
    if (valuePerYearMinor >= 7_500) return "medium";
    return "low";
  }
  // A year's win worth ≥ a month's income is high; ≥ a quarter-month is medium.
  if (valuePerYearMinor >= monthlyIncome) return "high";
  if (valuePerYearMinor >= monthlyIncome * 0.25) return "medium";
  return "low";
}
