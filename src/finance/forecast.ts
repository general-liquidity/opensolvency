// Forecast + coverage — the "make the timeline concrete and flag the gaps FOR me"
// layer the field research asked for in almost the same words:
//   #3 "calculate all my costs, present how much is needed, give suggestions";
//   #5 "flag what I'm missing, forecast long-term, aligned to my life goals";
//   #4 "a helping hand on where to put my money, without selling me anything".
//
// Research truth driving the shape: the near-universal 10-year goal is OWNING A
// HOUSE (security / freedom — "somewhere to come back to"), usually saved into a
// LISA / Help-to-Buy ISA; travel is #2. Students will NOT compute the timeline
// themselves, so the agent does it for them and surfaces the gap as a concrete
// next action — action-first, not a lecture.
//
// Pure / deterministic, typed, no ambient rates or clock. This EXTENDS goals.ts:
// `planGoal` already owns required-monthly + feasibility; here we reuse it and
// layer the timeline/projection (projected hit-date at the current contribution
// rate + the monthly shortfall) on top, plus the coverage "what you're missing"
// view over the resilience inputs.

import { planGoal, type FinancialGoal, type GoalPlan } from "./goals.ts";
import { monthlySurplusMinor, type FinancialProfile } from "./profile.ts";

const MS_PER_MONTH = 30 * 24 * 60 * 60 * 1000;

// UK LISA: £4,000/yr in, 25% government bonus, for a first home or retirement.
// Encoded as a structural rule (not a tunable knob) — see profile/goals style.
const LISA_ANNUAL_ALLOWANCE_MINOR = 4000_00;

// A "meaningful idle cash" floor: holding much more than a healthy buffer in a
// current account is the classic "money doing nothing" gap. 6 months of
// essentials is generous headroom above the 3-month resilience anchor.
const IDLE_CASH_BUFFER_MONTHS = 6;

export interface GoalForecast {
  goalId: string;
  /** Required-monthly + feasibility, straight from goals.ts (single source). */
  plan: GoalPlan;
  /** What the operator is actually putting in per month right now (their plan or
   * — absent that — the room they have, i.e. the monthly surplus). */
  currentMonthlyMinor: number;
  /** Months to the target at `currentMonthlyMinor`; null if not contributing. */
  monthsAtCurrentRate: number | null;
  /** Projected hit-date (ISO) at the current rate; null if not contributing. */
  projectedDate: string | null;
  /** £/month behind the required pace (0 if on track or ahead). Minor units. */
  monthlyGapMinor: number;
  /** "behind" | "on track" | "ahead" | "stalled" — the headline the agent leads with. */
  status: "behind" | "on track" | "ahead" | "stalled" | "reached";
  /** Action-first one-liner: what to actually do next. */
  nextAction: string;
}

/**
 * Project the savings timeline to a goal (house deposit being the canonical case).
 *
 * Assumptions (documented, no ambient state):
 *  - Simple fixed monthly contribution (no compounding) unless `monthlyGrowthRate`
 *    is supplied, in which case savings grow by that fraction each month on top of
 *    the contribution. Rate is passed in — never read from an environment.
 *  - `currentMonthlyMinor` defaults to the operator's monthly surplus (their room
 *    to manoeuvre) when no explicit contribution is given; this is what "the
 *    current rate" means when they haven't set up an auto-save yet.
 */
