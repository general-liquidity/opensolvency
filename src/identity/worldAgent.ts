// World Agent (worldcoin/agentkit) — "an agent backed by a World ID-verified human"
// as the gate's `attestation` input. The accountability flow (per the agentkit repo):
//   1. an agent WALLET is registered in the on-chain AgentBook via a World ID proof,
//      which records the registering human's nullifier under the agent address;
//   2. a server (x402) CHALLENGES the agent to sign a CAIP-122 / SIWE message;
//   3. the verifier recovers the signer (EIP-191 for `type: "eip191"`) and looks the
//      address up in AgentBook (`lookupHuman(address) -> uint256`) to confirm it is a
//      registered, human-backed agent and to recover the human nullifier.
//
// Two halves, split exactly like the World ID / SIWA paths:
//  - CORE (here, no network): structural CAIP-122 validation + EIP-191 signer recovery,
//    reusing the secp256k1 recover already in `erc8128.ts`. The signed string is the
//    canonical SIWE/CAIP-122 message the agent personal_signed (`a.message`). agentkit
//    rebuilds this from the structured fields via viem's `createSiweMessage`; AgentWorth cannot
//    pull viem into the kernel, so the consumer supplies the message that was signed.
//  - INJECTED SEAM: the AgentBook `eth_call` is an `AgentBookResolver` callback the
//    consumer wires with viem/ethers — the core never opens an RPC socket. Without a
//    resolver the result is signature-valid-only (`humanBacked: false`), never thrown.
//
// Mapping to the gate's `Attestation`: humanBacked → `registry_attested` (an issuer-
// attested human bound to the agent), valid-but-unbacked → `signed` (a verifiable
// signature, no registry binding), else → `none`. Identity feeds risk; it never
// relaxes the floor (caps / deny-list).

import type { Attestation } from "../core/types.ts";
import { recoverErc8128Address } from "./erc8128.ts";
import type { AgentIdentity, IdentityResult, IdentityVerifier } from "./verifier.ts";

export const WORLDAGENT_SCHEME = "WorldAgent";

/** agentkit's signature scheme for the EVM path (`AgentkitPayload.type`). The Solana
 * path (`ed25519`) and contract paths (`eip1271`/`eip6492`) are not recovered locally —
 * see `verifyWorldAgent`. */
export type WorldAgentSignatureType = "eip191" | "eip1271" | "ed25519";

/**
 * A World Agent attestation — the agentkit CAIP-122 / SIWE payload the agent signed,
 * plus the canonical signed `message`. Field names mirror `AgentkitPayload` from
 * `@worldcoin/agentkit` (`core/src/types.ts`): a structured SIWE object, NOT a free
 * `message`. The `message` here is the SIWE string agentkit reconstructs from these
 * fields (via viem's `createSiweMessage`) and the agent personal_signed — supplied by
 * the consumer so the AgentWorth core can recover the signer without pulling viem.
 */
export interface WorldAgentAttestation {
  scheme: "WorldAgent";
  /** the agent wallet that signed (0x…40); recovery must reproduce this */
  address: string;
  /** the canonical CAIP-122 / SIWE message string the agent personal_signed */
  message: string;
  /** hex signature (EIP-191 / personal_sign for `type: "eip191"`) */
  signature: string;
  /** CAIP-2 chain id, e.g. "eip155:480" (World Chain). agentkit's `chainId`. */
  chainId: string;
  /** agentkit `AgentkitPayload.type` — only `eip191` is recovered locally */
  type: WorldAgentSignatureType;
  /** SIWE `domain` that issued the challenge */
  domain: string;
  /** SIWE `uri` */
  uri: string;
  /** SIWE `version` (e.g. "1") */
  version: string;
  /** SIWE `nonce` (challenge anti-replay) */
  nonce: string;
  /** SIWE `issuedAt` ISO timestamp */
  issuedAt: string;
}

/**
 * Injected AgentBook resolver — wraps the on-chain `lookupHuman(address) -> uint256`
 * read (`core/src/agent-book.ts`; World Chain deployment
 * `0xA23aB2712eA7BBa896930544C7d6636a96b944dA`). The consumer wires viem/ethers
 * `eth_call`; the AgentWorth core stays RPC-free. Returns the registering human's nullifier
 * (`humanNullifier`, the hex uint256), `registered: false` when `lookupHuman` returns
 * 0, or `null` when the lookup itself could not be performed.
 */
export type AgentBookResolver = (
  address: string,
  chainId?: string,
) => Promise<{ registered: boolean; humanNullifier?: string } | null>;

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
const HEX = /^0x[0-9a-fA-F]+$/;
const CAIP2_RE = /^[-a-z0-9]{3,8}:[-_a-zA-Z0-9]{1,32}$/;

/** Structural validation only — shape + field formats, NO cryptography. A payload that
 * passes here is well-formed but still UNVERIFIED until `verifyWorldAgent` recovers the
 * signer (and, with a resolver, confirms the AgentBook registration). */
export function validateWorldAgentStructural(a: WorldAgentAttestation): boolean {
  if (a?.scheme !== WORLDAGENT_SCHEME) return false;
  if (typeof a.address !== "string" || !ADDRESS_RE.test(a.address)) return false;
  if (typeof a.message !== "string" || a.message.length === 0) return false;
  if (typeof a.signature !== "string" || !HEX.test(a.signature)) return false;
  if (typeof a.chainId !== "string" || !CAIP2_RE.test(a.chainId)) return false;
  if (a.type !== "eip191" && a.type !== "eip1271" && a.type !== "ed25519") return false;
  if (typeof a.domain !== "string" || a.domain.length === 0) return false;
  if (typeof a.uri !== "string" || a.uri.length === 0) return false;
  if (typeof a.version !== "string" || a.version.length === 0) return false;
  if (typeof a.nonce !== "string" || a.nonce.length === 0) return false;
  if (typeof a.issuedAt !== "string" || a.issuedAt.length === 0) return false;
  return true;
}

