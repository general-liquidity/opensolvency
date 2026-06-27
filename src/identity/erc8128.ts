// ERC-8128 — Ethereum-wallet-signed HTTP requests. The signature base is RFC 9421
// (HTTP Message Signatures), but the signing scheme is EIP-191 / personal_sign over
// that base, recovered to an secp256k1 address. There is NO `alg` parameter: the
// verifier branches on the `keyid` prefix `erc8128:<chainId>:<0xaddress>`, and the
// expected signer IS the keyid address (no registry lookup for plain ERC-8128).
//
// AgentWorth consumes the verdict as a risk INPUT (identity attestation), exactly
// like `visaTapVerifier`. A valid recovered-address match yields `attestation:"signed"`
// (or `"registry_attested"` when `identityOf` binds the address to a principal).
//
// The secp256k1 recover + keccak hashing live behind a DYNAMIC import of the optional
// `@noble/curves` + `@noble/hashes` deps — the core gate never pulls crypto unless an
// ERC-8128 request is actually verified.

import type {
  AgentIdentity,
  IdentityResult,
  IdentityVerifier,
  SignedRequest,
} from "./verifier.ts";
import {
  buildSignatureBase,
  parseSignatureBytes,
  parseSignatureInput,
} from "./verifier.ts";

const KEYID_RE = /^erc8128:(\d+):(0x[a-fA-F0-9]{40})$/;

/** Parse an ERC-8128 keyid `erc8128:<chainId>:<0xaddress>`. Address case-insensitive. */
export function parseErc8128KeyId(
  keyid: string,
): { chainId: number; address: string } | undefined {
  const m = KEYID_RE.exec(keyid);
  if (!m) return undefined;
  return { chainId: Number(m[1]), address: m[2].toLowerCase() };
}

interface Noble {
  secp256k1: {
    sign: (
      msgHash: Uint8Array,
      privKey: Uint8Array,
    ) => { toCompactRawBytes(): Uint8Array; recovery: number };
    getPublicKey: (privKey: Uint8Array, compressed: boolean) => Uint8Array;
    Signature: {
      fromCompact(bytes: Uint8Array): {
        addRecoveryBit(bit: number): {
          recoverPublicKey(msgHash: Uint8Array): { toRawBytes(compressed: boolean): Uint8Array };
        };
      };
    };
  };
  keccak_256: (data: Uint8Array) => Uint8Array;
  bytesToHex: (b: Uint8Array) => string;
}

/** Dynamic-import the optional crypto deps; throw a clear error if absent. */
async function loadNoble(): Promise<Noble> {
  try {
    const [curves, sha3, utils] = await Promise.all([
      import("@noble/curves/secp256k1"),
      import("@noble/hashes/sha3"),
      import("@noble/hashes/utils"),
    ]);
    return {
      secp256k1: curves.secp256k1 as unknown as Noble["secp256k1"],
      keccak_256: sha3.keccak_256 as unknown as Noble["keccak_256"],
      bytesToHex: utils.bytesToHex as unknown as Noble["bytesToHex"],
    };
  } catch (err) {
    throw new Error(
      "ERC-8128 verification requires the optional dependencies @noble/curves and " +
        `@noble/hashes to be installed (${(err as Error).message})`,
    );
  }
}

/** EIP-191 / personal_sign digest of the RFC 9421 signature base string `M`:
 *   H = keccak256("\x19Ethereum Signed Message:\n" + ascii(byteLen(M)) + M). */
export async function eip191Hash(M: string): Promise<Uint8Array> {
  const { keccak_256 } = await loadNoble();
  return eip191HashWith(keccak_256, M);
}

function eip191HashWith(keccak: (d: Uint8Array) => Uint8Array, M: string): Uint8Array {
  const enc = new TextEncoder();
  const message = enc.encode(M);
  const prefix = enc.encode(`\x19Ethereum Signed Message:\n${message.length}`);
  const full = new Uint8Array(prefix.length + message.length);
  full.set(prefix);
  full.set(message, prefix.length);
  return keccak(full);
}

/** Recover the signing address from an EIP-191 signature over `M`. `sig65` is the
 * 65-byte `r(32)||s(32)||v(1)` signature (v ∈ {0,1} or {27,28}). Returns lowercase
 * `0x`-prefixed address. */
export async function recoverErc8128Address(M: string, sig65: Uint8Array): Promise<string> {
  const noble = await loadNoble();
  if (sig65.length !== 65) {
    throw new Error(`ERC-8128 signature must be 65 bytes (got ${sig65.length})`);
  }
  const H = eip191HashWith(noble.keccak_256, M);
  const rs = sig65.slice(0, 64);
  let v = sig65[64];
  if (v === 27 || v === 28) v -= 27;
  if (v !== 0 && v !== 1) throw new Error(`invalid recovery byte v=${sig65[64]}`);
  const point = noble.secp256k1.Signature.fromCompact(rs)
    .addRecoveryBit(v)
    .recoverPublicKey(H);
  const pub = point.toRawBytes(false); // 65 bytes: 0x04 || x || y
  return `0x${noble.bytesToHex(noble.keccak_256(pub.slice(1)).slice(-20))}`;
}

/** EIP-191 sign `M` with a 32-byte secp256k1 private key → 65-byte r||s||v (v ∈ {0,1}).
 * Provided so tests can round-trip; not used by the verifier. */
