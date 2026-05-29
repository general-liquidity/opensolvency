// Behaviour-over-knowledge — operationalised. Networth's finding: literacy isn't
// the gap; anxiety drives avoidance, and advice fails when it's a lecture at the
// wrong complexity. So the harness chooses HOW the agent communicates from the
// operator's anxiety + stage, not just WHAT it says. (Greig Dickson's "adaptive
// complexity" suggestion + the anxiety→reduce-friction finding.)

import type { FinancialProfile } from "./profile.ts";
import type { ResilienceAssessment } from "./resilience.ts";

export type CommunicationMode =
  | "reassure_first" // high anxiety: lead with reassurance, one small step
  | "plain_low_friction" // low awareness/early stage: plain language, minimal asks
  | "direct" // steady operator: concise, action-first
  | "detailed"; // secure + low anxiety: full reasoning welcome

export interface CommunicationGuidance {
  mode: CommunicationMode;
  principles: string[];
}

export function chooseCommunication(
  profile: FinancialProfile,
  resilience: ResilienceAssessment,
): CommunicationGuidance {
  if (profile.financialAnxiety === "high") {
    return {
      mode: "reassure_first",
      principles: [
        "lead with reassurance before any number",
        "propose exactly one small, reversible step",
        "never imply blame or use punitive framing",
      ],
    };
  }

  if (
    profile.financialAnxiety === "moderate" ||
    profile.stage === "early-student" ||
    !profile.entitlementsAware
  ) {
    return {
      mode: "plain_low_friction",
      principles: [
        "plain language, no jargon",
        "one decision at a time",
        "show the action, link the detail for those who want it",
      ],
    };
  }

  if (resilience.tier === "secure") {
    return {
      mode: "detailed",
      principles: [
        "concise but show the reasoning",
        "surface trade-offs and let the operator drive",
      ],
    };
  }

  return {
    mode: "direct",
    principles: ["action-first", "concise", "explain on request"],
  };
}
