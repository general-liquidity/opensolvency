// Maintenance-loan reality — the truth the field research kept surfacing:
// the UK student maintenance loan often DOESN'T cover rent, and that gap is the
// core pain. In London rent frequently exceeds the loan outright; the loan also
// tapers sharply past a ~£30k household income, so students without well-off
// parents are forced to work to fill the difference — "uni as a playground for
// the rich." This module makes that gap concrete and says what it means: how much
// per month the student must actually earn or source, and a plan to fill it.
//
// Pure / deterministic, typed, no `any`, integer minor-units throughout — matching
// profile.ts / forecast.ts / goals.ts. No ambient rates or clock: every figure is
// either an injected input or a documented snapshot constant (below). The estimate
// is a COARSE guide, not an entitlement calculation — Student Finance England is
// the only authority on the actual award.

import type { CurrencyCode } from "../core/types.ts";

// ---------------------------------------------------------------------------
// UK SNAPSHOT CONSTANTS — refresh each academic year from gov.uk / SFE.
// Source figures are 2024/25-era maintenance-loan rates (full-year, new
// full-time students). These are STRUCTURAL anchors for the coarse estimate,
// not a tunable strategy knob; update them when the published rates change.
// ---------------------------------------------------------------------------

/** Living-cost location bands that drive both the loan and (informally) the rent. */
export type StudentLocation = "outside-london" | "london" | "at-home";

/** Maximum annual maintenance loan by location (minor-units, GBP pence).
 *  2024/25 full-year maxima:
 *   - living away from home, outside London: ≈ £10,227
 *   - living away from home, in London:      ≈ £13,348
 *   - living at the parental home:           ≈ £8,610
 *  (gov.uk "Student finance — what you'll get", 2024/25.) */
const MAX_LOAN_MINOR: Record<StudentLocation, number> = {
  "outside-london": 10_227_00,
  london: 13_348_00,
  "at-home": 8_610_00,
};

/** Below this household income the maximum loan applies (no means taper).
 *  SFE applies the full maximum up to ≈ £25,000 household income. */
const TAPER_START_INCOME_MINOR = 25_000_00;

/** Above this household income the loan reaches its means-tested FLOOR (the
 *  reduced minimum everyone gets regardless of income). The award reduces
 *  roughly linearly between the start and this point — "tapers sharply past
 *  ~£30,000" is exactly this band biting. We snapshot the upper hinge at the
 *  income where outside-London awards reach the minimum (≈ £62,000). */
const TAPER_END_INCOME_MINOR = 62_000_00;

/** Fraction of the maximum that remains at/above the taper end — the floor.
 *  The means-tested minimum is ≈ 38% of the outside-London maximum (≈ £3,907
 *  on a £10,227 max). Applied uniformly as a coarse band. */
const LOAN_FLOOR_FRACTION = 0.38;

/** Default UK student tenancy length used to annualise a monthly/weekly rent —
 *  most student lets run a full 51–52-week contract, so a year is the honest
 *  basis for "does the loan cover the rent?". */
const DEFAULT_WEEKS_PER_YEAR = 52;

// ---------------------------------------------------------------------------
// 1. The loan-vs-rent reality + the per-month gap.
// ---------------------------------------------------------------------------

export interface MaintenanceShortfallInput {
  /** The maintenance loan the student actually receives for the year (minor-units). */
  annualLoanMinor: number;
  /** Total rent for the year (minor-units). If you only know the weekly/monthly
   *  figure, annualise it yourself, or pass `weeksPerYear` + a weekly figure via
   *  `annualRentMinor = weeklyRent * weeksPerYear`. */
  annualRentMinor: number;
  /** Any OTHER support that also covers living costs — parental contribution,
   *  grants, bursaries, term-time wages already committed (minor-units). */
  otherSupportMinor?: number;
  /** Tenancy length used only to derive the per-week view; defaults to a full year. */
  weeksPerYear?: number;
}

export interface MaintenanceShortfall {
  /** Loan + other support, the total pot against rent (minor-units). */
  annualSupportMinor: number;
  /** Rent − support: the yearly gap the student must earn/source. Never negative
   *  for the "gap" framing — when support exceeds rent this is 0 and `surplus...`
   *  carries the headroom instead. */
  annualGapMinor: number;
  /** The gap spread over 12 months — what they must earn/source each month. */
  monthlyGapMinor: number;
  /** The gap spread over the tenancy weeks — the "per week of term" view. */
  weeklyGapMinor: number;
  /** Annual support left AFTER rent when support covers it (0 when there's a gap). */
  surplusAfterRentMinor: number;
  /** Does the loan + support cover the rent at all? The core truth. */
  coversRent: boolean;
  /** Fraction of rent the support covers (0–1+); 1.0 = exactly covered. */
  rentCoverageRatio: number;
}

/**
 * Surface the loan-vs-rent reality concretely. Returns the annual gap, the
 * per-month figure the student must earn or source, and whether the loan even
 * covers the rent. This is the number the students we studied asked someone to just
 * tell them — they will not compute it themselves.
 */
export function maintenanceShortfall(
  input: MaintenanceShortfallInput,
): MaintenanceShortfall {
  const weeks = input.weeksPerYear ?? DEFAULT_WEEKS_PER_YEAR;
  const other = input.otherSupportMinor ?? 0;

  const annualSupport = input.annualLoanMinor + other;
  const rawGap = input.annualRentMinor - annualSupport;

  const annualGap = Math.max(0, rawGap);
  const surplusAfterRent = Math.max(0, -rawGap);
  const coversRent = annualSupport >= input.annualRentMinor;

  // Per-month / per-week are integer minor-units; ceil so we never understate
  // what the student has to find (rounding the gap DOWN would flatter it).
  const monthlyGap = Math.ceil(annualGap / 12);
  const weeklyGap = weeks > 0 ? Math.ceil(annualGap / weeks) : 0;

  const rentCoverageRatio =
    input.annualRentMinor > 0 ? annualSupport / input.annualRentMinor : 1;

  return {
    annualSupportMinor: annualSupport,
    annualGapMinor: annualGap,
    monthlyGapMinor: monthlyGap,
    weeklyGapMinor: weeklyGap,
    surplusAfterRentMinor: surplusAfterRent,
    coversRent,
    rentCoverageRatio,
  };
}

