// SIWA — Sign-In-With-Agent. A SIWE-style plaintext message (NOT a JWT), EIP-191
// signed by the agent's wallet. Verification recovers the signer and compares it to
// the asserted `address`; an injected ERC-8004 `ownerOf` resolver then distinguishes
// `signed` (signature valid, no registry binding) from `registry_attested` (the agent
// registry's owner of `agentId` IS the signer).
//
// OpenSolvency consumes the verdict as a risk INPUT (identity attestation). The
// registry call is injected/mocked — OS never opens a socket from the kernel.

import type { Attestation } from "../core/types.ts";
import type { AgentIdentity, IdentityResult, IdentityVerifier } from "./verifier.ts";
import { recoverErc8128Address } from "./erc8128.ts";

export interface SiwaMessage {
  domain: string;
  address: string; // EIP-55 checksummed address the message claims to be signed by
  uri: string;
  version: "1";
  agentId: string; // ERC-721 token id in the agent registry
  agentRegistry: string; // CAIP-10 `eip155:<chainId>:<registry>`
  chainId: number;
  nonce: string; // ≥8 alphanumeric chars
  issuedAt: string; // RFC3339
  expirationTime?: string; // RFC3339
  notBefore?: string; // RFC3339
  requestId?: string;
  statement?: string;
}

/** Serialize a SIWA message to its exact signing text (the bytes that get EIP-191
 * signed). The optional lines appear only when present, in spec order. */
export function formatSiwaMessage(m: SiwaMessage): string {
  const lines: string[] = [];
  lines.push(`${m.domain} wants you to sign in with your Agent account:`);
  lines.push(m.address);
  lines.push("");
  if (m.statement !== undefined) {
    lines.push(m.statement);
    lines.push("");
  }
  lines.push(`URI: ${m.uri}`);
  lines.push("Version: 1");
  lines.push(`Agent ID: ${m.agentId}`);
  lines.push(`Agent Registry: ${m.agentRegistry}`);
  lines.push(`Chain ID: ${m.chainId}`);
  lines.push(`Nonce: ${m.nonce}`);
  lines.push(`Issued At: ${m.issuedAt}`);
  if (m.expirationTime !== undefined) lines.push(`Expiration Time: ${m.expirationTime}`);
  if (m.notBefore !== undefined) lines.push(`Not Before: ${m.notBefore}`);
  if (m.requestId !== undefined) lines.push(`Request ID: ${m.requestId}`);
  return lines.join("\n");
}

/** Parse a SIWA signing text back into a structured message. Throws on a missing
 * required field — the message a verifier was handed must be well-formed. */
export function parseSiwaMessage(text: string): SiwaMessage {
  const lines = text.split("\n");
  const header = lines[0] ?? "";
  const hm = /^(.*) wants you to sign in with your Agent account:$/.exec(header);
  if (!hm) throw new Error("SIWA: malformed header line");
  const domain = hm[1];
  const address = lines[1] ?? "";
  if (!address) throw new Error("SIWA: missing address line");

  const field = (key: string): string | undefined => {
    const prefix = `${key}: `;
    for (const line of lines) {
      if (line.startsWith(prefix)) return line.slice(prefix.length);
    }
    return undefined;
  };

  // The statement is the block between the blank line after the address and the
  // blank line before `URI:`. Lines 2 (blank) onward up to the next blank line.
  let statement: string | undefined;
  if (lines[3] !== undefined && !lines[3].startsWith("URI: ")) {
    statement = lines[3];
  }

  const uri = field("URI");
  const agentId = field("Agent ID");
  const agentRegistry = field("Agent Registry");
  const chainIdStr = field("Chain ID");
  const nonce = field("Nonce");
  const issuedAt = field("Issued At");
  if (!uri || !agentId || !agentRegistry || !chainIdStr || !nonce || !issuedAt) {
    throw new Error("SIWA: missing one or more required fields");
  }

  return {
    domain,
    address,
    uri,
    version: "1",
    agentId,
    agentRegistry,
    chainId: Number(chainIdStr),
    nonce,
    issuedAt,
    expirationTime: field("Expiration Time"),
    notBefore: field("Not Before"),
    requestId: field("Request ID"),
    statement,
  };
}

/** Resolves an ERC-8004 agent registry entry: who OWNS `agentId` (and optional
 * metadata). Injected so OS never hits the chain from the kernel. */
export type RegistryResolver = (
  agentRegistry: string,
  agentId: string,
) => Promise<{
  owner: string;
  active?: boolean;
  services?: string[];
  score?: number;
} | null>;

