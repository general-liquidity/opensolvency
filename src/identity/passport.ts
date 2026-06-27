// Human Passport (formerly Gitcoin Passport) — a humanity score as the gate's
// `reputationOf` input. A passport aggregates verified "stamps" into a score; AgentWorth maps
// that score to a `ReputationLevel` (good | neutral | flagged | unknown) the gate
// consumes as a network-reputation risk input (it feeds risk, never relaxes the floor).
//
// AgentWorth does not fetch the score from the kernel: the consumer injects a `PassportScorer`
// (the Passport Stamps / Models API client). The score arrives from the API as a
// numeric STRING — the consumer's scorer parses it to a number at the boundary; AgentWorth
// only consumes the numeric verdict. Without a scorer, the embedded `score` is used.

import type { ReputationLevel } from "../core/types.ts";

export interface HumanPassportAttestation {
  scheme: "HumanPassport";
  address: string; // the wallet the passport is scored for
  score?: number; // aggregate humanity score (already parsed to a number)
  threshold?: number; // the passing threshold this score was evaluated against
  passing?: boolean; // whether `score >= threshold` per the issuer
  stamps?: Record<string, { score: number; dedup: boolean; expiration_date?: string }>;
  timestamp?: string; // when the score was computed (ISO)
}

/** Fetch a live humanity score for an address. Injected because AgentWorth never opens a
 * socket from the kernel — the consumer wires the Passport Stamps / Models API and
 * parses the API's numeric-string score into a number here. */
export type PassportScorer = (
  address: string,
) => Promise<{ score: number; passing?: boolean; threshold?: number }>;

/** The default Passport Stamps passing threshold (humanity score units). */
export const HUMAN_THRESHOLD = 20;

/** Map a humanity score to a `ReputationLevel`. Undefined / NaN → `unknown` (not
 * evaluated). `>= threshold` → `good`; `>= threshold/2` → `neutral`; below → `flagged`.
 * Tune `threshold` to the score space (default is the Stamps threshold of 20; for the
 * 0–100 Models API pass `threshold = 50`). */
export function passportToReputationLevel(
  score?: number,
  threshold = HUMAN_THRESHOLD,
): ReputationLevel {
  if (score === undefined || Number.isNaN(score)) return "unknown";
  if (score >= threshold) return "good";
  if (score >= threshold * 0.5) return "neutral";
  return "flagged";
}

/** Resolve a passport to a `ReputationLevel`. An injected `scorer` does a live fetch
 * (and overrides the embedded score); without one, the attestation's embedded `score`
 * is used. `passing` reflects the issuer's verdict when available, else `score >= threshold`. */
export async function verifyPassport(
  a: HumanPassportAttestation,
  opts: { scorer?: PassportScorer } = {},
): Promise<{ level: ReputationLevel; score?: number; passing: boolean }> {
  let score = a.score;
  let threshold = a.threshold ?? HUMAN_THRESHOLD;
  let passing = a.passing;

  if (opts.scorer) {
    const res = await opts.scorer(a.address);
    score = res.score;
    if (res.threshold !== undefined) threshold = res.threshold;
    passing = res.passing;
  }

  const level = passportToReputationLevel(score, threshold);
  const isPassing =
    passing ?? (score !== undefined && !Number.isNaN(score) ? score >= threshold : false);
  return { level, score, passing: isPassing };
}

/** A `reputationOf`-shaped function the gate consumes directly: it returns the
 * resolved level for the attested address, and `"unknown"` for any other payee. The
 * level is resolved eagerly (the gate's `reputationOf` is synchronous). */
export async function passportReputationOf(
  a: HumanPassportAttestation,
  opts: { scorer?: PassportScorer } = {},
): Promise<(payee: string) => ReputationLevel> {
  const { level } = await verifyPassport(a, opts);
  const address = a.address.toLowerCase();
  return (payee: string) => (payee.toLowerCase() === address ? level : "unknown");
}
