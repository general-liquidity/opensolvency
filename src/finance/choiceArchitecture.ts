// Publication-bias discipline, applied to the harness's OWN behavioural levers.
//
// Konstantinos's papers are a critique, not a recipe. The Mertens et al. (2022)
// nudge meta-analysis reported a healthy d≈0.43 — but Maier et al. (2022) and
// Szaszi et al. (2022) showed that after correcting for publication bias, most of
// it evaporates: evidence AGAINST the "decision information" and "decision
// assistance" categories, and only "decision structure" (defaults / changing the
// path of least resistance) survives — and even then mainly defaults. This is the
// behavioural-science analogue of a deflated Sharpe: the raw effect is luck-
// inflated; the honest effect is much smaller and concentrated in one category.
//
// The harness has been accreting levers (peer nudges, trap-busting, slip-costs).
// This module tags each by Mertens's taxonomy and its POST-publication-bias
// strength, so the agent prefers the one lever class the evidence backs —
// changing the default — over informing/reminding. AgentWorth is uniquely able
// to use that class: unlike a passive app that can only inform, it ACTS (inside
// the gate), so it can make the better choice the default. The critique doesn't
// weaken the thesis; it says the moat IS the acting.
//
// Pure + deterministic: a static evidence table + selectors over it. No I/O.

/** Mertens et al.'s three intervention categories. */
export type ChoiceArchitectureCategory = "structure" | "information" | "assistance";

/** Strength of the effect AFTER correcting for publication bias (Maier/Szaszi):
 *  - robust    : survives correction (decision-structure / defaults).
 *  - weak      : a small effect remains, but heterogeneous and unreliable.
 *  - contested : evidence against an average effect once corrected. */
export type EvidenceStrength = "robust" | "weak" | "contested";

export interface LeverEvidence {
  /** the harness lever this classifies (matches an agent tool / module concept) */
  leverId: string;
  category: ChoiceArchitectureCategory;
  strength: EvidenceStrength;
  /** how the agent should lean on it, given the corrected evidence */
  guidance: string;
}

// The harness's behavioural levers, classified. The ONE robust class is the
// default-changing one — which is exactly what AgentWorth does when it acts on
// the operator's behalf inside the gate (move idle cash, fund the LISA, switch the
// account). Everything informational/assistive is down-ranked to "support, never
// rely on".
export const LEVER_EVIDENCE: readonly LeverEvidence[] = [
  {
    // Acting to change the default — the one class that survives correction, and
    // the one a passive app cannot do. The agent moving money (within a mandate)
    // to the better account / allowance IS a decision-structure change.
    leverId: "act_on_default", // find_optimizations → propose/execute the switch
    category: "structure",
    strength: "robust",
    guidance:
      "Make the better choice the default by acting inside the gate (move the cash, " +
      "open the allowance, switch the account) — this is the only lever the corrected " +
      "evidence reliably supports. Lead with it.",
  },
  {
    // Reminders / calculators that make a future consequence salient. Helpful for
    // engagement, but "decision assistance" is a category the correction argues
    // against — never treat the reminder as the mechanism.
    leverId: "cost_slip",
    category: "assistance",
    strength: "contested",
    guidance:
      "Use to make consequences visible, but don't rely on the reminder to change " +
      "behaviour — pair it with the concrete default-changing action.",
  },
  {
    leverId: "retirement_sim",
    category: "assistance",
    strength: "contested",
    guidance:
      "Use to make the long horizon concrete, then convert it into a standing " +
      "contribution (a default) — the projection alone is not the lever.",
  },
  {
    // Social proof — Mertens's headline, but exactly the "decision information"
    // category Maier/Szaszi find evidence against once corrected, plus a known
    // boomerang risk. Surface it; never make it the plan.
    leverId: "peer_nudge",
    category: "information",
    strength: "contested",
    guidance:
      "Low-confidence: surface the peer fact to encourage, but never rely on social " +
      "proof as the mechanism (corrected evidence is against it, and it can backfire). " +
      "Always attach the concrete action.",
  },
  {
    // Correcting beliefs / facts = providing information. A small residual effect
    // at best after correction; the research's own knowing–doing gap says so.
    leverId: "detect_traps",
    category: "information",
    strength: "weak",
    guidance:
      "Dissolve the belief in one line, then act — information closes little of the " +
      "knowing–doing gap on its own.",
  },
  {
    leverId: "knowledge_gaps",
    category: "information",
    strength: "weak",
    guidance:
      "State the corrected fact briefly, then propose the action it unlocks — never " +
      "lecture; the gap is behavioural, not informational.",
  },
];

const STRENGTH_RANK: Record<EvidenceStrength, number> = {
  robust: 0,
  weak: 1,
  contested: 2,
};

/** The harness's levers, strongest corrected-evidence first (then stable by id).
 *  Use to decide which lever to lead with. Pure. */
export function rankLeversByEvidence(): LeverEvidence[] {
  return [...LEVER_EVIDENCE].sort(
    (a, b) =>
      STRENGTH_RANK[a.strength] - STRENGTH_RANK[b.strength] ||
      (a.leverId < b.leverId ? -1 : a.leverId > b.leverId ? 1 : 0),
  );
}

/** Look up one lever's corrected-evidence classification, if known. */
export function evidenceFor(leverId: string): LeverEvidence | undefined {
  return LEVER_EVIDENCE.find((l) => l.leverId === leverId);
}

/** The standing prompt lines that encode the discipline: prefer changing the
 *  default (acting) over informing/nudging, because that's the only lever class
 *  the publication-bias-corrected evidence supports. Folded into the persona. */
export function choiceArchitectureGuidance(): string[] {
  return [
    "Prefer changing the DEFAULT over nudging: act inside the gate to make the better " +
      "choice the path of least resistance (move the cash, open the allowance). After " +
      "correcting for publication bias, decision-structure changes are the only nudge " +
      "class with reliable effects — information and reminders mostly don't move behaviour.",
    "Treat peer-comparison, belief-busting, and education as low-confidence support: " +
      "surface them briefly, but the mechanism is always the action you take, never the " +
      "message you send.",
  ];
}
