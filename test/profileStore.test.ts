import { test } from "node:test";
import assert from "node:assert/strict";

import { createMemoryStore } from "../src/store/memoryStore.ts";
import { buildProfile } from "../src/finance/onboarding.ts";
import { getProfile, setProfile, saveGoal, listGoals } from "../src/finance/profileStore.ts";

test("profile round-trips through the store meta KV", () => {
  const store = createMemoryStore("k");
  assert.equal(getProfile(store), undefined);
  const p = buildProfile({
    monthlyIncomeMinor: 2000_00,
    monthlyEssentialSpendMinor: 1000_00,
    liquidSavingsMinor: 3000_00,
  });
  setProfile(store, p);
  assert.deepEqual(getProfile(store), p);
});

test("onboarding defaults err toward lower assumed resilience", () => {
  const p = buildProfile({
    monthlyIncomeMinor: 2000_00,
    monthlyEssentialSpendMinor: 1000_00,
  });
  assert.equal(p.supportNetwork, "none");
  assert.equal(p.incomeVolatility, "variable");
  assert.equal(p.entitlementsAware, false);
  assert.equal(p.financialAnxiety, "moderate");
});

test("onboarding validates required numeric inputs", () => {
  assert.throws(() =>
    buildProfile({ monthlyIncomeMinor: -1, monthlyEssentialSpendMinor: 0 }),
  );
});

test("goals upsert by id", () => {
  const store = createMemoryStore("k");
  saveGoal(store, { id: "g1", label: "fund", currency: "GBP", targetMinor: 500_00, currentMinor: 0 });
  assert.equal(listGoals(store).length, 1);
  saveGoal(store, { id: "g1", label: "fund-v2", currency: "GBP", targetMinor: 600_00, currentMinor: 0 });
  assert.equal(listGoals(store).length, 1);
  assert.equal(listGoals(store)[0].label, "fund-v2");
});
