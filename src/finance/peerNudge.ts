// Peer comparison / social proof — the single strongest behavioural-economics
// lever in the field research. A consulting neuroscientist: "knowing
// your neighbour's electricity bill makes you save" — social proof beats every
// other nudge in the experimental literature (Schultz et al. 2007's normative-
// messaging study; Allcott 2011 on OPOWER home-energy reports both isolate the
// peer-comparison line as the active ingredient). Anne (research): peer influence
// + role models drive behaviour change for those who lack one.
//
// The product's wedge is being the trusted role-model for those who have none.
// This extends that to PEERS: "students like you save £X — here's the step to
// join them." CRITICALLY, social proof is a double-edged tool. The same studies
// show a "boomerang effect": telling someone they're below the norm can shame
// them into disengaging (or, if they're ABOVE it, into doing LESS). So the nudge
// MUST be encouraging and possibility-framed, never shaming or guilt-tripping —
// which is also exactly what ethics.ts forbids (moralising / anxiety-leaning).
// When the operator is at/above a benchmark we AFFIRM (never manufacture
// inadequacy), and we never push saving harder against a stated quality-of-life
// preference (mirrors the soft-saving stance in ethics.ts).
//
// Pure + deterministic. The cohort benchmark is INJECTED by the caller (a seam,
// like the market source in optimizations.ts) — never read live, never ambient.

import type { FinancialProfile } from "./profile.ts";
import { monthlySurplusMinor } from "./profile.ts";

// ── The injected cohort seam (no live API) ───────────────────────────────────
// Peer stats for someone like the operator. The caller closes over already-
// fetched cohort data (a survey aggregate, an anonymised cohort median). Like
// MarketRates: a deterministic source, injected, never read live.

export interface CohortBenchmark {
  /** human cohort label, surfaced verbatim — "second-year students", "people on
   * a variable income like yours". Used in the peerFact copy. */
  label: string;
  /** the cohort's median monthly amount put aside (minor-units) */
  medianMonthlySaveMinor: number;
  /** fraction of the cohort with an ISA or LISA open (0..1) */
  fractionWithIsaOrLisa: number;
  /** the cohort's median emergency buffer, in months of essential spend */
  medianEmergencyBufferMonths: number;
}

// ── The nudge output ─────────────────────────────────────────────────────────

export type PeerDimension =
  | "monthly_save"
  | "isa_or_lisa"
  | "emergency_buffer";

/** A social-proof nudge. Possibility-framed: it names where peers are, where the
 * operator is, and the one concrete step to join them — or affirms when the
 * operator is already at/above the cohort. Never shames. */
export interface PeerNudge {
  /** stable id = the dimension plus polarity, for routing/dedup */
  id: string;
  dimension: PeerDimension;
  /** the peer fact in plain words ("students like you save £X/mo") */
  peerFact: string;
  /** the operator's gap below the benchmark, minor-units (>0 below; 0 at/above).
   * For emergency_buffer it is the shortfall expressed in minor-units of monthly
   * essential spend, so all gaps share one comparable closeable-impact scale. */
  gap: number;
  /** the single concrete next action — action-first, never an explanation */
  action: string;
  /** the encouraging, possibility-framed sentence ("you're close — …") */
  framing: string;
}

export interface PeerNudgeOptions {
  /** mirror ethics.ts: when the operator has stated a quality-of-life preference,
   * soften (don't drop the social proof, but never push "save harder") the
   * save-more nudge rather than nudging thrift against their values. */
  valuesQualityOfLife?: boolean;
}

const ROUND = Math.round;

/**
 * Emit a social-proof nudge per dimension where the operator sits BELOW a peer
 * benchmark — each encouraging, action-first, possibility-framed. At/above the
 * benchmark yields an affirming nudge (never manufactured inadequacy). Sorted by
 * closeable impact (largest gap first) so the most valuable joinable step leads.
 * Pure + deterministic.
 */
