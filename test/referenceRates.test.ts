import test from "node:test";
import assert from "node:assert";

import { REFERENCE_MARKET_RATES, referenceMarketRates } from "../src/finance/referenceRates.ts";
import { findOptimizations } from "../src/finance/optimizations.ts";
import type { FinancialProfile } from "../src/finance/profile.ts";

const profile: FinancialProfile = {
  currency: "GBP",
  monthlyIncomeMinor: 150_000,
  monthlyEssentialSpendMinor: 80_000, // £700/mo surplus → room to fund a LISA
  liquidSavingsMinor: 400_000,
  highCostDebtMinor: 0,
  incomeVolatility: "stable",
  supportNetwork: "some",
  hasRoleModel: false,
  entitlementsAware: true,
  hasUnclaimedSupport: false,
  hasFormalBanking: true,
  reliesOnInformalCredit: false,
  stage: "late-student",
  financialAnxiety: "moderate",
};

test("reference rates carry the UK market constants", () => {
  assert.equal(REFERENCE_MARKET_RATES.isaAllowanceMinor, 2_000_000); // £20k
  assert.equal(REFERENCE_MARKET_RATES.lisaAllowanceMinor, 400_000); // £4k
  assert.equal(REFERENCE_MARKET_RATES.lisaBonusRate, 0.25); // 25% bonus
  assert.ok(REFERENCE_MARKET_RATES.bestSavingsRate > REFERENCE_MARKET_RATES.inflationRate);
});

test("reference rates alone surface the allowance-based wins out of the box", () => {
  // No per-operator account data, yet the unused-LISA optimization fires from the
  // reference allowances + the operator's surplus — the "works without a feed" claim.
  const opts = findOptimizations(profile, REFERENCE_MARKET_RATES);
  assert.ok(opts.some((o) => /lisa/i.test(o.id) || /lisa/i.test(o.win)));
});

test("referenceMarketRates merges per-operator overrides", () => {
  const merged = referenceMarketRates({ lisaUsedMinor: 400_000, inflationRate: 0.06 });
  assert.equal(merged.lisaUsedMinor, 400_000); // overridden
  assert.equal(merged.inflationRate, 0.06); // overridden
  assert.equal(merged.lisaAllowanceMinor, 400_000); // reference constant preserved
});
