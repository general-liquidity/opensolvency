// Disclose-before-settle for AgentWorth rails. The rails settle value the gate has
// already authorized; this layer adds the OTHER half of the disclosure protocol on the
// way out: before a rail moves value to a PAYEE, the payee's signed disclosure is
// fetched, evaluated against our policy, and the live handshake is run. A payee that
// does not clear (or is unreachable) refuses the settlement before any value moves.
//
// This is the reusable guard, not the wiring. A rail adapter calls `disclosePreSettle`
// (or `requireCounterpartyDisclosure`) inside its RailClient.settle, BEFORE delegating
// to the live network call. Wiring each adapter is a follow-up; this file is what they
// will call. Fail-closed throughout, the same stance as the gate.

import {
  verifyCounterparty,
  guardSettlement,
  mutualVerify,
  type FetchLike,
  type VerificationPolicy,
  type CounterpartyVerdict,
  type MutualVerdict,
} from "@general-liquidity/agent-disclosure";

export interface RequireCounterpartyDisclosureOptions {
  fetch: FetchLike;
  payeeBaseUrl: string;
  policy: VerificationPolicy;
}

export interface DisclosureGateResult {
  allow: boolean;
  verdict: CounterpartyVerdict;
}

/**
 * Verify a payee's disclosure before value moves. Thin wrapper over the package
 * `guardSettlement`: `allow === (verdict.decision === "transact")`. Any transport,
 * parse, or handshake failure refuses — fail closed.
 */
export async function requireCounterpartyDisclosure(
  opts: RequireCounterpartyDisclosureOptions,
): Promise<DisclosureGateResult> {
  const { allow, verdict } = await guardSettlement(opts.fetch, opts.payeeBaseUrl, opts.policy);
  return { allow, verdict };
}

export interface DisclosePreSettleDeps {
  fetch: FetchLike;
  policy: VerificationPolicy;
}

export interface PreSettleDecision {
  allow: boolean;
  reason?: string;
}

/**
 * Per-rail disclose-before-settle hook. Call this from a rail adapter's settle path
 * (x402 / ACP / AP2 / UCP / Visa-TAP), passing the payee's disclosure base URL if one
 * is configured for that rail.
 *
 * - Payee exposes a disclosure URL -> verify it; allow only if it clears the policy.
 * - No disclosure URL configured -> allow with a "no disclosure endpoint" note. A rail
 *   that has not opted into disclosure is NOT blocked; opting in is incremental.
 */
export async function disclosePreSettle(
  rail: string,
  payeeBaseUrl: string | undefined,
  deps: DisclosePreSettleDeps,
): Promise<PreSettleDecision> {
  if (!payeeBaseUrl) {
    return { allow: true, reason: `rail ${rail}: no disclosure endpoint configured for payee` };
  }
  const verdict = await verifyCounterparty(deps.fetch, payeeBaseUrl, deps.policy);
  if (verdict.decision === "transact") return { allow: true };
  return { allow: false, reason: `rail ${rail}: payee disclosure refused: ${verdict.reasons.join("; ")}` };
}

export interface MutualSettleGuardOptions {
  /** how the counterparty reaches US (serves our disclosure + answers our handshake) */
  ourFetch: FetchLike;
  ourBaseUrl: string;
  /** how WE reach the counterparty */
  theirFetch: FetchLike;
  theirBaseUrl: string;
  /** what we require of them */
  ourPolicy: VerificationPolicy;
  /** what they require of us */
  theirPolicy: VerificationPolicy;
}

export interface MutualSettleResult {
  allow: boolean;
  verdict: MutualVerdict;
}

/**
 * Both sides verify each other before clearing. Wraps the package `mutualVerify`: the
 * exchange clears only if BOTH directional verdicts transact; either refusing leg
 * refuses the settlement.
 */
export async function mutualSettleGuard(opts: MutualSettleGuardOptions): Promise<MutualSettleResult> {
  const verdict = await mutualVerify({
    ourFetch: opts.ourFetch,
    ourBaseUrl: opts.ourBaseUrl,
    theirFetch: opts.theirFetch,
    theirBaseUrl: opts.theirBaseUrl,
    ourPolicy: opts.ourPolicy,
    theirPolicy: opts.theirPolicy,
  });
  return { allow: verdict.decision === "transact", verdict };
}
