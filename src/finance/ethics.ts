// Empower-don't-exploit guardrail — Networth's cornerstone, elevated to a
// first-class check (now that we've dropped the engagement/gamification mechanics
// that could themselves exploit). It screens a proposed AGENT action against the
// patterns Networth named as predatory — high-cost credit, manufactured urgency,
// preying on anxiety — and against the positive test: does it serve the operator's
// resilience or a goal? This guards the AGENT'S suggestions, on the operator's side.

export interface ProposedAction {
  summary: string;
  usesHighCostCredit: boolean; // BNPL / payday / revolving — the named enemy
  manufacturesUrgency: boolean; // "act now or lose out" pressure
  exploitsAnxiety: boolean; // leans on the operator's financial fear
  servesResilienceOrGoal: boolean; // tied to a pillar or a stated goal
}

export type EthicVerdict = "empowering" | "caution" | "exploitative";

export interface EthicCheck {
  verdict: EthicVerdict;
  reasons: string[];
}

export function checkEmpowerment(
  action: ProposedAction,
  ctx: { anxietyDriven: boolean },
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
