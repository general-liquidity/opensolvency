// The operator's financial situation — the input the Networth-derived behavioural
// harness reasons over. Grounded in the Four Pillars of Financial Resilience
// (Angsten) plus the research's behaviour-over-knowledge findings (anxiety drives
// avoidance; informal-credit reliance is the systemic gap; life-stage shifts the
// horizon). Money is integer minor-units, consistent with the rest of the system.

import type { CurrencyCode } from "../core/types.ts";

export type IncomeVolatility = "stable" | "variable" | "irregular";
export type SupportLevel = "strong" | "some" | "none";
export type AnxietyLevel = "low" | "moderate" | "high";

/** Networth found the horizon matures across this arc (short-term → long-term). */
export type LifeStage = "early-student" | "late-student" | "early-career" | "established";

export interface FinancialProfile {
  currency: CurrencyCode;

  // Economic conditions
  monthlyIncomeMinor: number;
  monthlyEssentialSpendMinor: number;
  liquidSavingsMinor: number; // accessible emergency funds
  highCostDebtMinor: number; // revolving BNPL / payday / card balances
  incomeVolatility: IncomeVolatility;

  // Social support
  supportNetwork: SupportLevel; // can they get emergency help?
  hasRoleModel: boolean; // a financially-savvy person they learn from

  // Policy & environment
  entitlementsAware: boolean; // aware of grants / hardship funds / benefits
  hasUnclaimedSupport: boolean; // leaving available support on the table

  // Infrastructure
  hasFormalBanking: boolean;
  reliesOnInformalCredit: boolean; // the Networth "informal credit gap"

  // Context + behaviour (behaviour > knowledge)
  stage: LifeStage;
  financialAnxiety: AnxietyLevel; // anxiety → avoidance, per the research
}

/** Monthly money left after essentials — the room the agent has to work with. */
export function monthlySurplusMinor(p: FinancialProfile): number {
  return p.monthlyIncomeMinor - p.monthlyEssentialSpendMinor;
}
