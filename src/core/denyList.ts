// The hard deny-list. Ported in spirit from Gordon's trustTrajectory
// SAFETY_CRITICAL_PATTERNS: a matching rule blocks the payment unconditionally,
// before mandate evaluation and regardless of how much trust a payee has earned.
//
// Deny rules are predicates over the structured intent — never over model text —
// so a prompt-injected "ignore the deny-list" cannot reach them.

import type { DenyRule } from "./types.ts";

/** Irreversible sends to a never-before-seen payee are the classic agentic-payment
 * footgun (Aeon's distribute-tokens has no such guard). Above a hard floor we
 * refuse to auto-anything — the operator must vet the payee first. Keyed on the
 * resolved provider's reversibility, so it catches a rail-agnostic settlement
 * (e.g. MPP→stablecoin) that isn't the `onchain` kind but is still irreversible. */
const IRREVERSIBLE_UNKNOWN_FLOOR_MINOR = 50_00; // e.g. £50.00

export const DEFAULT_DENY_RULES: DenyRule[] = [
  {
    id: "irreversible_to_unknown_payee",
    reason:
      "irreversible payment to a payee with no prior history, above the hard floor",
    match: (intent, { knownPayees, reversibility }) =>
      reversibility === "irreversible" &&
      !knownPayees.has(intent.payee) &&
      intent.amount >= IRREVERSIBLE_UNKNOWN_FLOOR_MINOR,
  },
];
