// Knowledge gaps — the FACTUAL misconceptions that cause wrong ACTIONS. This is
// the complement of cognitiveTraps.ts: traps are engagement-blocking *beliefs*
// ("investing is gambling" — they don't act); gaps are *false facts* ("a card
// balance is good debt" — they act, wrongly). The two harnesses run side by side.
//
// Source: our quantitative literacy quiz of survey respondents. Each gap
// encodes the measured prevalence (in a comment), the corrected fact, and the
// concrete ACTION it unlocks — action-first, never a lecture, matching the
// persona's "act, don't teach" rule.
//
// Detection keys off FinancialProfile fields plus an optional caller-supplied
// KnowledgeSignals object for facts the profile doesn't carry (ISA usage, voter
// registration). Pure + deterministic: same inputs → same output, same order.

import type { FinancialProfile } from "./profile.ts";
import { monthlySurplusMinor } from "./profile.ts";

export type KnowledgeGapId =
  | "money-isnt-an-asset"
  | "debt-not-prioritised"
  | "isa-allowance-unknown"
  | "credit-score-factors-misunderstood"
  | "compounding-frequency"
  | "inflation-erodes-idle-cash"
  | "bnpl-is-still-debt";

/**
 * Caller-supplied signals for facts the FinancialProfile doesn't carry. All
 * optional — when omitted, detection falls back to profile structure only, so a
 * gap can still surface (or stay quiet) from the profile alone.
 */
export interface KnowledgeSignals {
  /** Fraction of the £20k ISA allowance used this tax year, 0–1. */
  isaUsedFraction?: number;
  /** Whether the operator is registered to vote (lifts the credit score). */
  registeredToVote?: boolean;
  /** Operator's idle-cash savings rate (annual, as a fraction e.g. 0.01 = 1%). */
  cashSavingsRate?: number;
  /** Prevailing inflation rate (annual fraction), injected — the kernel reads no feed. */
  inflationRate?: number;
  /** Whether the operator uses Buy-Now-Pay-Later (Klarna / Clearpay / etc.). */
  usesBnpl?: boolean;
  /** Outstanding BNPL balance in minor units, if known — counts as debt to clear. */
  bnplBalanceMinor?: number;
}

export interface KnowledgeGap {
  id: KnowledgeGapId;
  /** The false belief stated as the operator holds it — plain words. */
  misconception: string;
  /** The corrected fact, stated once, plainly — not a lecture. */
  fact: string;
  /** The smallest concrete action the corrected fact unlocks. */
  action: string;
  /** Share of the 340-respondent quiz that got this wrong (0–1), if measured. */
  prevalence?: number;
}

/** A detected gap with its salience for THIS operator and why it tripped. */
export interface DetectedKnowledgeGap extends KnowledgeGap {
  /** 0–100: how strongly this profile/signals indicate the gap is actionable now. */
  relevance: number;
  /** The structural reasons the gap surfaced. */
  evidence: string[];
}

/** Per-gap deterministic signal. Returns a salience score (0–100) and the reasons.
 * A score of 0 means no actionable signal — the gap stays latent for this operator. */
type GapSignal = (
  p: FinancialProfile,
  s: KnowledgeSignals,
) => { score: number; reasons: string[] };

interface GapSpec extends KnowledgeGap {
  signal: GapSignal;
}

// Default macro assumption: UK inflation has run well above easy-access cash rates;
// when the caller injects no rates, idle cash above a meaningful buffer is treated
// as losing real value. Kept conservative so it only trips on genuinely idle cash.
const DEFAULT_INFLATION_RATE = 0.03;
const DEFAULT_CASH_SAVINGS_RATE = 0.0; // most idle current-account cash earns ~0

/** Cash sitting beyond ~one month of essentials — the genuinely deployable surplus
 * cash, distinct from the emergency buffer that SHOULD stay liquid and accessible. */
function idleCashMinor(p: FinancialProfile): number {
  const buffer = Math.max(0, p.monthlyEssentialSpendMinor);
  return p.liquidSavingsMinor - buffer;
}

// --- Gap specifications ------------------------------------------------------

