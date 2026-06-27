// The i-frame / s-frame honesty guardrail (Chater & Loewenstein 2023).
//
// Their thesis: focusing on individual-level ("i-frame") fixes deflects from the
// systemic ("s-frame") causes — and the financial industry's emphasis on personal
// financial planning is named outright as an i-frame trap that "overlooks
// structural barriers". AgentWorth IS a personal-financial-planning agent, so
// this is a mirror held up to it. The honest posture: when the operator faces a
// genuinely structural constraint (income below essentials, support they're owed
// and not claiming, predatory credit pushed onto them by the infrastructure),
// individual optimisation is a plaster over a wound (Greig Dickson's phrase about
// the financial-wellbeing course). The agent must NAME the structural reality —
// not as a personal failing — and point to the SYSTEMIC lever (claim the
// entitlement, switch the rail, get the hardship fund), not "spend less on lattes".
//
// This is not defeatism: the agent still acts on what it can (claim what exists,
// avoid predatory rails). It is honesty about what an app can and cannot fix —
// which is itself the differentiator from services that over-promise i-frame cures.
//
// Pure + deterministic over the FinancialProfile. No I/O.

import type { FinancialProfile } from "./profile.ts";
import { monthlySurplusMinor } from "./profile.ts";

export type StructuralConstraintId =
  | "income_below_essentials"
  | "unclaimed_entitlements"
  | "predatory_credit_dependence"
  | "no_formal_banking"
  | "entitlement_blindspot";

export interface StructuralConstraint {
  id: StructuralConstraintId;
  /** the structural reality, named plainly and WITHOUT blame */
  reality: string;
  /** why individual optimisation can't close it — the "plaster over a wound" line */
  whyIframeFails: string;
  /** the systemic (s-frame) lever the agent should point to / act on instead */
  systemicLever: string;
}

/**
 * Detect the structural constraints in the operator's situation — the cases where
 * individual budgeting/optimisation is the wrong frame and a systemic lever is the
 * real move. Ordered by how decisively the constraint dominates strategy (a hard
 * income squeeze first). Pure + deterministic.
 */
export function detectStructuralConstraints(
  profile: FinancialProfile,
): StructuralConstraint[] {
  const out: StructuralConstraint[] = [];

  // 1. Essentials meet/exceed income: there is no surplus to optimise. This is a
  //    structural squeeze (cost of living vs a fixed maintenance loan / low wage),
  //    not a discipline failure — and the harness's own optimisation levers have
  //    nothing to act on.
  if (monthlySurplusMinor(profile) <= 0) {
    out.push({
      id: "income_below_essentials",
      reality:
        "your essential costs meet or exceed your income — there's no surplus to budget with",
      whyIframeFails:
        "trimming small spending can't close a gap this size; it's a structural shortfall, not overspending",
      systemicLever:
        "the real levers are income-side and systemic: hardship funds, grants, a maintenance-loan reassessment, or more hours — claim what exists before any optimisation",
    });
  }

  // 2. Support owed and unclaimed: the single highest-leverage move is structural
  //    (claim it), and it dwarfs any thrift. The policy pillar, made actionable.
  if (profile.hasUnclaimedSupport) {
    out.push({
      id: "unclaimed_entitlements",
      reality: "there's support you're entitled to and not currently claiming",
      whyIframeFails:
        "no amount of personal budgeting beats money you're owed but haven't claimed",
      systemicLever:
        "claim the grant / hardship fund / benefit you qualify for — I can help find and start the claim; that's the highest-value action available",
    });
  }

  // 3. Predatory-credit dependence: BNPL / payday reliance is an infrastructure
  //    failure the system pushes onto exactly this demographic — the i-frame paper's
  //    point that the harm is structural, not a willpower deficit.
  if (profile.reliesOnInformalCredit || profile.highCostDebtMinor > 0) {
    out.push({
      id: "predatory_credit_dependence",
      reality:
        "you're leaning on high-cost or informal credit (BNPL / payday / revolving balances)",
      whyIframeFails:
        "these products are engineered to be the easy default for people in a squeeze — willpower isn't the missing piece",
      systemicLever:
        "switch the rail: move to a 0%/low-cost facility, consolidate, or route essentials through formal banking — change the structure rather than resisting it each time",
    });
  }

  // 4. No formal banking: an infrastructure barrier that blocks every downstream
  //    optimisation (no account to switch, no rate to chase).
  if (!profile.hasFormalBanking) {
    out.push({
      id: "no_formal_banking",
      reality: "you don't have formal banking access yet",
      whyIframeFails:
        "saving rates and switch bonuses are all out of reach without an account — the gap is access, not effort",
      systemicLever:
        "open a basic/fee-free current account (most banks must offer one) — this unlocks every other move",
    });
  }

  // 5. Entitlement blindspot: not aware of what's available. Cheaper than #2
  //    (nothing confirmed unclaimed yet) but still a policy-pillar gap to close
  //    before leaning on individual levers.
  if (!profile.entitlementsAware && !profile.hasUnclaimedSupport) {
    out.push({
      id: "entitlement_blindspot",
      reality: "you may not know the full set of support you're entitled to",
      whyIframeFails:
        "you can't claim what you don't know exists — and this is rarely surfaced to students",
      systemicLever:
        "let's check your eligibility for grants, hardship funds and benefits first — that's free money the system makes hard to find",
    });
  }

  return out;
}

/**
 * Does a structural constraint DOMINATE strategy — i.e. is individual optimisation
 * a plaster over a wound right now? True when the operator has no surplus to work
 * with, is owed unclaimed support, or depends on predatory credit. The persona
 * uses this to LEAD with the systemic lever instead of optimisation advice.
 */
export function structuralConstraintDominates(profile: FinancialProfile): boolean {
  return (
    monthlySurplusMinor(profile) <= 0 ||
    profile.hasUnclaimedSupport ||
    profile.reliesOnInformalCredit
  );
}