export interface VerifySiwaOptions {
  expectedDomain: string;
  nonceValid: (nonce: string) => boolean;
  /** Clock (ms epoch). Injected for deterministic tests. Default: Date.now. */
  now?: () => number;
  /** EIP-191 recover over the SIWA message text. Default: secp256k1 personal_sign. */
  recoverSigner?: (message: SiwaMessage, signature: Uint8Array) => Promise<string>;
  /** ERC-8004 `ownerOf` resolver → `registry_attested` when owner == signer. */
  resolveRegistry?: RegistryResolver;
}

/** Verify a SIWA message + signature. Returns the verdict + the agent identity at
 * the strongest attestation supported by the inputs:
 *   signer != address              → unverified (none)
 *   signer == address, no resolver → signed
 *   resolver owner == signer       → registry_attested
 * `signature` is the 65-byte r||s||v EIP-191 signature. */
export async function verifySiwa(
  msg: SiwaMessage,
  signature: Uint8Array,
  opts: VerifySiwaOptions,
): Promise<{ verified: boolean; identity: AgentIdentity; reasons: string[] }> {
  const now = opts.now ?? Date.now;
  const unverified = (reasons: string[]) => ({
    verified: false,
    identity: { agentId: "unknown", attestation: "none" as Attestation },
    reasons,
  });

  if (msg.domain !== opts.expectedDomain) {
    return unverified([`domain "${msg.domain}" != expected "${opts.expectedDomain}"`]);
  }
  if (!opts.nonceValid(msg.nonce)) {
    return unverified([`nonce "${msg.nonce}" not valid/known`]);
  }

  const nowMs = now();
  if (msg.expirationTime !== undefined) {
    const exp = Date.parse(msg.expirationTime);
    if (!Number.isNaN(exp) && nowMs > exp) return unverified(["SIWA message expired"]);
  }
  if (msg.notBefore !== undefined) {
    const nbf = Date.parse(msg.notBefore);
    if (!Number.isNaN(nbf) && nowMs < nbf) return unverified(["SIWA message not yet valid"]);
  }

  const recover =
    opts.recoverSigner ??
    ((m: SiwaMessage, sig: Uint8Array) => recoverErc8128Address(formatSiwaMessage(m), sig));

  let signer: string;
  try {
    signer = (await recover(msg, signature)).toLowerCase();
  } catch (err) {
    return unverified([`EIP-191 recovery failed: ${(err as Error).message}`]);
  }

  if (signer !== msg.address.toLowerCase()) {
    return unverified([`recovered signer ${signer} != asserted address ${msg.address}`]);
  }

  const base: AgentIdentity = {
    agentId: msg.agentId,
    principal: msg.address,
    attestation: "signed",
  };

  if (opts.resolveRegistry) {
    const entry = await opts.resolveRegistry(msg.agentRegistry, msg.agentId);
    if (entry && entry.owner.toLowerCase() === signer) {
      return {
        verified: true,
        identity: {
          ...base,
          principal: entry.owner,
          attestation: "registry_attested",
          capabilities: entry.services,
        },
        reasons: ["SIWA signature verified; agent registry owner matches signer"],
      };
    }
    if (entry) {
      return {
        verified: true,
        identity: base,
        reasons: [
          "SIWA signature verified; registry owner does not match signer (signed only)",
        ],
      };
    }
  }

  return {
    verified: true,
    identity: base,
    reasons: ["SIWA signature verified (no registry binding → signed)"],
  };
}

/** Adapt `verifySiwa` to the `IdentityVerifier` shape. The presented artifact is
 * `{ message: SiwaMessage | string; signature: Uint8Array }`. */
export function siwaIdentityVerifier(opts: VerifySiwaOptions): IdentityVerifier {
  return {
    async verify(presented: unknown): Promise<IdentityResult> {
      const p = presented as { message?: SiwaMessage | string; signature?: Uint8Array } | null;
      if (!p || p.message === undefined || !(p.signature instanceof Uint8Array)) {
        return {
          verified: false,
          identity: { agentId: "unknown", attestation: "none" },
          reasons: ["not a SIWA artifact ({ message, signature })"],
        };
      }
      const msg = typeof p.message === "string" ? parseSiwaMessage(p.message) : p.message;
      return verifySiwa(msg, p.signature, opts);
    },
  };
}

// --- OS Self risk-input -------------------------------------------------------

/** Map a *verified* Self proof verdict to the OS `Attestation` risk input. OS does
 * NOT verify the Self proof here — full proof verification is delegated to ADP / the
 * Self SDK; OS only consumes the boolean verdict. `registryBacked` lifts a valid
 * proof to `registry_attested` (an issuer-attested identity bound to a registry). */
export function mapSelfToAttestation(verdict: {
  valid: boolean;
  registryBacked?: boolean;
}): Attestation {
  if (verdict.valid && verdict.registryBacked) return "registry_attested";
  if (verdict.valid) return "signed";
  return "none";
}