const SPECS: GapSpec[] = [
  {
    // Quiz: 44% wrongly think cash-in-account is the only asset — they don't grasp
    // assets vs liabilities, so they never name (or grow) what they own. Action:
    // name a real asset they already hold and reframe idle cash as deployable.
    id: "money-isnt-an-asset",
    misconception: "The money in my account is the only asset I have.",
    fact:
      "An asset is anything that holds or grows value — cash is one, but so is a " +
      "LISA, a pension, an index fund, even a deposit you're building. Idle cash " +
      "is the weakest of them.",
    action:
      "Name one asset you already own beyond your balance (LISA / pension / fund). " +
      "If it's only cash, move a slice into one that grows — that's a new asset today.",
    prevalence: 0.44,
    signal: (p, _s) => {
      const reasons: string[] = [];
      let score = 0;
      // Idle cash (beyond buffer) with nothing growing is the footprint of this gap.
      const idle = idleCashMinor(p);
      if (idle > 0 && !p.hasRoleModel) {
        score += 35;
        reasons.push("idle cash beyond buffer, no role model — assets-vs-liabilities likely unlearned");
      }
      if (monthlySurplusMinor(p) > 0 && idle > 0) {
        score += 20;
        reasons.push("has surplus and idle cash — nothing deployed as a growing asset");
      }
      return { score, reasons };
    },
  },
  {
    // Quiz: only 24% prioritise paying debt; many read a card balance as "good
    // debt". Clearing high-cost revolving debt is the single highest guaranteed
    // return there is. Action: clear it before saving/investing.
    id: "debt-not-prioritised",
    misconception: "A credit-card / BNPL balance is fine — it's 'good debt'.",
    fact:
      "High-cost revolving debt (card / BNPL / payday) is the most expensive money " +
      "you hold. Clearing it is a guaranteed return equal to its rate — higher than " +
      "any saving or investment you'd make instead.",
    action:
      "Before saving or investing another pound, clear the high-cost balance first — " +
      "it's the single highest-return move available to you. I'll size the payments.",
    prevalence: 0.76, // 100% − 24% who correctly prioritise
    signal: (p, _s) => {
      const reasons: string[] = [];
      let score = 0;
      if (p.highCostDebtMinor > 0) {
        score += 55;
        reasons.push("carrying high-cost debt — clearing it beats any save/invest return");
        // Saving while carrying high-cost debt is the wrong-action signature exactly.
        if (p.liquidSavingsMinor > 0) {
          score += 20;
          reasons.push("holding savings alongside the debt — paying the debt down wins");
        }
      }
      return { score, reasons };
    },
  },
  {
    // Quiz: 39% don't know the £20k ISA allowance and most never max it — a free,
    // tax-sheltered wrapper left unused. Action: state how much of the £20k is
    // used and the concrete win in the remaining headroom.
    id: "isa-allowance-unknown",
    misconception: "I don't know how much I can shelter in an ISA (or that I can).",
    fact:
      "You can put up to £20,000 a year into an ISA, and everything inside it grows " +
      "and pays out tax-free. The allowance resets each tax year — unused headroom " +
      "is gone, not carried over.",
    action:
      "You've used about £X of your £20k ISA allowance this year — here's the win: " +
      "shelter your next savings/investing inside it before the year resets.",
    prevalence: 0.39,
    signal: (p, s) => {
      const reasons: string[] = [];
      let score = 0;
      // Capacity to use the allowance is the precondition; not maxing it is the gap.
      const hasCapacity = monthlySurplusMinor(p) > 0 || idleCashMinor(p) > 0;
      if (hasCapacity) {
        if (s.isaUsedFraction === undefined) {
          score += 30;
          reasons.push("has savings capacity, ISA usage unknown — allowance likely under-used");
        } else if (s.isaUsedFraction < 1) {
          // The further from maxed, the larger the unclaimed shelter.
          score += 25 + Math.round((1 - s.isaUsedFraction) * 30);
          reasons.push(
            `only ${Math.round(s.isaUsedFraction * 100)}% of the £20k allowance used — headroom left`,
          );
        }
      }
      return { score, reasons };
    },
  },
  {
    // Quiz: 60% wrong on what affects a credit score — e.g. that registering to
    // vote LIFTS it. These are free wins people miss. Action: the specific free
    // score win (electoral roll) when the signal says it's unclaimed.
    id: "credit-score-factors-misunderstood",
    misconception: "I'm not sure what actually moves my credit score.",
    fact:
      "Your score is driven by knowable, mostly-free factors: being on the electoral " +
      "roll lifts it, on-time payments build it, and high utilisation drags it. None " +
      "of it is mysterious or paid-for.",
    action:
      "Grab the free score wins: register on the electoral roll if you haven't, and " +
      "keep card utilisation low — both lift the score at no cost. I'll flag the rest.",
    prevalence: 0.6,
    signal: (p, s) => {
      const reasons: string[] = [];
      let score = 0;
      // A concrete, free, unclaimed win: not on the electoral roll.
      if (s.registeredToVote === false) {
        score += 45;
        reasons.push("not registered to vote — a free credit-score lift left unclaimed");
      } else if (s.registeredToVote === undefined) {
        score += 25;
        reasons.push("voter-registration unknown — the electoral-roll score win may be unclaimed");
      }
      // Carrying high-cost (often revolving) debt raises the stakes of the score gap.
      if (p.highCostDebtMinor > 0) {
        score += 10;
        reasons.push("carries revolving debt — utilisation likely dragging the score");
      }
      return { score, reasons };
    },
  },
  {
    // Quiz: 35% wrong that more frequent compounding wins — so they pick a worse
    // account on headline rate alone. Action: when comparing, prefer the more
    // frequent (monthly) compounding at the same rate.
    id: "compounding-frequency",
    misconception: "How often interest compounds doesn't really matter.",
    fact:
      "At the same headline rate, more frequent compounding wins: monthly beats " +
      "annual because each period's interest earns interest sooner. Compare the " +
      "effective rate (AER), not just the headline.",
    action:
      "When choosing between two accounts at the same rate, pick the one that " +
      "compounds more often (monthly over annual) — same rate, more money.",
    prevalence: 0.35,
    signal: (p, _s) => {
      const reasons: string[] = [];
      let score = 0;
      // Relevant the moment they have deployable cash (beyond buffer) or a surplus
      // to place into an interest-bearing account — the buffer itself stays liquid.
      if (idleCashMinor(p) > 0 || monthlySurplusMinor(p) > 0) {
        score += 25;
        reasons.push("has deployable cash to place — compounding-frequency choice is live");
      }
      return { score, reasons };
    },
  },
  {
    // Quiz: ~30% unaware cash below inflation loses real value — so they leave it
    // idle in a 0%-ish current account. Action: move idle cash to a rate above
    // inflation (still accessible). Only trips on genuinely idle cash.
    id: "inflation-erodes-idle-cash",
    misconception: "Cash sitting in my account keeps its value over time.",
    fact:
      "Cash earning below inflation loses real value every year — at ~3% inflation, " +
      "£1,000 in a 0% account buys ~£30 less in a year. It's a quiet loss, not a hold.",
    action:
      "Move idle cash above your emergency buffer into an easy-access account paying " +
      "above inflation — still instant to reach, but no longer losing value each year.",
    prevalence: 0.3,
    signal: (p, s) => {
      const reasons: string[] = [];
      let score = 0;
      const cashRate = s.cashSavingsRate ?? DEFAULT_CASH_SAVINGS_RATE;
      const inflation = s.inflationRate ?? DEFAULT_INFLATION_RATE;
      // Idle cash beyond ~one month of essentials, earning below inflation, is eroding.
      const idleCash = idleCashMinor(p);
      if (idleCash > 0 && cashRate < inflation) {
        score += 40;
        reasons.push(
          `idle cash above buffer at ${(cashRate * 100).toFixed(1)}% < ${(inflation * 100).toFixed(1)}% inflation — losing real value`,
        );
      }
      return { score, reasons };
    },
  },
  {
    // Research: the Ben Chat sessions flagged BNPL (Klarna / Clearpay) as the NEW
    // debt trap — structurally unlike a credit card because young people don't
    // perceive it AS debt. It feels like "paying in instalments", so it stacks
    // invisibly across retailers, missed instalments incur fees, and it increasingly
    // reports to credit files. A factual misconception (not an engagement block), so
    // it lives here. Action: treat any open BNPL as debt to clear, stop stacking,
    // see the total in one place.
    id: "bnpl-is-still-debt",
    misconception: "Buy-Now-Pay-Later (Klarna / Clearpay) isn't really debt.",
    fact:
      "BNPL is borrowing: miss an instalment and fees hit, it increasingly reports " +
      "to your credit file, and because it's spread across retailers it stacks up " +
      "invisibly. 'Paying in instalments' is still owing money.",
    action:
      "Treat every open BNPL plan as debt to clear before you save or invest, stop " +
      "opening new ones, and get all of it in one place so you can see the real total. " +
      "I'll fold it into your debt plan.",
    signal: (p, s) => {
      const reasons: string[] = [];
      let score = 0;
      // Explicit balance is the strongest signal: it's quantified debt being carried.
      if ((s.bnplBalanceMinor ?? 0) > 0) {
        score += 55;
        reasons.push("carrying a BNPL balance — it's borrowing to clear, not just instalments");
      } else if (s.usesBnpl === true) {
        score += 45;
        reasons.push("uses BNPL — it's debt that stacks invisibly across retailers");
      }
      // Reliance on informal credit is the profile-level footprint of easy-debt habits.
      if (p.reliesOnInformalCredit) {
        score += 20;
        reasons.push("relies on informal credit — easy-debt accumulation likely, BNPL included");
      }
      return { score, reasons };
    },
  },
];