/** Map a World Agent verification to the AgentWorth `Attestation` risk input. A registered,
 * human-backed agent is an issuer-attested human bound to the agent → `registry_attested`.
 * A valid signature without an AgentBook backing is `signed`. Anything invalid is `none`. */
export function mapWorldAgentToAttestation(humanBacked: boolean, valid: boolean): Attestation {
  if (!valid) return "none";
  return humanBacked ? "registry_attested" : "signed";
}

function hexToBytes(hex: string): Uint8Array {
  const h = hex.startsWith("0x") ? hex.slice(2) : hex;
  const out = new Uint8Array(h.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(h.slice(i * 2, i * 2 + 2), 16);
  return out;
}

export interface WorldAgentResult {
  structural: boolean;
  /** the EIP-191 signature recovered to `address` (the agent proved key control) */
  valid: boolean;
  /** the agent wallet, lowercased, when recovery succeeded */
  address?: string;
  /** AgentBook confirms the address is a registered, World ID-human-backed agent */
  humanBacked: boolean;
  /** the registering human's nullifier from AgentBook (when humanBacked) */
  nullifier?: string;
  reason?: string;
}

/**
 * Verify a World Agent attestation. CORE (no network):
 *  1. structural CAIP-122 / SIWE validation,
 *  2. for `type: "eip191"`, EIP-191-recover the signer from `message` and require it
 *     == `address` (reusing the `erc8128.ts` secp256k1 recover). Contract signatures
 *     (`eip1271`) and Solana (`ed25519`) are not recovered locally — reported
 *     structural-only unless a resolver still confirms the AgentBook registration.
 *  3. with an injected `resolver`, look the address up in AgentBook → `humanBacked` +
 *     the human `nullifier`. Without a resolver the result is signature-valid-only
 *     (`humanBacked: false`). Never throws on a malformed input — returns a reason.
 */
export async function verifyWorldAgent(
  a: WorldAgentAttestation,
  opts: { resolver?: AgentBookResolver } = {},
): Promise<WorldAgentResult> {
  const structural = validateWorldAgentStructural(a);
  if (!structural) {
    return { structural: false, valid: false, humanBacked: false, reason: "malformed World Agent attestation" };
  }

  const expected = a.address.toLowerCase();
  let valid = false;
  let reason: string | undefined;

  if (a.type === "eip191") {
    try {
      const recovered = await recoverErc8128Address(a.message, hexToBytes(a.signature));
      if (recovered === expected) {
        valid = true;
      } else {
        reason = `recovered signer ${recovered} does not match agent address ${expected}`;
      }
    } catch (err) {
      reason = `EIP-191 recovery failed: ${(err as Error).message}`;
    }
  } else {
    // eip1271 (contract) / ed25519 (Solana) — not recovered in the AgentWorth core. The
    // AgentBook registration (below) can still establish human-backing.
    reason = `signature type "${a.type}" is not recovered locally (eip191 only)`;
  }

  if (!opts.resolver) {
    return {
      structural: true,
      valid,
      address: valid ? expected : undefined,
      humanBacked: false,
      reason: reason ?? "no AgentBook resolver configured (signature-valid-only)",
    };
  }

  const book = await opts.resolver(expected, a.chainId);
  const humanBacked = book?.registered === true;
  return {
    structural: true,
    valid,
    address: valid ? expected : undefined,
    humanBacked,
    nullifier: humanBacked ? book?.humanNullifier : undefined,
    reason: humanBacked
      ? reason
      : reason ?? "AgentBook has no human-backed registration for this agent",
  };
}

/** Adapt World Agent to the `IdentityVerifier` shape. The presented artifact is a
 * `WorldAgentAttestation`. The `agentId` is the registering human's nullifier when the
 * agent is human-backed (the accountable principal); otherwise the agent address. The
 * attestation follows `mapWorldAgentToAttestation`. `verified` requires a valid
 * signature (key control); human-backing additionally lifts it to `registry_attested`. */
export function worldAgentIdentityVerifier(
  opts: { resolver?: AgentBookResolver } = {},
): IdentityVerifier {
  return {
    async verify(presented: unknown): Promise<IdentityResult> {
      const a = presented as WorldAgentAttestation | null;
      if (a?.scheme !== WORLDAGENT_SCHEME) {
        return {
          verified: false,
          identity: { agentId: "unknown", attestation: "none" },
          reasons: ["not a World Agent artifact"],
        };
      }
      const res = await verifyWorldAgent(a, opts);
      const attestation = mapWorldAgentToAttestation(res.humanBacked, res.valid);
      const identity: AgentIdentity = {
        agentId: res.humanBacked && res.nullifier ? res.nullifier : (res.address ?? a.address),
        principal: res.humanBacked ? res.nullifier : undefined,
        attestation,
      };
      return {
        verified: res.valid,
        identity,
        reasons: [
          res.reason ??
            `World Agent verified (${res.humanBacked ? "human-backed" : "signature-only"} → ${attestation})`,
        ],
      };
    },
  };
}
