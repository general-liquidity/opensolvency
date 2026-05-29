// Persistence for the operator's financial profile + goals. Stored via the
// generic Store meta KV (as JSON), so `core/Store` stays domain-agnostic and
// doesn't depend on the finance layer. This is what gives the PF agent a real,
// durable operator to serve across sessions (the multi-year per-operator context
// that is the moat).

import type { Store } from "../core/store.ts";
import type { FinancialProfile } from "./profile.ts";
import type { FinancialGoal } from "./goals.ts";

const PROFILE_KEY = "finance.profile";
const GOALS_KEY = "finance.goals";

export function getProfile(store: Store): FinancialProfile | undefined {
  const raw = store.getMeta(PROFILE_KEY);
  return raw ? (JSON.parse(raw) as FinancialProfile) : undefined;
}

export function setProfile(store: Store, profile: FinancialProfile): void {
  store.setMeta(PROFILE_KEY, JSON.stringify(profile));
}

export function listGoals(store: Store): FinancialGoal[] {
  const raw = store.getMeta(GOALS_KEY);
  return raw ? (JSON.parse(raw) as FinancialGoal[]) : [];
}

/** Upsert a goal by id. */
export function saveGoal(store: Store, goal: FinancialGoal): void {
  const goals = listGoals(store).filter((g) => g.id !== goal.id);
  goals.push(goal);
  store.setMeta(GOALS_KEY, JSON.stringify(goals));
}
