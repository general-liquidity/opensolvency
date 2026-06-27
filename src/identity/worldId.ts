// World ID — proof-of-personhood as the gate's `attestation` input. A World ID
// proof is a Groth16 ZK proof over the on-chain Orb set; AgentWorth CANNOT verify
// it locally (no trusted setup, no Merkle membership in the kernel). So, like the
// Self/SIWA path, AgentWorth consumes the verdict of an INJECTED verifier — the consumer
// wires the Worldcoin cloud `/verify` endpoint or the on-chain Router `verifyProof`.
// Without that verifier the result is structural-only (`verified: false`,
// attestation "none") — never thrown.
//
// The `nullifier_hash` is the per-(human, action) sybil key: one human can produce
// at most one distinct nullifier for a given `(app_id, action)`, so it doubles as a
// stable, privacy-preserving `agentId`. A verified orb proof is an issuer-attested
// human → `registry_attested`; a device proof is a weaker (signed) attestation.

import type { Attestation } from "../core/types.ts";
import type { AgentIdentity, IdentityResult, IdentityVerifier } from "./verifier.ts";

export type WorldIdVerificationLevel = "orb" | "device" | "secure_document" | "document";

const VERIFICATION_LEVELS: readonly WorldIdVerificationLevel[] = [
  "orb",
  "device",
  "secure_document",
  "document",
];

export interface WorldIdAttestation {
  scheme: "WorldID";
  app_id: string; // Developer Portal app id, `app_<...>`
  action: string; // the action being verified (sybil scope)
  signal?: string; // optional signal bound into the proof
  nullifier_hash: string; // per-(human, action) sybil key, 0x-hex
  merkle_root: string; // the identity-set root the proof was made against, 0x-hex
  proof: string; // the zero-knowledge proof, 0x-hex
  verification_level: WorldIdVerificationLevel;
}

/** Verify a World ID proof. Injected because local ZK verification is impossible —
 * the consumer wires the cloud `/verify` endpoint or the on-chain Router
 * `verifyProof`. Returns `valid` and (optionally) the canonical `nullifier`. */
export type WorldIdVerifier = (
  a: WorldIdAttestation,
) => Promise<{ valid: boolean; nullifier?: string }>;

const HEX = /^0x[0-9a-fA-F]+$/;

/** Structural validation only — shape + field formats, NO cryptography. A proof
 * that passes here is well-formed but still UNVERIFIED until an injected
 * `WorldIdVerifier` confirms it. */
export function validateWorldIdStructural(a: WorldIdAttestation): boolean {
  if (a?.scheme !== "WorldID") return false;
  if (typeof a.app_id !== "string" || !a.app_id.startsWith("app_")) return false;
  if (typeof a.action !== "string" || a.action.length === 0) return false;
  if (a.signal !== undefined && typeof a.signal !== "string") return false;
  if (typeof a.nullifier_hash !== "string" || !HEX.test(a.nullifier_hash)) return false;
  if (typeof a.merkle_root !== "string" || !HEX.test(a.merkle_root)) return false;
  if (typeof a.proof !== "string" || !HEX.test(a.proof)) return false;
  if (!VERIFICATION_LEVELS.includes(a.verification_level)) return false;
  return true;
}

/** Map a *verified* World ID proof to the AgentWorth `Attestation` risk input. An invalid
 * proof is `none`. A valid orb proof is an issuer-attested human → `registry_attested`;
 * any other valid level (device, document) is the weaker `signed`. */
export function mapWorldIdToAttestation(
  level: WorldIdVerificationLevel,
  valid: boolean,
): Attestation {
  if (!valid) return "none";
  return level === "orb" ? "registry_attested" : "signed";
}

/** Verify a World ID proof: structural check, then the injected verifier. Without a
 * verifier the result is structural-only (`valid: false`) — AgentWorth can never assert a
 * cryptographic verdict it didn't perform. The returned `nullifier` is the canonical
 * one from the verifier when present, else the asserted `nullifier_hash`. */
export async function verifyWorldId(
  a: WorldIdAttestation,
  opts: { verifier?: WorldIdVerifier } = {},
): Promise<{ structural: boolean; valid: boolean; nullifier?: string; reason?: string }> {
  const structural = validateWorldIdStructural(a);
  if (!structural) {
    return { structural: false, valid: false, reason: "malformed World ID proof" };
  }
  if (!opts.verifier) {
    return {
      structural: true,
      valid: false,
      nullifier: a.nullifier_hash,
      reason: "no World ID verifier configured (structural-only; local ZK verify impossible)",
    };
  }
  const res = await opts.verifier(a);
  return {
    structural: true,
    valid: res.valid,
    nullifier: res.nullifier ?? a.nullifier_hash,
    reason: res.valid ? undefined : "World ID verifier rejected the proof",
  };
}

/** Adapt World ID to the `IdentityVerifier` shape. The presented artifact is a
 * `WorldIdAttestation`. The `agentId` is the `nullifier_hash` (the per-(human, action)
 * sybil key); the attestation follows `mapWorldIdToAttestation`. */
export function worldIdIdentityVerifier(opts: {
  verifier?: WorldIdVerifier;
} = {}): IdentityVerifier {
  return {
    async verify(presented: unknown): Promise<IdentityResult> {
      const a = presented as WorldIdAttestation | null;
      if (a?.scheme !== "WorldID") {
        return {
          verified: false,
          identity: { agentId: "unknown", attestation: "none" },
          reasons: ["not a World ID artifact"],
        };
      }
      const res = await verifyWorldId(a, opts);
      const attestation = mapWorldIdToAttestation(a.verification_level, res.valid);
      const identity: AgentIdentity = {
        agentId: res.nullifier ?? a.nullifier_hash,
        attestation,
      };
      return {
        verified: res.valid,
        identity,
        reasons: [
          res.reason ??
            `World ID proof verified (${a.verification_level} → ${attestation})`,
        ],
      };
    },
  };
}