export function forecastGoal(
  profile: FinancialProfile,
  goal: FinancialGoal,
  now: string,
  opts: { currentMonthlyMinor?: number; monthlyGrowthRate?: number } = {},
): GoalForecast {
  const plan = planGoal(goal, profile, now);

  // Current contribution: explicit override, else the room the operator has.
  const currentMonthly =
    opts.currentMonthlyMinor ?? Math.max(0, monthlySurplusMinor(profile));

  if (plan.remainingMinor === 0) {
    return {
      goalId: goal.id,
      plan,
      currentMonthlyMinor: currentMonthly,
      monthsAtCurrentRate: null,
      projectedDate: null,
      monthlyGapMinor: 0,
      status: "reached",
      nextAction: "Goal reached — redirect this saving to the next objective.",
    };
  }

  const monthsAtCurrentRate =
    currentMonthly > 0
      ? monthsToTarget(plan.remainingMinor, currentMonthly, opts.monthlyGrowthRate)
      : null;

  const projectedDate =
    monthsAtCurrentRate === null
      ? null
      : new Date(
          new Date(now).getTime() + monthsAtCurrentRate * MS_PER_MONTH,
        ).toISOString();

  // Gap = how far the current rate falls short of the required pace.
  const required = plan.requiredMonthlyMinor;
  const monthlyGap =
    required === null ? 0 : Math.max(0, required - currentMonthly);

  let status: GoalForecast["status"];
  let nextAction: string;

  if (currentMonthly <= 0) {
    status = "stalled";
    nextAction =
      "No monthly room to save — free up surplus (trim essentials or lift income) before setting an auto-save.";
  } else if (required === null) {
    // Open-ended goal: any positive contribution is progress.
    status = "on track";
    nextAction = `Open-ended — at £${pounds(currentMonthly)}/mo you reach it by ${shortDate(projectedDate)}. Automate it so it just happens.`;
  } else if (monthlyGap > 0) {
    status = "behind";
    nextAction = `Behind by £${pounds(monthlyGap)}/mo. Set up an auto-save of £${pounds(required)}/mo${lisaHint(goal)} to land on time.`;
  } else if (currentMonthly > required) {
    status = "ahead";
    nextAction = `Ahead of pace — you could hit it early (${shortDate(projectedDate)}) or ease the auto-save to £${pounds(required)}/mo.`;
  } else {
    status = "on track";
    nextAction = `On track at £${pounds(currentMonthly)}/mo — automate it${lisaHint(goal)} so it stays on course to ${shortDate(plan.monthsRemaining === null ? projectedDate : goal.deadline ?? projectedDate)}.`;
  }

  return {
    goalId: goal.id,
    plan,
    currentMonthlyMinor: currentMonthly,
    monthsAtCurrentRate,
    projectedDate,
    monthlyGapMinor: monthlyGap,
    status,
    nextAction,
  };
}

/** Months to accumulate `remaining` at `monthly`, optional monthly growth on the
 * pot. No growth → simple ceil(remaining / monthly). With growth, solve the
 * future-value-of-an-annuity for n (still deterministic, just compounded). */
function monthsToTarget(
  remaining: number,
  monthly: number,
  growthRate?: number,
): number {
  if (!growthRate || growthRate <= 0) {
    return Math.ceil(remaining / monthly);
  }
  // FV of contributions only (starting from the remaining gap): grind month by
  // month — bounded, exact, and avoids log-edge-cases on tiny rates.
  let pot = 0;
  let months = 0;
  const cap = 1200; // 100 years — a hard stop, never expected to bind
  while (pot < remaining && months < cap) {
    pot = pot * (1 + growthRate) + monthly;
    months += 1;
  }
  return months;
}

export type CoverageGapKind =
  | "emergency_buffer"
  | "high_cost_debt"
  | "idle_cash"
  | "unused_lisa"
  | "no_pension_thought"
  | "unclaimed_support";

export interface CoverageGap {
  kind: CoverageGapKind;
  /** Short, FOR-them statement of what's missing. */
  finding: string;
  /** The single concrete next action — action-first, sells nothing. */
  nextAction: string;
  severity: "high" | "medium" | "low";
}

export interface CoverageReport {
  /** Missing protective/foundational things, highest-severity first. */
  gaps: CoverageGap[];
  /** Goals that are behind / stalled, by id — the forecast headline. */
  goalsBehind: string[];
  /** Nothing missing → the agent can say "you're covered" honestly. */
  covered: boolean;
}

/**
 * The "what you're missing" view (#5). Flags the absent foundations the student
 * won't surface themselves, each with a concrete next action and nothing to sell
 * (#4). Pure over the profile + goals; `forecasts` (optional) lets the report
 * fold in which goals are behind so the agent leads with the real headline.
 *
 * Order of foundations follows the standard PF ladder: clear high-cost debt and
 * build the emergency buffer FIRST, then put idle cash to work, then the
 * house-deposit vehicle (LISA), then long-horizon (pension).
 */