export async function signErc8128(M: string, privKey: Uint8Array): Promise<Uint8Array> {
  const noble = await loadNoble();
  const H = eip191HashWith(noble.keccak_256, M);
  const sig = noble.secp256k1.sign(H, privKey);
  const compact = sig.toCompactRawBytes(); // 64 bytes r||s
  const out = new Uint8Array(65);
  out.set(compact);
  out[64] = sig.recovery;
  return out;
}

export interface Erc8128Options {
  /** Clock (ms epoch). Injected for deterministic tests. Default: Date.now. */
  now?: () => number;
  /** Max age (seconds) tolerated when no `expires` is asserted. Default: 300. */
  maxAgeSeconds?: number;
  /** Clock skew (seconds) tolerated on `created`/`expires`. Default: 30. */
  toleranceSeconds?: number;
  /** Which signature label in the dictionary to verify. Default: the first. */
  label?: string;
  /** Maps a verified address to its identity (principal binding → registry_attested). */
  identityOf?: (address: string) => AgentIdentity | undefined;
  /** OPTIONAL ERC-1271 contract-signer check. When the keyid address is a smart
   * contract (no plain secp256k1 recovery), the operator injects an `eth_call`-backed
   * resolver returning whether the contract considers `sig` valid for the EIP-191
   * digest of `M`. Default off — plain ERC-8128 needs no RPC. */
  resolveContractSig?: (
    address: string,
    chainId: number,
    digest: Uint8Array,
    sig: Uint8Array,
  ) => Promise<boolean> | boolean;
}

/**
 * ERC-8128 verifier — REAL EIP-191 / secp256k1 verification over an RFC 9421 base.
 * It:
 *  1. parses `Signature-Input` (covered components + created/expires/keyid),
 *  2. requires `keyid` of the form `erc8128:<chainId>:<0xaddr>`,
 *  3. enforces the created/expires freshness window,
 *  4. reconstructs the RFC 9421 signature base over the covered components (reusing
 *     the byte-identical builder from `verifier.ts`),
 *  5. EIP-191-recovers the signing address and compares (case-insensitive) to the
 *     keyid address — only an exact match yields `verified:true`.
 * Reports `signed` (or `registry_attested` when `identityOf` binds a principal).
 */
export function erc8128Verifier(opts: Erc8128Options = {}): IdentityVerifier {
  const now = opts.now ?? Date.now;
  const maxAge = opts.maxAgeSeconds ?? 300;
  const tolerance = opts.toleranceSeconds ?? 30;

  return {
    async verify(presented: unknown): Promise<IdentityResult> {
      const unverified = (reasons: string[]): IdentityResult => ({
        verified: false,
        identity: { agentId: "unknown", attestation: "none" },
        reasons,
      });

      const req = presented as Partial<SignedRequest> | null;
      if (
        !req ||
        typeof req.signatureInput !== "string" ||
        typeof req.signature !== "string" ||
        typeof req.method !== "string"
      ) {
        return unverified(["not an ERC-8128 signed request"]);
      }
      const signed = req as SignedRequest;

      const parsed = parseSignatureInput(signed.signatureInput, opts.label);
      if (!parsed) return unverified(["malformed or missing Signature-Input"]);
      const { label, params } = parsed;

      if (!params.keyid) return unverified(["Signature-Input missing keyid"]);
      const key = parseErc8128KeyId(params.keyid);
      if (!key) {
        return unverified([`keyid "${params.keyid}" is not an erc8128:<chainId>:<0xaddr> id`]);
      }

      const nowSec = Math.floor(now() / 1000);
      if (params.created !== undefined) {
        if (nowSec + tolerance < params.created) {
          return unverified(["signature created in the future"]);
        }
        if (params.expires === undefined && nowSec - params.created > maxAge + tolerance) {
          return unverified(["signature too old (created beyond max-age)"]);
        }
      }
      if (params.expires !== undefined && nowSec - tolerance > params.expires) {
        return unverified(["signature expired"]);
      }

      const sigBytes = parseSignatureBytes(signed.signature, label);
      if (!sigBytes) return unverified([`no signature value for label "${label}"`]);

      const base = buildSignatureBase(signed, params);
      if (base === undefined) {
        return unverified(["a covered component could not be reconstructed"]);
      }

      const sig = new Uint8Array(sigBytes);
      let recovered: string | undefined;
      try {
        recovered = await recoverErc8128Address(base, sig);
      } catch (err) {
        // Recovery failed (malformed sig). Fall through to the optional ERC-1271 path.
        recovered = undefined;
        if (!opts.resolveContractSig) {
          return unverified([`EIP-191 recovery failed: ${(err as Error).message}`]);
        }
      }

      if (recovered !== undefined && recovered === key.address) {
        return bind(key.address, opts.identityOf);
      }

      if (opts.resolveContractSig) {
        const digest = await eip191Hash(base);
        const ok = await opts.resolveContractSig(key.address, key.chainId, digest, sig);
        if (ok) return bind(key.address, opts.identityOf);
        return unverified(["ERC-1271 contract signer rejected the signature"]);
      }

      return unverified([
        `recovered address ${recovered ?? "(none)"} does not match keyid address ${key.address}`,
      ]);
    },
  };
}

function bind(
  address: string,
  identityOf?: (address: string) => AgentIdentity | undefined,
): IdentityResult {
  const bound = identityOf?.(address);
  const identity: AgentIdentity = bound ?? { agentId: address, attestation: "signed" };
  return {
    verified: true,
    identity,
    reasons: ["ERC-8128 EIP-191 signature verified; recovered address matches keyid"],
  };
}
