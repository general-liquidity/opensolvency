// Goal-anchoring — transformed. Conventional finance apps made goals a motivational tracking page.
// Here a goal is an AGENT OBJECTIVE: the agent computes what reaching it requires
// and whether it's feasible given the operator's room to manoeuvre, so it can
// propose a concrete move/mandate (e.g. a recurring auto-save) — gated as usual.

import { monthlySurplusMinor, type FinancialProfile } from "./profile.ts";
import type { CurrencyCode } from "../core/types.ts";

export interface FinancialGoal {
  id: string;
  label: string;
  currency: CurrencyCode;
  targetMinor: number;
  currentMinor: number;
  deadline?: string; // ISO; open-ended if absent
}

export interface GoalPlan {
  goalId: string;
  remainingMinor: number;
  monthsRemaining: number | null; // null when open-ended
  requiredMonthlyMinor: number | null; // null when open-ended
  feasible: boolean;
  reasons: string[];
}

const MS_PER_MONTH = 30 * 24 * 60 * 60 * 1000;

export function planGoal(
  goal: FinancialGoal,
  profile: FinancialProfile,
  now: string,
): GoalPlan {
  const remaining = Math.max(0, goal.targetMinor - goal.currentMinor);
  const surplus = monthlySurplusMinor(profile);

  if (remaining === 0) {
    return {
      goalId: goal.id,
      remainingMinor: 0,
      monthsRemaining: null,
      requiredMonthlyMinor: null,
      feasible: true,
      reasons: ["goal already reached"],
    };
  }

  let monthsRemaining: number | null = null;
  if (goal.deadline) {
    const ms = new Date(goal.deadline).getTime() - new Date(now).getTime();
    monthsRemaining = Math.max(1, Math.ceil(ms / MS_PER_MONTH));
  }

  const requiredMonthly =
    monthsRemaining === null ? null : Math.ceil(remaining / monthsRemaining);

  const reasons: string[] = [];
  let feasible: boolean;
  if (requiredMonthly === null) {
    feasible = surplus > 0;
    reasons.push(
      surplus > 0
        ? `open-ended; ~${Math.ceil(remaining / surplus)} months at the current surplus`
        : "no monthly surplus to contribute — needs income/essentials change first",
    );
  } else {
    feasible = requiredMonthly <= surplus;
    reasons.push(
      `needs ${requiredMonthly} minor-units/month for ${monthsRemaining} months ` +
        `(surplus is ${surplus})`,
    );
    if (!feasible) {
      reasons.push("required contribution exceeds the monthly surplus");
    }
  }

  return {
    goalId: goal.id,
    remainingMinor: remaining,
    monthsRemaining,
    requiredMonthlyMinor: requiredMonthly,
    feasible,
    reasons,
  };
}
