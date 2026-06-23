import test from "node:test";
import assert from "node:assert";

import { watchSpending } from "../src/finance/watch.ts";
import { findOptimizations, toConcerns, type MarketRates } from "../src/finance/optimizations.ts";
import type { FinancialProfile } from "../src/finance/profile.ts";

const profile: FinancialProfile = {
  currency: "GBP",
  monthlyIncomeMinor: 120_000,
  monthlyEssentialSpendMinor: 80_000,
  liquidSavingsMinor: 500_000,
  highCostDebtMinor: 0,
  incomeVolatility: "variable",
  supportNetwork: "some",
  hasRoleModel: false,
  entitlementsAware: true,
  hasUnclaimedSupport: false,
  hasFormalBanking: true,
  reliesOnInformalCredit: false,
  stage: "late-student",
  financialAnxiety: "moderate",
};

const market: MarketRates = {
  inflationRate: 0.04,
  bestSavingsRate: 0.045,
  cashAccounts: [],
  switchOffers: [],
  isaAllowanceMinor: 2_000_000,
  isaUsedMinor: 0,
  lisaAllowanceMinor: 400_000,
  lisaUsedMinor: 0,
  lisaBonusRate: 0.25,
  riskFlags: [],
};

test("watchSpending is unchanged without a market source (backward-compatible)", () => {
  // An empty spend window has no spend-side concerns and no market = no optimizations.
  assert.deepEqual(watchSpending([], profile), []);
});

test("watchSpending appends exactly the optimization concerns when a market is supplied", () => {
  const base = watchSpending([], profile);
  const withMarket = watchSpending([], profile, market);
  const expected = toConcerns(findOptimizations(profile, market));
  assert.equal(withMarket.length, base.length + expected.length);
  assert.deepEqual(withMarket.slice(base.length), expected);
});
