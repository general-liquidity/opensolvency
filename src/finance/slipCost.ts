// The "slip-and-slide" — make the long-term cost of a small recurring habit
// VISIBLE, then propose the swap. The highest-conviction finding in the
// corpus: small recurring discretionary spend compounds into a huge lost
// potential. Independently confirmed by a University of Bristol money advisor —
// a daily meal-deal + Costa coffee ≈ HALF a student's annual maintenance loan.
//
// The Ben Chat sessions frame this as showing someone their "future self" / the
// gap to their "elite financial self". The job is to surface the number, not to
// lecture or guilt (per ethics.ts / communication.ts): show the £/yr, show what
// the SAME money would grow to if redirected, and name the swap. Sells nothing.
//
// Pure / deterministic, typed, integer minor-units. The growth rate is ALWAYS
// injected — the kernel never reads an ambient rate, market feed, or clock, so
// every projection is replayable. Consistent with forecast.ts / goals.ts.

export type SlipCadence = "daily" | "weekly" | "monthly";

// How many times a cadence recurs in a year. Structural constants, not knobs:
// a year is treated as 365 days / 52 weeks / 12 months (the same convention the
// rest of the finance harness uses for round annualisation).
const OCCURRENCES_PER_YEAR: Record<SlipCadence, number> = {
  daily: 365,
  weekly: 52,
  monthly: 12,
};

export interface SlipCost {
  /** Annualised cost of the habit (amount × occurrences/year). Minor units. */
  annualMinor: number;
  /** Raw total spent over `years` (annualMinor × years). Minor units. */
  totalSpentMinor: number;
  /** What the SAME money grows to if redirected and invested at the injected
   * rate, contributed at the cadence and compounded each period. Minor units. */
  futureValueIfInvestedMinor: number;
  /** futureValueIfInvested − totalSpent: the growth left on the table by
   * spending instead of investing. 0 when the rate is 0. Minor units. */
  foregoneGrowthMinor: number;
}

export interface SlipCostInput {
  /** Cost of ONE instance of the habit (e.g. one £3.50 coffee → 350). Minor units. */
  amountMinor: number;
  cadence: SlipCadence;
  /** Horizon in years to project over. */
  years: number;
  /** Annual return if the money were redirected and invested (e.g. 0.05 = 5%).
   * INJECTED — never read from an environment. Omitted / 0 → no growth, so the
   * future value equals the raw total. */
  annualGrowthRate?: number;
}

/**
 * Cost a single recurring habit.
 *
 * Compounding assumption (documented, deterministic): the money is contributed
 * at the SAME cadence as the spend (every day / week / month) and compounds once
 * per period at the per-period rate `annualGrowthRate / occurrencesPerYear` — a
 * standard future-value-of-an-annuity (ordinary annuity, contribution at period
 * end). This mirrors `monthsToTarget` in forecast.ts: grind period by period,
 * bounded and exact, avoiding log/closed-form edge-cases on tiny rates. A 0 rate
 * collapses to the raw total, so `foregoneGrowthMinor` is 0.
 */
export function slipCost(input: SlipCostInput): SlipCost {
  const { amountMinor, cadence, years } = input;
  const perYear = OCCURRENCES_PER_YEAR[cadence];

  // Annual + raw-total drain. Round to whole minor-units at the boundary so the
  // number the operator sees is exact pennies, not a float.
  const annualMinor = Math.round(amountMinor * perYear);
  const totalSpentMinor = Math.round(annualMinor * years);

  const rate = input.annualGrowthRate ?? 0;
  const periods = Math.max(0, Math.round(perYear * years));

  let futureValueIfInvestedMinor: number;
  if (rate <= 0) {
    // No growth → the redirected money is just the raw total back.
    futureValueIfInvestedMinor = amountMinor * periods;
  } else {
    const perPeriodRate = rate / perYear;
    // FV of an ordinary annuity, period by period (contribution at period end).
    let pot = 0;
    for (let i = 0; i < periods; i += 1) {
      pot = pot * (1 + perPeriodRate) + amountMinor;
    }
    futureValueIfInvestedMinor = Math.round(pot);
  }

  const foregoneGrowthMinor = Math.max(
    0,
    futureValueIfInvestedMinor - amountMinor * periods,
  );

  return {
    annualMinor,
    totalSpentMinor,
    futureValueIfInvestedMinor,
    foregoneGrowthMinor,
  };
}