export function peerNudges(
  profile: FinancialProfile,
  benchmark: CohortBenchmark,
  opts: PeerNudgeOptions = {},
): PeerNudge[] {
  const out: PeerNudge[] = [];
  const cohort = benchmark.label;

  // 1. Monthly saving vs the cohort median. We don't track a realised monthly
  //    contribution on the profile, so the operator's room to save is their
  //    surplus — and "below" means their surplus can't yet match the peer median
  //    (we never frame a step they can't take). Capacity, not realised saving.
  const surplus = Math.max(0, monthlySurplusMinor(profile));
  const operatorSave = surplus;
  const peerSave = benchmark.medianMonthlySaveMinor;
  if (operatorSave < peerSave) {
    // The joinable step is the gap, but capped at what their surplus allows — a
    // possibility, never a demand they can't meet.
    const fullGap = peerSave - operatorSave;
    const step = Math.min(fullGap, surplus);
    const peerFact = `${cohort} put aside about £${minor(peerSave)}/mo`;
    if (opts.valuesQualityOfLife) {
      // Soft-saving: keep the social proof (informing is empowering) but DON'T
      // push thrift against a stated quality-of-life preference — offer the step
      // as an open option tied to their own goals, not a target to hit.
      out.push({
        id: "monthly_save:below_soft",
        dimension: "monthly_save",
        gap: fullGap,
        peerFact,
        action:
          "no change needed — when you want to, even £" +
          `${minor(roundFriendly(step))}/mo would move you toward where peers are, on your terms`,
        framing:
          `${peerFact}; you're at £${minor(operatorSave)}/mo and that's a fine choice — ` +
          "this is here whenever it fits what you want from your money, not a target to chase",
      });
    } else {
      out.push({
        id: "monthly_save:below",
        dimension: "monthly_save",
        gap: fullGap,
        peerFact,
        action: `set up a standing £${minor(roundFriendly(step))}/mo transfer on payday to join them`,
        framing:
          `you're close — ${peerFact}; you're at £${minor(operatorSave)}/mo, ` +
          `so a £${minor(roundFriendly(step))}/mo step puts you alongside them`,
      });
    }
  } else if (peerSave > 0) {
    out.push(affirm(
      "monthly_save",
      `you're already saving as much as ${cohort} (£${minor(peerSave)}/mo) or more — that's genuinely ahead`,
    ));
  }

  // 2. ISA/LISA take-up vs the cohort. A majority-of-peers fact is the canonical
  //    social-proof line ("most students like you have one open"). We only nudge
  //    when it's actually the norm (fraction > 0.5) AND the operator hasn't joined.
  const peerHasTaxWrapper = benchmark.fractionWithIsaOrLisa > 0.5;
  const operatorHasTaxWrapper = profile.entitlementsAware && profile.liquidSavingsMinor > 0;
  if (peerHasTaxWrapper && !operatorHasTaxWrapper) {
    const peerFact = `${pct(benchmark.fractionWithIsaOrLisa)} of ${cohort} have an ISA or LISA open`;
    out.push({
      id: "isa_or_lisa:below",
      dimension: "isa_or_lisa",
      // Take-up is a yes/no dimension; scale its closeable impact to the cohort
      // median save so it sorts sensibly among the money gaps.
      gap: peerSave,
      peerFact,
      action: "open a free ISA or LISA — it takes ~10 minutes and your savings keep growing tax-free",
      framing:
        `you're one step from joining them — ${peerFact}, and opening one is the ` +
        "single move that puts you in that group",
    });
  } else if (peerHasTaxWrapper && operatorHasTaxWrapper) {
    out.push(affirm(
      "isa_or_lisa",
      `you're in the group that's set this up — most of ${cohort} have, and so have you`,
    ));
  }

  // 3. Emergency buffer (months of essential spend) vs the cohort median. The
  //    gap is expressed in minor-units of essential spend so it shares the same
  //    closeable-impact scale as the money dimensions for sorting.
  const essential = profile.monthlyEssentialSpendMinor;
  const operatorBufferMonths = essential > 0 ? profile.liquidSavingsMinor / essential : 0;
  const peerBufferMonths = benchmark.medianEmergencyBufferMonths;
  if (essential > 0 && peerBufferMonths > 0 && operatorBufferMonths < peerBufferMonths) {
    const shortfallMonths = peerBufferMonths - operatorBufferMonths;
    const shortfallMinor = ROUND(shortfallMonths * essential);
    const peerFact =
      `${cohort} typically hold about ${trim(peerBufferMonths)} months' essentials as a buffer`;
    const monthlyTopUp = roundFriendly(ROUND(shortfallMinor / 6)); // a gentle 6-month glide
    out.push({
      id: "emergency_buffer:below",
      dimension: "emergency_buffer",
      gap: shortfallMinor,
      peerFact,
      action: `nudge £${minor(monthlyTopUp)}/mo into an instant-access pot to build toward the same cushion`,
      framing:
        `you're building toward it — ${peerFact}; you're at ${trim(operatorBufferMonths)} months, ` +
        `so steady top-ups get you to where they are`,
    });
  } else if (essential > 0 && peerBufferMonths > 0) {
    out.push(affirm(
      "emergency_buffer",
      `your safety cushion already matches ${cohort} (~${trim(peerBufferMonths)} months) — that's a strong position`,
    ));
  }

  // Sort by closeable impact (largest gap first) so the highest-value joinable
  // step leads; ties break on the stable id for deterministic ordering.
  return out.sort((a, b) => b.gap - a.gap || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/** An affirming, at/above-benchmark nudge: gap 0, no action to take, pure
 * encouragement. Never manufactures inadequacy. */
function affirm(dimension: PeerDimension, framing: string): PeerNudge {
  return {
    id: `${dimension}:affirm`,
    dimension,
    gap: 0,
    peerFact: framing,
    action: "keep it up — nothing to change here",
    framing,
  };
}

// ── helpers ──────────────────────────────────────────────────────────────────

/** Minor-units → a plain pounds string (2-decimal assumption, as elsewhere). */
function minor(amountMinor: number): string {
  const pounds = amountMinor / 100;
  return Number.isInteger(pounds) ? String(pounds) : pounds.toFixed(2);
}

/** Fraction → a percent string, trimming a trailing ".0". */
function pct(rate: number): string {
  const p = rate * 100;
  return `${Number.isInteger(p) ? String(p) : p.toFixed(0)}%`;
}

/** Trim a months figure to one decimal, dropping a trailing ".0". */
function trim(months: number): string {
  return Number.isInteger(months) ? String(months) : months.toFixed(1);
}

/** Round a suggested transfer to a friendly whole-pound step (never £0 when the
 * underlying gap is positive) so the action reads as a clean, takeable amount. */
function roundFriendly(amountMinor: number): number {
  if (amountMinor <= 0) return 0;
  const pounds = Math.max(1, Math.round(amountMinor / 100));
  return pounds * 100;
}
