// Teachable + reachable moments — the harness's core innovation. Surface guidance
// or an agent action ONLY when the operator is both receptive (a salient event
// makes the topic teachable) AND able to act now (reachable). Teachable-but-not-
// reachable is frustrating; reachable-but-not-teachable is spam. We act on both.

import type { FinancialProfile } from "./profile.ts";
import type { ResilienceAssessment } from "./resilience.ts";
import type { RailKind } from "../core/types.ts";

export type MomentEvent =
  | {
      kind: "transaction";
      amountMinor: number;
      payeeClass: string;
      rail: RailKind;
      highCostCredit?: boolean;
    }
  | { kind: "income_received"; amountMinor: number }
  | { kind: "gate_decision"; outcome: "auto_execute" | "confirm_operator" | "block" }
  | { kind: "idle_check" }; // a periodic sweep, no triggering event

export type MomentTopic =
  | "overspend"
  | "windfall_allocation"
  | "high_cost_debt"
  | "unclaimed_support"
  | "resilience_weakness";

export interface MomentContext {
  profile: FinancialProfile;
  resilience: ResilienceAssessment;
  /** Is the operator interacting right now? (reachable in the strict sense.) */
  operatorEngaged: boolean;
}

export interface Moment {
  topic: MomentTopic;
  teachable: boolean;
  reachable: boolean;
  surface: boolean; // teachable && reachable — the only time we act
  rationale: string;
  /** A move/mandate the agent could propose — still gated as usual. */
  suggestedAction: string;
}

interface Candidate {
  topic: MomentTopic;
  rationale: string;
  suggestedAction: string;
  /** Can the agent progress this autonomously (propose a mandate/move) even if
   * the operator isn't here right now? If false, it needs the operator present. */
  actionableWhenAway: boolean;
}

function candidateFor(event: MomentEvent, ctx: MomentContext): Candidate | null {
  const { profile, resilience } = ctx;

  if (event.kind === "transaction" && event.highCostCredit) {
    return {
      topic: "high_cost_debt",
      rationale: "a payment used high-cost credit (BNPL/payday/revolving)",
      suggestedAction:
        "offer a plan to clear and move off high-cost credit before it compounds",
      actionableWhenAway: false, // changing this needs the operator's go-ahead
    };
  }

  if (event.kind === "income_received") {
    return {
      topic: "windfall_allocation",
      rationale: "income just arrived — the most teachable moment to allocate it",
      suggestedAction: `propose allocating part of it toward the weakest pillar (${resilience.weakestPillar}) or the emergency buffer`,
      actionableWhenAway: true, // the agent can propose an allocation mandate now
    };
  }

  if (event.kind === "gate_decision" && event.outcome === "block") {
    return {
      topic: "overspend",
      rationale: "a payment was just blocked — the operator is here and receptive",
      suggestedAction: "explain why it was blocked and offer a within-budget alternative",
      actionableWhenAway: false,
    };
  }

  if (event.kind === "idle_check") {
    if (resilience.weakestPillar === "policy" && profile.hasUnclaimedSupport) {
      return {
        topic: "unclaimed_support",
        rationale: "the operator has support (grants/hardship/benefits) left unclaimed",
        suggestedAction: "surface the unclaimed support and offer to start a claim",
        actionableWhenAway: false,
      };
    }
    if (resilience.tier === "fragile" || resilience.tier === "stretched") {
      return {
        topic: "resilience_weakness",
        rationale: `resilience is ${resilience.tier}; weakest pillar is ${resilience.weakestPillar}`,
        suggestedAction: `propose one concrete step to strengthen ${resilience.weakestPillar}`,
        actionableWhenAway: false,
      };
    }
  }

  return null;
}

export function detectMoment(event: MomentEvent, ctx: MomentContext): Moment | null {
  const candidate = candidateFor(event, ctx);
  if (!candidate) return null;

  const teachable = true; // a candidate only exists because something made it salient
  const reachable = ctx.operatorEngaged || candidate.actionableWhenAway;

  return {
    topic: candidate.topic,
    teachable,
    reachable,
    surface: teachable && reachable,
    rationale: candidate.rationale,
    suggestedAction: candidate.suggestedAction,
  };
}
