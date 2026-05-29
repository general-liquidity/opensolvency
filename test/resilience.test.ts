import { test } from "node:test";
import assert from "node:assert/strict";

import { assessResilience } from "../src/finance/resilience.ts";
import type { FinancialProfile } from "../src/finance/profile.ts";

// A mid-range baseline; archetypes override the fields that matter.
function profile(over: Partial<FinancialProfile> = {}): FinancialProfile {
  return {
    currency: "GBP",
    monthlyIncomeMinor: 1500_00,
    monthlyEssentialSpendMinor: 1100_00,
    liquidSavingsMinor: 1000_00,
    highCostDebtMinor: 0,
    incomeVolatility: "stable",
    supportNetwork: "some",
    hasRoleModel: false,
    entitlementsAware: true,
    hasUnclaimedSupport: false,
    hasFormalBanking: true,
    reliesOnInformalCredit: false,
    stage: "late-student",
    financialAnxiety: "low",
    ...over,
  };
}

// The archetype the research centres on: a student with weak pillars everywhere.
test("a fragile profile scores low across pillars and is tier 'fragile'", () => {
  const a = assessResilience(
    profile({
      monthlyIncomeMinor: 800_00,
      monthlyEssentialSpendMinor: 900_00, // essentials exceed income
      liquidSavingsMinor: 0,
      highCostDebtMinor: 1200_00, // BNPL/payday over a month's income
      incomeVolatility: "irregular",
      supportNetwork: "none",
      hasRoleModel: false,
      entitlementsAware: false,
      hasUnclaimedSupport: true,
      hasFormalBanking: true,
      reliesOnInformalCredit: true,
      financialAnxiety: "high",
    }),
  );
  assert.equal(a.tier, "fragile");
  assert.ok(a.overall < 40);
  assert.equal(a.anxietyDriven, true);
  assert.ok(a.reasons.some((r) => r.includes("anxiety")));
});

test("a well-resourced profile is tier 'secure'", () => {
  const a = assessResilience(
    profile({
      monthlyIncomeMinor: 3000_00,
      monthlyEssentialSpendMinor: 1500_00,
      liquidSavingsMinor: 9000_00, // ~6 months buffer
      highCostDebtMinor: 0,
      incomeVolatility: "stable",
      supportNetwork: "strong",
      hasRoleModel: true,
      entitlementsAware: true,
      hasUnclaimedSupport: false,
      hasFormalBanking: true,
      reliesOnInformalCredit: false,
      financialAnxiety: "low",
    }),
  );
  assert.equal(a.tier, "secure");
  assert.ok(a.overall >= 80);
});

// "No silver bullet": strong economics can't mask a collapsed social pillar.
test("identifies the weakest pillar and leans the overall toward it", () => {
  const strongEconomicsWeakSocial = profile({
    monthlyIncomeMinor: 3000_00,
    monthlyEssentialSpendMinor: 1200_00,
    liquidSavingsMinor: 9000_00,
    supportNetwork: "none",
    hasRoleModel: false,
  });
  const a = assessResilience(strongEconomicsWeakSocial);
  assert.equal(a.weakestPillar, "social");
  assert.ok(a.pillars.economic.score > a.pillars.social.score);
  // overall is dragged below the strong economic pillar by the weak social one.
  assert.ok(a.overall < a.pillars.economic.score);
});

test("the informal-credit gap lowers the infrastructure pillar", () => {
  const banked = assessResilience(profile({ reliesOnInformalCredit: false }));
  const informal = assessResilience(profile({ reliesOnInformalCredit: true }));
  assert.ok(
    informal.pillars.infrastructure.score < banked.pillars.infrastructure.score,
  );
  assert.ok(
    informal.pillars.infrastructure.reasons.some((r) => r.includes("informal")),
  );
});

test("a bigger emergency buffer monotonically raises the economic pillar", () => {
  const lo = assessResilience(profile({ liquidSavingsMinor: 0 }));
  const mid = assessResilience(profile({ liquidSavingsMinor: 1100_00 })); // ~1 mo
  const hi = assessResilience(profile({ liquidSavingsMinor: 4400_00 })); // ~4 mo
  assert.ok(lo.pillars.economic.score < mid.pillars.economic.score);
  assert.ok(mid.pillars.economic.score < hi.pillars.economic.score);
});

test("unclaimed support drags the policy pillar (advice-gap signal)", () => {
  const aware = assessResilience(
    profile({ entitlementsAware: true, hasUnclaimedSupport: false }),
  );
  const leaving = assessResilience(
    profile({ entitlementsAware: false, hasUnclaimedSupport: true }),
  );
  assert.ok(leaving.pillars.policy.score < aware.pillars.policy.score);
});
