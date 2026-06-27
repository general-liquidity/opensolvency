// Retirement decision-sensitivity simulator — the long-horizon lever the field
// field research flagged as the single most-AVOIDED topic across the whole corpus.
// Retirement triggers present bias / temporal discounting (hyperbolic discounting
// of the far-future self), and the research found this is exaggerated in young
// people: the payoff is decades out, so it feels intangible and gets deferred
// indefinitely. A neuroscientist we consulted validated
// that a SIMULATOR — showing how a present decision changes the future-retirement
// outcome — makes the intangible tangible and is genuinely impactful against the
// bias. So this module's job is NOT to nag about retirement; it's to make the
// present→future lever concrete: "£X/mo more from now → £Y more at retirement",
// and "waiting N years costs you £W" (compounding lost to delay — the strongest
// present-bias counter, because the cost of waiting is itself the thing being
// discounted away).
//
// This is DISTINCT from slipCost.ts (the long-term cost of a discretionary HABIT)
// and forecast.ts (timeline to a single deposit GOAL): it's a decision-sensitivity
// projector over a multi-decade horizon, where the headline is the DERIVATIVE of
// the outcome with respect to a present choice, not the outcome itself.
//
// Pure / deterministic, typed, integer minor-units. The growth rate is ALWAYS
// injected — the kernel never reads an ambient rate, market feed, or clock, so
// every projection is replayable. Consistent with forecast.ts / goals.ts /
// slipCost.ts, and the contribution compounding REUSES slipCost.ts's ordinary-
// annuity convention (grind period by period at the per-period rate, contribution
// at period end) so the two modules agree to the penny on the same inputs.

const MONTHS_PER_YEAR = 12;

export interface RetirementBase {
  /** What's already saved towards retirement today (the starting pot). Minor units. */
  currentPotMinor: number;
  /** Monthly contribution from now on. Minor units. */
  monthlyContributionMinor: number;
  /** Whole years from now until retirement (the horizon). */
  yearsToRetirement: number;
  /** Expected annual growth rate (e.g. 0.05 = 5%). INJECTED — never read from an
   * environment. 0 → no growth, so the pot is just the raw contributions + start. */
  annualGrowthRate: number;
}

export interface RetirementProjection {
  /** The pot at retirement: starting pot compounded + contributions compounded. Minor units. */
  projectedPotMinor: number;
  /** Raw money paid in over the horizon (contributions only, no growth, no start pot). Minor units. */
  totalContributedMinor: number;
  /** projectedPot − startingPot − totalContributed: the compounding gain. 0 at a
   * zero rate. Minor units. */
  growthMinor: number;
}

/**
 * Project the retirement pot at the horizon.
 *
 * Compounding assumption (documented, deterministic): the existing pot compounds
 * once per MONTH at the per-period rate `annualGrowthRate / 12`, and each monthly
 * contribution is added at period end and compounds from then on — a standard
 * future-value-of-an-annuity (ordinary annuity), the SAME convention slipCost.ts
 * uses. Grinding month by month (rather than a closed form) is bounded, exact, and
 * avoids log / pow edge-cases on tiny rates; a 0 rate collapses to start + raw
 * contributions, so `growthMinor` is exactly 0.
 */
export function projectRetirement(base: RetirementBase): RetirementProjection {
  const months = Math.max(0, Math.round(base.yearsToRetirement * MONTHS_PER_YEAR));
  const rate = base.annualGrowthRate;
  const contribution = base.monthlyContributionMinor;

  const totalContributedMinor = contribution * months;

  let projectedPotMinor: number;
  if (rate <= 0) {
    // No growth → start pot plus the raw contributions, nothing compounds.
    projectedPotMinor = base.currentPotMinor + totalContributedMinor;
  } else {
    const perMonthRate = rate / MONTHS_PER_YEAR;
    // Grind month by month: the existing pot AND every prior contribution earn the
    // period rate, then this month's contribution lands at period end.
    let pot = base.currentPotMinor;
    for (let i = 0; i < months; i += 1) {
      pot = pot * (1 + perMonthRate) + contribution;
    }
    projectedPotMinor = Math.round(pot);
  }

  const growthMinor = Math.max(
    0,
    projectedPotMinor - base.currentPotMinor - totalContributedMinor,
  );

  return { projectedPotMinor, totalContributedMinor, growthMinor };
}

export interface SensitivityInput extends RetirementBase {
  /** Change in the MONTHLY contribution to test (e.g. +2500 = £25/mo more). Minor units. */
  deltaMonthlyMinor: number;
}

export interface SensitivityResult {
  /** Extra pot at retirement from the contribution change: the present→future
   * lever made concrete. Can be negative if deltaMonthly is negative. Minor units. */
  deltaPotMinor: number;
  /** The projected pot WITH the change applied. Minor units. */
  projectedPotMinor: number;
}

/**
 * The simulator's core: how much MORE (or less) ends up in the pot at retirement
 * if the monthly contribution changes by `deltaMonthlyMinor`, starting now. This
 * is the lever the neuroscientist validated — "£25/mo more from now → £Z more at
 * retirement" — turning an abstract future into a concrete, present-controllable
 * number. Monotonic by construction: a larger positive delta yields a larger
 * positive `deltaPotMinor` (more in → more out, amplified by compounding).
 */