export function coverageReport(
  profile: FinancialProfile,
  goals: FinancialGoal[],
  now: string,
  opts: { contributions?: Record<string, number>; monthlyGrowthRate?: number } = {},
): CoverageReport {
  const gaps: CoverageGap[] = [];

  const essentials = profile.monthlyEssentialSpendMinor;
  const bufferMonths =
    essentials > 0 ? profile.liquidSavingsMinor / essentials : Infinity;

  // 1. Emergency buffer (the resilience anchor — < 3 months is the gap).
  if (bufferMonths < 3) {
    gaps.push({
      kind: "emergency_buffer",
      finding:
        bufferMonths < 1
          ? "No real emergency buffer — under a month of essentials covered."
          : `Thin emergency buffer (~${bufferMonths.toFixed(1)} months; aim for 3).`,
      nextAction:
        "Auto-save into an easy-access account until you have 3 months of essentials parked.",
      severity: bufferMonths < 1 ? "high" : "medium",
    });
  }

  // 2. High-cost debt (clear it before investing — the dominant research gap).
  if (profile.highCostDebtMinor > 0) {
    gaps.push({
      kind: "high_cost_debt",
      finding: `Carrying £${pounds(profile.highCostDebtMinor)} of high-cost debt that outpaces any savings return.`,
      nextAction:
        "Direct spare cash to clearing the highest-rate balance first before any investing.",
      severity: "high",
    });
  }

  // 3. Idle cash (money doing nothing — only once the buffer/debt are sorted).
  const idleFloor = essentials * IDLE_CASH_BUFFER_MONTHS;
  if (
    profile.highCostDebtMinor === 0 &&
    bufferMonths >= 3 &&
    essentials > 0 &&
    profile.liquidSavingsMinor > idleFloor
  ) {
    const idle = profile.liquidSavingsMinor - idleFloor;
    gaps.push({
      kind: "idle_cash",
      finding: `~£${pounds(idle)} sitting idle above a healthy buffer — likely losing to inflation.`,
      nextAction:
        "Move the excess into a goal vehicle (LISA for a first home, or a low-cost fund) — without anyone selling you a product.",
      severity: "low",
    });
  }

  // 4. House deposit without the LISA — the canonical 10-year goal + its vehicle.
  const houseGoal = goals.find((g) => isHouseGoal(g));
  const hasMonthlyRoom = monthlySurplusMinor(profile) > 0;
  if (houseGoal && hasMonthlyRoom) {
    gaps.push({
      kind: "unused_lisa",
      finding:
        "Saving for a home but not using a Lifetime ISA — leaving the 25% government bonus on the table.",
      nextAction: `Open a LISA and route the house-deposit saving through it (up to £${pounds(LISA_ANNUAL_ALLOWANCE_MINOR)}/yr earns the bonus).`,
      severity: "medium",
    });
  }

  // 5. No pension thought — long-horizon, lower priority for a student but worth a nudge.
  if (
    (profile.stage === "early-career" || profile.stage === "established") &&
    profile.highCostDebtMinor === 0 &&
    bufferMonths >= 3
  ) {
    gaps.push({
      kind: "no_pension_thought",
      finding:
        "Foundations are in place but nothing flagged for retirement — the longest-horizon, most tax-efficient pot.",
      nextAction:
        "Check you're at least capturing any employer pension match — it's free money before any other long-term saving.",
      severity: "low",
    });
  }

  // 6. Unclaimed support — surface the policy-pillar gap from the profile directly.
  if (profile.hasUnclaimedSupport) {
    gaps.push({
      kind: "unclaimed_support",
      finding:
        "Support you're entitled to (grants / hardship funds / benefits) is going unclaimed.",
      nextAction:
        "Claim it first — it's the highest-return move available and costs nothing.",
      severity: "high",
    });
  }

  // Fold in which goals are behind, so the agent can lead with the headline.
  const goalsBehind: string[] = [];
  for (const g of goals) {
    const f = forecastGoal(profile, g, now, {
      currentMonthlyMinor: opts.contributions?.[g.id],
      monthlyGrowthRate: opts.monthlyGrowthRate,
    });
    if (f.status === "behind" || f.status === "stalled") {
      goalsBehind.push(g.id);
    }
  }

  const severityRank = { high: 0, medium: 1, low: 2 } as const;
  gaps.sort((a, b) => severityRank[a.severity] - severityRank[b.severity]);

  return {
    gaps,
    goalsBehind,
    covered: gaps.length === 0 && goalsBehind.length === 0,
  };
}

function isHouseGoal(g: FinancialGoal): boolean {
  return /\b(house|home|deposit|property|flat|mortgage|lisa)\b/i.test(g.label);
}

function lisaHint(g: FinancialGoal): string {
  return isHouseGoal(g) ? " (a LISA earns a 25% bonus on a first home)" : "";
}

function pounds(minor: number): string {
  const major = minor / 100;
  return Number.isInteger(major) ? String(major) : major.toFixed(2);
}

function shortDate(iso: string | null): string {
  return iso ? iso.slice(0, 10) : "—";
}