// ---------------------------------------------------------------------------
// 2. A coarse, documented loan estimate from household income + location.
// ---------------------------------------------------------------------------

export interface MaintenanceLoanEstimateInput {
  /** Combined household income SFE means-tests against (minor-units). */
  householdIncomeMinor: number;
  /** Living-cost band; drives the maximum and the floor. */
  location: StudentLocation;
}

/**
 * Estimate the annual maintenance loan from household income + location.
 *
 * THIS IS AN ESTIMATE, NOT AN ENTITLEMENT CALCULATION. Student Finance England
 * is the only authority on the actual award — this is a coarse guide so the
 * agent can frame the likely gap before the real figure is known. It captures
 * the two things the research cared about: the location difference (London >
 * outside-London > at-home) and the sharp means taper past ~£25–30k household
 * income down to a floor everyone receives.
 *
 * Model: full maximum up to the taper-start income; then a linear reduction to
 * the floor fraction of the maximum at the taper-end income; flat at the floor
 * above that. Deterministic, rounded to whole pence, clamped to [floor, max].
 */
export function estimateMaintenanceLoanMinor(
  input: MaintenanceLoanEstimateInput,
): number {
  const max = MAX_LOAN_MINOR[input.location];
  const floor = Math.round(max * LOAN_FLOOR_FRACTION);
  const income = Math.max(0, input.householdIncomeMinor);

  if (income <= TAPER_START_INCOME_MINOR) return max;
  if (income >= TAPER_END_INCOME_MINOR) return floor;

  // Linear interpolation across the taper band: full max at the start income,
  // the floor at the end income.
  const span = TAPER_END_INCOME_MINOR - TAPER_START_INCOME_MINOR;
  const progressed = income - TAPER_START_INCOME_MINOR;
  const reduction = ((max - floor) * progressed) / span;

  return Math.round(max - reduction);
}

// ---------------------------------------------------------------------------
// 3. Action-first summary — frames the gap, sells nothing.
// ---------------------------------------------------------------------------

export interface MaintenanceSummaryInput extends MaintenanceShortfallInput {
  currency?: CurrencyCode; // display only; defaults to GBP
}

export interface MaintenanceSummary {
  shortfall: MaintenanceShortfall;
  /** The one-line headline: "your loan covers £X of £Y rent — a £Z/month gap." */
  headline: string;
  /** Concrete next steps to fill (or use) the gap — action-first, no products sold. */
  plan: string[];
}

/**
 * Frame the loan-vs-rent gap as a plain-language headline plus a concrete plan
 * the student can act on. Mirrors the action-first, sells-nothing tone of
 * forecast.ts: state the gap FOR them, then the move — never a lecture, never a
 * product pitch.
 */
export function maintenanceSummary(
  input: MaintenanceSummaryInput,
): MaintenanceSummary {
  const shortfall = maintenanceShortfall(input);
  const sym = currencySymbol(input.currency);
  const support = money(shortfall.annualSupportMinor, sym);
  const rent = money(input.annualRentMinor, sym);

  if (shortfall.coversRent) {
    const surplus = money(shortfall.surplusAfterRentMinor, sym);
    return {
      shortfall,
      headline:
        shortfall.surplusAfterRentMinor > 0
          ? `Your support of ${support} covers your ${rent} rent with ${surplus} left for the year.`
          : `Your support of ${support} exactly covers your ${rent} rent — nothing spare for living costs.`,
      plan: [
        "Rent is covered — but living costs (food, travel, course materials) still aren't in this figure. Budget those next.",
        "If the margin is thin, line up a small term-time income buffer before you need it, not after.",
        "Check for a university hardship fund or bursary you can claim — it's support you don't repay.",
      ],
    };
  }

  const monthlyGap = money(shortfall.monthlyGapMinor, sym);
  const annualGap = money(shortfall.annualGapMinor, sym);
  return {
    shortfall,
    headline: `Your loan covers ${support} of ${rent} rent — a ${monthlyGap}/month gap you have to fill yourself.`,
    plan: [
      `You need to find ${monthlyGap}/month (${annualGap}/year) just to cover rent — before food, travel or anything else.`,
      "Claim first, earn second: check your university hardship fund and any bursary — that's support you never repay.",
      `Size term-time work to the gap, not the maximum — roughly ${monthlyGap}/month covers rent; more than that frees up living costs.`,
      "If rent alone outruns realistic term-time earnings, treat cheaper housing as a live option — the rent line is the biggest lever here.",
    ],
  };
}

// ---------------------------------------------------------------------------
// Display helpers (presentation only — never feed back into the money math).
// ---------------------------------------------------------------------------

function currencySymbol(code: CurrencyCode | undefined): string {
  switch (code) {
    case undefined:
    case "GBP":
      return "£";
    case "USD":
      return "$";
    case "EUR":
      return "€";
    default:
      return `${code} `;
  }
}

function money(minor: number, sym: string): string {
  const major = minor / 100;
  const body = Number.isInteger(major)
    ? major.toLocaleString("en-GB")
    : major.toLocaleString("en-GB", {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
      });
  return `${sym}${body}`;
}