/** The full catalogue of factual gaps with their corrections (no detection). */
export const KNOWLEDGE_GAP_CATALOGUE: readonly KnowledgeGap[] = SPECS.map(
  ({ signal: _signal, ...def }) => def,
);

const RELEVANCE_FLOOR = 20; // below this, the signal is too weak to surface

/**
 * Detect the factual misconceptions that are actionable for this operator. A gap
 * surfaces when its structural signal clears RELEVANCE_FLOOR — keyed off the
 * profile plus the optional caller-supplied signals. Returns the gaps sorted by
 * relevance (descending); ties break by catalogue order. Deterministic.
 */
export function detectKnowledgeGaps(
  profile: FinancialProfile,
  signals: KnowledgeSignals = {},
): DetectedKnowledgeGap[] {
  const detected: DetectedKnowledgeGap[] = [];

  for (const spec of SPECS) {
    const { signal, ...def } = spec;
    const { score, reasons } = signal(profile, signals);
    const relevance = Math.min(100, score);
    if (relevance < RELEVANCE_FLOOR) continue;
    detected.push({ ...def, relevance, evidence: reasons });
  }

  const order = new Map(SPECS.map((s, i) => [s.id, i]));
  detected.sort(
    (a, b) => b.relevance - a.relevance || order.get(a.id)! - order.get(b.id)!,
  );
  return detected;
}