export function sensitivity(input: SensitivityInput): SensitivityResult {
  const baseline = projectRetirement(input);
  const changed = projectRetirement({
    ...input,
    monthlyContributionMinor: input.monthlyContributionMinor + input.deltaMonthlyMinor,
  });
  return {
    deltaPotMinor: changed.projectedPotMinor - baseline.projectedPotMinor,
    projectedPotMinor: changed.projectedPotMinor,
  };
}

export interface StartNowVsLaterInput extends RetirementBase {
  /** How many years the operator would DELAY starting (or growing) contributions. */
  delayYears: number;
}

export interface StartNowVsLaterResult {
  /** Pot at retirement if contributions start NOW. Minor units. */
  startNowPotMinor: number;
  /** Pot at retirement if contributions start after `delayYears`. Minor units. */
  startLaterPotMinor: number;
  /** startNow − startLater: the compounding lost to waiting — the strongest
   * present-bias counter. >= 0 at a positive rate (or positive contribution). Minor units. */
  costOfWaitingMinor: number;
}

/**
 * The cost of waiting. Starting NOW means contributions run for the full horizon;
 * delaying by `delayYears` means the same monthly contribution only runs for the
 * REMAINING years — and crucially, the contributions that WOULD have gone in early
 * lose the most compounding (early money compounds longest). During the delay the
 * existing pot still grows (the operator hasn't withdrawn it), they simply aren't
 * adding to it. The difference is the compounding handed away by deferring — the
 * intangible future-cost made tangible, which is exactly what the bias discounts.
 *
 * A delay >= the horizon means no contributions ever land; the later pot is then
 * just the start pot grown for the horizon, and the cost is all the contributions'
 * growth.
 */
export function startNowVsLater(input: StartNowVsLaterInput): StartNowVsLaterResult {
  const startNow = projectRetirement(input);

  const remainingYears = Math.max(0, input.yearsToRetirement - input.delayYears);
  // The pot at the moment contributions begin: the start pot grown over the delay
  // with no contributions added. Then contributions run for the remaining years.
  const potAtStart = projectRetirement({
    currentPotMinor: input.currentPotMinor,
    monthlyContributionMinor: 0,
    yearsToRetirement: Math.min(input.delayYears, input.yearsToRetirement),
    annualGrowthRate: input.annualGrowthRate,
  }).projectedPotMinor;

  const startLater = projectRetirement({
    currentPotMinor: potAtStart,
    monthlyContributionMinor: input.monthlyContributionMinor,
    yearsToRetirement: remainingYears,
    annualGrowthRate: input.annualGrowthRate,
  });

  return {
    startNowPotMinor: startNow.projectedPotMinor,
    startLaterPotMinor: startLater.projectedPotMinor,
    costOfWaitingMinor: Math.max(0, startNow.projectedPotMinor - startLater.projectedPotMinor),
  };
}

export interface RetirementSummaryInput extends RetirementBase {
  /** Optional: also surface the upside of contributing this much MORE per month. Minor units. */
  deltaMonthlyMinor?: number;
  /** Optional: also surface the cost of delaying by this many years. */
  delayYears?: number;
}

/**
 * Action-first, tangible, sells-nothing summary. Leads with the concrete pot the
 * present plan builds, then — when asked — the two levers the research says move
 * the needle against present bias: the upside of a small monthly increase, and the
 * cost of waiting. No doom, no guilt, no product (per ethics.ts / communication.ts):
 * the number IS the intervention.
 *
 *   "On track for £Z by retirement (paying in £A/mo over N years).
 *    £25/mo more from now → £Y more. Waiting 5 years costs you £W."
 */
export function retirementSummary(input: RetirementSummaryInput): string {
  const proj = projectRetirement(input);
  const parts: string[] = [
    `On track for £${pounds(proj.projectedPotMinor)} by retirement ` +
      `(paying in £${pounds(input.monthlyContributionMinor)}/mo over ` +
      `${input.yearsToRetirement} ${input.yearsToRetirement === 1 ? "year" : "years"}).`,
  ];

  if (input.deltaMonthlyMinor !== undefined && input.deltaMonthlyMinor !== 0) {
    const s = sensitivity({ ...input, deltaMonthlyMinor: input.deltaMonthlyMinor });
    const dir = input.deltaMonthlyMinor > 0 ? "more" : "less";
    parts.push(
      `£${pounds(Math.abs(input.deltaMonthlyMinor))}/mo ${dir} from now → ` +
        `£${pounds(Math.abs(s.deltaPotMinor))} ${s.deltaPotMinor >= 0 ? "more" : "less"} at retirement.`,
    );
  }

  if (input.delayYears !== undefined && input.delayYears > 0) {
    const w = startNowVsLater({ ...input, delayYears: input.delayYears });
    parts.push(
      `Waiting ${input.delayYears} ${input.delayYears === 1 ? "year" : "years"} ` +
        `costs you £${pounds(w.costOfWaitingMinor)}.`,
    );
  }

  return parts.join(" ");
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