export interface NamedSlip {
  /** Human label, e.g. "daily coffee", "weekly takeaway". */
  label: string;
  amountMinor: number;
  cadence: SlipCadence;
  /** Optional per-slip swap suggestion; a generic one is derived if absent. */
  swap?: string;
}

export interface RankSlipsOptions {
  years: number;
  /** Annual return if redirected + invested. INJECTED. */
  annualGrowthRate?: number;
}

export interface RankedSlip {
  label: string;
  amountMinor: number;
  cadence: SlipCadence;
  cost: SlipCost;
  /** Action-first swap — what to do instead, sells nothing, no guilt. */
  swap: string;
  /** The one-line, "future-self" summary for this slip. */
  summary: string;
}

/**
 * Rank several named recurring spends by annual drain (descending), each with
 * its future-value projection + an action-first swap. Lead with the biggest
 * slip — that's where making the cost visible buys the most.
 */
export function rankSlips(
  slips: NamedSlip[],
  opts: RankSlipsOptions,
): RankedSlip[] {
  return slips
    .map((slip) => {
      const cost = slipCost({
        amountMinor: slip.amountMinor,
        cadence: slip.cadence,
        years: opts.years,
        annualGrowthRate: opts.annualGrowthRate,
      });
      const swap = slip.swap ?? defaultSwap(slip);
      return {
        label: slip.label,
        amountMinor: slip.amountMinor,
        cadence: slip.cadence,
        cost,
        swap,
        summary: slipSummary({
          label: slip.label,
          amountMinor: slip.amountMinor,
          cadence: slip.cadence,
          years: opts.years,
          cost,
          swap,
        }),
      };
    })
    .sort((a, b) => b.cost.annualMinor - a.cost.annualMinor);
}

export interface SlipSummaryInput {
  label: string;
  amountMinor: number;
  cadence: SlipCadence;
  years: number;
  cost: SlipCost;
  /** Optional swap to append; omitted → a generic redirect line. */
  swap?: string;
}

/**
 * Action-first "future self" one-liner. Makes the long-term cost of the habit
 * visible, then names the swap — no lecture, no guilt, sells nothing.
 *
 *   "your daily £3.50 coffee is £1,277.50/yr → £16,500 over 10 years if invested
 *    — here's the swap: ..."
 */
export function slipSummary(input: SlipSummaryInput): string {
  const { label, amountMinor, cadence, years, cost } = input;
  const head =
    `your ${cadenceWord(cadence)} £${pounds(amountMinor)} ${label} is ` +
    `£${pounds(cost.annualMinor)}/yr → £${pounds(cost.futureValueIfInvestedMinor)} ` +
    `over ${years} ${years === 1 ? "year" : "years"} if invested`;
  const swap = input.swap ?? `redirect it to a goal and the same money works for you instead`;
  return `${head} — here's the swap: ${swap}`;
}

/** A generic, non-judgemental swap when a slip doesn't carry its own. */
function defaultSwap(slip: NamedSlip): string {
  return `keep the ${cadenceWord(slip.cadence)} treat but halve the spend, or make it at home — redirect the difference`;
}

function cadenceWord(c: SlipCadence): string {
  return c; // "daily" | "weekly" | "monthly" already read naturally
}

function pounds(minor: number): string {
  const major = minor / 100;
  return Number.isInteger(major)
    ? major.toLocaleString("en-GB")
    : major.toLocaleString("en-GB", {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
      });
}
