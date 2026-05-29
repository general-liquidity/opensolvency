// Four Pillars of Financial Resilience — the heart of Networth's research
// (Anne Angsten: "financial resilience is supported by four main pillars:
// economic conditions, social support, policy, and infrastructure"). Each pillar
// scores 0–100 from the profile; the overall score deliberately leans on the
// WEAKEST pillar, because the research is explicit that "there is no silver
// bullet" and weakness in any one pillar undermines the whole.
//
// This is the behavioural-harness analogue of the spend-risk classifier: a pure,
// transparent, testable assessment. Thresholds are calibrated heuristics (named
// constants below), locked by the test archetypes — not claimed as precise.

import type { FinancialProfile } from "./profile.ts";

export type Pillar = "economic" | "social" | "policy" | "infrastructure";
export type ResilienceTier = "fragile" | "stretched" | "stable" | "secure";

export interface PillarScore {
  pillar: Pillar;
  score: number; // 0–100
  reasons: string[];
}

export interface ResilienceAssessment {
  pillars: Record<Pillar, PillarScore>;
  overall: number; // 0–100, weighted toward the weakest pillar
  tier: ResilienceTier;
  weakestPillar: Pillar;
  reasons: string[];
  /** Behaviour-over-knowledge flag: high anxiety predicts avoidance, so the
   * harness should reduce friction / lead with reassurance, not more numbers. */
  anxietyDriven: boolean;
}

const TARGET_BUFFER_MONTHS = 3; // a 3-month emergency buffer is the resilience anchor

function clamp(n: number): number {
  return Math.max(0, Math.min(100, Math.round(n)));
}

function bufferMonths(p: FinancialProfile): number {
  if (p.monthlyEssentialSpendMinor > 0) {
    return p.liquidSavingsMinor / p.monthlyEssentialSpendMinor;
  }
  return p.liquidSavingsMinor > 0 ? TARGET_BUFFER_MONTHS * 2 : 0;
}

function scoreEconomic(p: FinancialProfile): PillarScore {
  const reasons: string[] = [];
  let score = 50;

  const months = bufferMonths(p);
  if (months >= TARGET_BUFFER_MONTHS) {
    score += 25;
    reasons.push(`emergency buffer ≈ ${months.toFixed(1)} months`);
  } else if (months >= 1) {
    score += 5;
    reasons.push(`thin buffer ≈ ${months.toFixed(1)} months`);
  } else {
    score -= 25;
    reasons.push("under 1 month of emergency buffer");
  }

  const surplus = p.monthlyIncomeMinor - p.monthlyEssentialSpendMinor;
  if (surplus > 0) {
    score += 10;
  } else {
    score -= 20;
    reasons.push("essentials meet or exceed income");
  }

  if (p.highCostDebtMinor > 0) {
    const ratio =
      p.monthlyIncomeMinor > 0 ? p.highCostDebtMinor / p.monthlyIncomeMinor : 99;
    if (ratio >= 1) {
      score -= 20;
      reasons.push("high-cost debt exceeds a month's income");
    } else {
      score -= 10;
      reasons.push("carrying high-cost debt");
    }
  }

  if (p.incomeVolatility === "variable") {
    score -= 8;
    reasons.push("variable income");
  } else if (p.incomeVolatility === "irregular") {
    score -= 16;
    reasons.push("irregular income");
  }

  return { pillar: "economic", score: clamp(score), reasons };
}

function scoreSocial(p: FinancialProfile): PillarScore {
  const reasons: string[] = [];
  let score = { strong: 85, some: 60, none: 30 }[p.supportNetwork];
  reasons.push(
    p.supportNetwork === "none"
      ? "no support network to fall back on"
      : `${p.supportNetwork} support network`,
  );
  if (p.hasRoleModel) {
    score += 10;
    reasons.push("has a financial role model");
  } else {
    score -= 5;
    reasons.push("no financial role model (peer/mentor effects unused)");
  }
  return { pillar: "social", score: clamp(score), reasons };
}

function scorePolicy(p: FinancialProfile): PillarScore {
  const reasons: string[] = [];
  let score = 50;
  if (p.entitlementsAware) {
    score += 25;
    reasons.push("aware of entitlements / support schemes");
  } else {
    score -= 15;
    reasons.push("may be unaware of available support");
  }
  if (p.hasUnclaimedSupport) {
    score -= 25;
    reasons.push("unclaimed support left on the table (grants/hardship/benefits)");
  }
  return { pillar: "policy", score: clamp(score), reasons };
}

function scoreInfrastructure(p: FinancialProfile): PillarScore {
  const reasons: string[] = [];
  let score = 50;
  if (p.hasFormalBanking) {
    score += 30;
    reasons.push("uses formal banking");
  } else {
    score -= 30;
    reasons.push("no formal banking access");
  }
  if (p.reliesOnInformalCredit) {
    score -= 25;
    reasons.push("relies on informal/predatory credit (BNPL/payday)");
  } else {
    score += 10;
  }
  return { pillar: "infrastructure", score: clamp(score), reasons };
}

function tierFor(overall: number): ResilienceTier {
  if (overall < 40) return "fragile";
  if (overall < 60) return "stretched";
  if (overall < 80) return "stable";
  return "secure";
}

export function assessResilience(p: FinancialProfile): ResilienceAssessment {
  const pillarScores: PillarScore[] = [
    scoreEconomic(p),
    scoreSocial(p),
    scorePolicy(p),
    scoreInfrastructure(p),
  ];
  const pillars = Object.fromEntries(
    pillarScores.map((s) => [s.pillar, s]),
  ) as Record<Pillar, PillarScore>;

  const values = pillarScores.map((s) => s.score);
  const min = Math.min(...values);
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  // Lean on the weakest pillar: no silver bullet, weakness anywhere undermines.
  const overall = clamp(0.5 * min + 0.5 * mean);

  const weakest = pillarScores.reduce((a, b) => (b.score < a.score ? b : a));

  const reasons = [
    `weakest pillar: ${weakest.pillar} (${weakest.score}/100)`,
    ...weakest.reasons,
  ];
  if (p.financialAnxiety === "high") {
    reasons.push("high financial anxiety — lead with reassurance, reduce friction");
  }

  return {
    pillars,
    overall,
    tier: tierFor(overall),
    weakestPillar: weakest.pillar,
    reasons,
    anxietyDriven: p.financialAnxiety === "high",
  };
}
