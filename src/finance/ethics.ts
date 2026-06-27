// Empower-don't-exploit guardrail — the harness's cornerstone, elevated to a
// first-class check (now that we've dropped the engagement/gamification mechanics
// that could themselves exploit). It screens a proposed AGENT action against the
// patterns the research named as predatory — high-cost credit, manufactured urgency,
// preying on anxiety — and against the positive test: does it serve the operator's
// resilience or a goal? This guards the AGENT'S suggestions, on the operator's side.

export interface ProposedAction {
  summary: string;
  usesHighCostCredit: boolean; // BNPL / payday / revolving — the named enemy
  manufacturesUrgency: boolean; // "act now or lose out" pressure
  exploitsAnxiety: boolean; // leans on the operator's financial fear
  servesResilienceOrGoal: boolean; // tied to a pillar or a stated goal

  // Soft-saving guardrail. The 2024/25 cohort research is blunt: 73% value
  // quality-of-life over extra savings ("soft saving"), and money already
  // negatively affects 52%'s mental health. So moralising thrift, or pushing
  // saving against a stated quality-of-life preference, is itself a harm — the
  // agent must work WITHIN the operator's values, not against them. The line is
  // moralising/guilt-tripping/anxiety-leaning, NOT informing: surfacing a
  // genuine concern is still empowering.
  moralisesSpending?: boolean; // guilt-trips enjoyment / preaches thrift as virtue
  pushesSavingOverStatedQoL?: boolean; // overrides a stated quality-of-life preference to save more
}

export type EthicVerdict = "empowering" | "caution" | "exploitative";

export interface EthicCheck {
  verdict: EthicVerdict;
  reasons: string[];
}

export function checkEmpowerment(
  action: ProposedAction,
  ctx: { anxietyDriven: boolean; valuesQualityOfLife?: boolean },
): EthicCheck {
  const reasons: string[] = [];

  if (action.usesHighCostCredit) {
    reasons.push("pushes high-cost credit (BNPL/payday/revolving) — predatory pattern");
  }
  if (action.manufacturesUrgency) {
    reasons.push("manufactures urgency to pressure a decision");
  }
  if (action.exploitsAnxiety || (ctx.anxietyDriven && action.manufacturesUrgency)) {
    reasons.push("leans on the operator's financial anxiety");
  }
  if (action.moralisesSpending) {
    reasons.push("moralises spending / guilt-trips enjoyment — soft-saving harm");
  }
  // Pushing saving harder is only a violation when it overrides a stated
  // quality-of-life preference; absent that preference it's ordinary advice.
  if (action.pushesSavingOverStatedQoL && ctx.valuesQualityOfLife) {
    reasons.push(
      "pushes saving/thrift against the operator's stated quality-of-life preference",
    );
  }

  if (reasons.length > 0) {
    return { verdict: "exploitative", reasons };
  }
  if (!action.servesResilienceOrGoal) {
    return {
      verdict: "caution",
      reasons: ["does not serve a resilience pillar or a stated goal"],
    };
  }
  return { verdict: "empowering", reasons: ["serves the operator's resilience/goal cleanly"] };
}
