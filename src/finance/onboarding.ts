// Onboarding — Networth's "ask the right questions to curate the experience".
// Turns a set of answers into a FinancialProfile, filling sensible (conservative)
// defaults for anything unspecified. Income + essentials are required; everything
// else has a default that errs toward LOWER assumed resilience (so the agent
// doesn't over-trust an under-described operator).

import type {
  AnxietyLevel,
  FinancialProfile,
  IncomeVolatility,
  LifeStage,
  SupportLevel,
} from "./profile.ts";

/** The operator-facing questions (the onboarding UX surfaces these). */
export const ONBOARDING_QUESTIONS = [
  "What's your typical monthly income (minor-units)?",
  "What do essentials cost you each month (minor-units)?",
  "How much do you have in accessible savings?",
  "Any high-cost debt (BNPL / payday / revolving) outstanding?",
  "Is your income stable, variable, or irregular?",
  "Could you get emergency help from family/friends? (strong / some / none)",
  "Do you have a financially-savvy person you learn from?",
  "Are you aware of grants / hardship funds / benefits you're entitled to?",
  "Do you use formal banking, or rely on informal credit?",
  "What stage are you at? (early-student / late-student / early-career / established)",
  "How anxious do you feel about money? (low / moderate / high)",
] as const;

export interface OnboardingAnswers {
  currency?: string;
  monthlyIncomeMinor: number;
  monthlyEssentialSpendMinor: number;
  liquidSavingsMinor?: number;
  highCostDebtMinor?: number;
  incomeVolatility?: IncomeVolatility;
  supportNetwork?: SupportLevel;
  hasRoleModel?: boolean;
  entitlementsAware?: boolean;
  hasUnclaimedSupport?: boolean;
  hasFormalBanking?: boolean;
  reliesOnInformalCredit?: boolean;
  stage?: LifeStage;
  financialAnxiety?: AnxietyLevel;
}

export function buildProfile(a: OnboardingAnswers): FinancialProfile {
  if (!Number.isInteger(a.monthlyIncomeMinor) || a.monthlyIncomeMinor < 0) {
    throw new Error("monthlyIncomeMinor must be a non-negative integer (minor-units)");
  }
  if (!Number.isInteger(a.monthlyEssentialSpendMinor) || a.monthlyEssentialSpendMinor < 0) {
    throw new Error("monthlyEssentialSpendMinor must be a non-negative integer");
  }
  return {
    currency: a.currency ?? "GBP",
    monthlyIncomeMinor: a.monthlyIncomeMinor,
    monthlyEssentialSpendMinor: a.monthlyEssentialSpendMinor,
    liquidSavingsMinor: a.liquidSavingsMinor ?? 0,
    highCostDebtMinor: a.highCostDebtMinor ?? 0,
    incomeVolatility: a.incomeVolatility ?? "variable",
    supportNetwork: a.supportNetwork ?? "none",
    hasRoleModel: a.hasRoleModel ?? false,
    entitlementsAware: a.entitlementsAware ?? false,
    hasUnclaimedSupport: a.hasUnclaimedSupport ?? false,
    hasFormalBanking: a.hasFormalBanking ?? true,
    reliesOnInformalCredit: a.reliesOnInformalCredit ?? false,
    stage: a.stage ?? "early-career",
    financialAnxiety: a.financialAnxiety ?? "moderate",
  };
}
