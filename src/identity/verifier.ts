// Agent-identity layer. Both AIP (Agent Identity Protocol) and Visa Trusted Agent
// Protocol reduce to one shape: verify a presented identity artifact and return
// who the agent is, the accountable principal, and HOW STRONGLY the identity is
// attested. OpenSolvency doesn't try to be the identity issuer — it consumes
// identity as an INPUT to the gate's risk/trust (an unverified agent is higher
// risk; a registry-attested agent bound to a principal is lower). Identity never
// relaxes the floor (caps/deny-list), only informs risk.
//
// The real verifiers are operator-injected (the live part is the issuer's JWKS /
// registry + the signature check — Ed25519 for AIP, RFC 9421 for Visa TAP). This
// module is the abstraction + a static dev verifier; the AIP/Visa-TAP verifiers
// implement `IdentityVerifier` against their respective key sources.

import type { Attestation } from "../core/types.ts";

export interface AgentIdentity {
  agentId: string;
  /** The accountable human/organization the agent acts for. */
  principal?: string;
  attestation: Attestation;
  capabilities?: string[];
}

export interface IdentityResult {
  verified: boolean;
  identity: AgentIdentity;
  reasons: string[];
}

export interface IdentityVerifier {
  /** Verify a presented identity artifact (an AIP token, a Visa-TAP signed request,
   * an agent id, …). Implementations differ only in which JWKS/registry they hit. */
  verify(presented: unknown): Promise<IdentityResult> | IdentityResult;
}

/** No verifier configured → nothing is attested. */
export const noopVerifier: IdentityVerifier = {
  verify: () => ({
    verified: false,
    identity: { agentId: "unknown", attestation: "none" },
    reasons: ["no identity verifier configured"],
  }),
};

/** A known-agents registry for development/testing. A real deployment injects an
 * AIPVerifier (registry JWKS + agent-record/revocation) or a VisaTapVerifier
 * (Visa JWKS + RFC-9421 reconstruction) instead. */
export function staticIdentityVerifier(
  records: Record<string, AgentIdentity>,
): IdentityVerifier {
  return {
    verify(presented) {
      const agentId =
        typeof presented === "string"
          ? presented
          : (presented as { agentId?: string } | null)?.agentId;
      const record = agentId ? records[agentId] : undefined;
      if (record) {
        return { verified: true, identity: record, reasons: ["matched registered agent"] };
      }
      return {
        verified: false,
        identity: { agentId: agentId ?? "unknown", attestation: "none" },
        reasons: ["no matching registered agent"],
      };
    },
  };
}
