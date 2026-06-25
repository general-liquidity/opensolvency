// ERC-7710 delegated-permissions interop.
//
// Expresses an OpenSolvency `Mandate` as a MetaMask-delegation-framework
// `Delegation` + `Caveat[]`, computes the EIP-712 delegation hash, and signs /
// verifies it (ECDSA secp256k1, EOA only).
//
// A mandate is OS's OFF-CHAIN authority object. ERC-7710 is the *enforcement*
// of permission bounds on-chain via caveat enforcers; this module is the bridge.
// Pure mapping/encoding functions use NO crypto. The hash/sign/verify functions
// dynamically import @noble/* (optionalDependencies) so the core gate never
// pulls a crypto dependency.

import type { Mandate, Period } from "../core/types.ts";

/** A 0x-prefixed hex string. */
export type Hex = `0x${string}`;

/** ERC-7710 / MetaMask delegation-framework caveat. `args` is excluded from the signed hash. */
export interface Caveat {
  enforcer: Hex;
  terms: Hex;
  args: Hex;
}

/** ERC-7710 / MetaMask delegation-framework delegation. */
export interface Delegation {
  delegate: Hex;
  delegator: Hex;
  /** ROOT_AUTHORITY for a root grant, else the parent delegation hash. */
  authority: Hex;
  caveats: Caveat[];
  salt: bigint;
  signature: Hex;
}

/** EIP-712 domain for the DelegationManager. */
export interface Eip712Domain {
  /** Defaults to "DelegationManager" if omitted by `domainSeparator`. */
  name?: string;
  /** Defaults to "1" if omitted. */
  version?: string;
  chainId: number | bigint;
  verifyingContract: Hex;
}

/**
 * Caller-supplied enforcer contract addresses for their target deployment.
 * Enforcer addresses are chain/deployment-specific, so they are injected — the
 * mapping never hardcodes a deployment.
 */
export interface EnforcerAddresses {
  timestamp: Hex;
  nativeTokenTransferAmount?: Hex;
  erc20TransferAmount?: Hex;
  erc20PeriodTransfer?: Hex;
  nativeTokenPeriodTransfer?: Hex;
  allowedTargets?: Hex;
}

/** Root authority sentinel (0xff…ff, 32 bytes). */
export const ROOT_AUTHORITY: Hex = `0x${"ff".repeat(32)}`;

/** "Any delegate" sentinel address (0x…a11). */
export const ANY_DELEGATE: Hex = "0x0000000000000000000000000000000000000a11";

/** Empty caveat args (no args). */
const EMPTY_ARGS: Hex = "0x";

export const DELEGATION_TYPE_STRING =
  "Delegation(address delegate,address delegator,bytes32 authority,Caveat[] caveats,uint256 salt)Caveat(address enforcer,bytes terms)";

export const CAVEAT_TYPE_STRING = "Caveat(address enforcer,bytes terms)";

const EIP712_DOMAIN_TYPE_STRING =
  "EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)";

/** Seconds in each mandate period. */
export const PERIOD_SECONDS: Record<Period, number> = {
  day: 86400,
  week: 604800,
  month: 2592000,
};

// ---------------------------------------------------------------------------
// Byte / hex helpers (pure, no crypto)
// ---------------------------------------------------------------------------

export function hexToBytes(hex: string): Uint8Array {
  let h = hex.startsWith("0x") ? hex.slice(2) : hex;
  if (h.length % 2 !== 0) h = `0${h}`;
  const out = new Uint8Array(h.length / 2);
  for (let i = 0; i < out.length; i++) {
    const byte = Number.parseInt(h.slice(i * 2, i * 2 + 2), 16);
    if (Number.isNaN(byte)) throw new Error(`invalid hex: ${hex}`);
    out[i] = byte;
  }
  return out;
}

export function bytesToHex(bytes: Uint8Array): Hex {
  let s = "";
  for (const b of bytes) s += b.toString(16).padStart(2, "0");
  return `0x${s}`;
}

export function concatBytes(...arrays: Uint8Array[]): Uint8Array {
  let total = 0;
  for (const a of arrays) total += a.length;
  const out = new Uint8Array(total);
  let off = 0;
  for (const a of arrays) {
    out.set(a, off);
    off += a.length;
  }
  return out;
}

/** Left-pad a value to a 32-byte ABI word. Accepts a 0x-address/bytes32 hex or a bigint/number. */
export function abiWord(value: Hex | bigint | number): Uint8Array {
  let bytes: Uint8Array;
  if (typeof value === "bigint" || typeof value === "number") {
    const v = BigInt(value);
    if (v < 0n) throw new Error("abiWord: negative values not supported");
    let h = v.toString(16);
    if (h.length % 2 !== 0) h = `0${h}`;
    bytes = v === 0n ? new Uint8Array(0) : hexToBytes(h);
  } else {
    bytes = hexToBytes(value);
  }
  if (bytes.length > 32) throw new Error("abiWord: value exceeds 32 bytes");
  const out = new Uint8Array(32);
  out.set(bytes, 32 - bytes.length);
  return out;
}

function bigintToBytes32(v: bigint): Uint8Array {
  return abiWord(v);
}

function normalizeAddress(addr: string): Hex {
  const bytes = hexToBytes(addr);
  if (bytes.length !== 20) throw new Error(`invalid address (expected 20 bytes): ${addr}`);
  return bytesToHex(bytes);
}

// ---------------------------------------------------------------------------
// Enforcer `terms` encoders (pure, no crypto)
// ---------------------------------------------------------------------------

/**
 * TimestampEnforcer terms: 32 bytes = uint128 afterThreshold ‖ uint128 beforeThreshold
 * (both non-inclusive). A mandate expiry maps to `beforeThreshold`.
 */
export function encodeTimestampTerms(beforeUnix: number, afterUnix = 0): Uint8Array {
  if (!Number.isInteger(beforeUnix) || beforeUnix < 0)
    throw new Error("encodeTimestampTerms: beforeUnix must be a non-negative integer");
  if (!Number.isInteger(afterUnix) || afterUnix < 0)
    throw new Error("encodeTimestampTerms: afterUnix must be a non-negative integer");
  const out = new Uint8Array(32);
  // uint128 each: low 16 bytes hold the value, written into [0:16] and [16:32].
  out.set(abiWord(BigInt(afterUnix)).slice(16), 0);
  out.set(abiWord(BigInt(beforeUnix)).slice(16), 16);
  return out;
}

/** NativeTokenTransferAmountEnforcer terms: abi.encode(uint256 allowance) → 32 bytes. */
export function encodeNativeAmountTerms(allowance: bigint): Uint8Array {
  if (allowance < 0n) throw new Error("encodeNativeAmountTerms: allowance must be >= 0");
  return bigintToBytes32(allowance);
}

/** ERC20TransferAmountEnforcer terms: address token (32-padded) ‖ uint256 allowance (64 bytes). */
export function encodeErc20AmountTerms(token: Hex, allowance: bigint): Uint8Array {
  if (allowance < 0n) throw new Error("encodeErc20AmountTerms: allowance must be >= 0");
  return concatBytes(abiWord(normalizeAddress(token)), bigintToBytes32(allowance));
}

/**
 * ERC20PeriodTransferEnforcer terms: 116 bytes packed —
 * address token (0:20) ‖ uint256 periodAmount (20:52) ‖ uint256 periodDuration (52:84) ‖ uint256 startDate (84:116).
 */
export function encodePeriodTerms(
  token: Hex,
  periodAmount: bigint,
  periodDuration: number,
  startDate: number,
): Uint8Array {
  if (periodAmount < 0n) throw new Error("encodePeriodTerms: periodAmount must be >= 0");
  if (!Number.isInteger(periodDuration) || periodDuration <= 0)
    throw new Error("encodePeriodTerms: periodDuration must be a positive integer");
  if (!Number.isInteger(startDate) || startDate < 0)
    throw new Error("encodePeriodTerms: startDate must be a non-negative integer");
  return concatBytes(
    hexToBytes(normalizeAddress(token)),
    bigintToBytes32(periodAmount),
    bigintToBytes32(BigInt(periodDuration)),
    bigintToBytes32(BigInt(startDate)),
  );
}

/**
 * NativeTokenPeriodTransferEnforcer terms: 96 bytes packed —
 * uint256 periodAmount (0:32) ‖ uint256 periodDuration (32:64) ‖ uint256 startDate (64:96).
 */
export function encodeNativePeriodTerms(
  periodAmount: bigint,
  periodDuration: number,
  startDate: number,
): Uint8Array {
  if (periodAmount < 0n) throw new Error("encodeNativePeriodTerms: periodAmount must be >= 0");
  if (!Number.isInteger(periodDuration) || periodDuration <= 0)
    throw new Error("encodeNativePeriodTerms: periodDuration must be a positive integer");
  if (!Number.isInteger(startDate) || startDate < 0)
    throw new Error("encodeNativePeriodTerms: startDate must be a non-negative integer");
  return concatBytes(
    bigintToBytes32(periodAmount),
    bigintToBytes32(BigInt(periodDuration)),
    bigintToBytes32(BigInt(startDate)),
  );
}

/** AllowedTargetsEnforcer terms: packed 20-byte addresses (len % 20 == 0 && len != 0). */
export function encodeAllowedTargetsTerms(addresses: Hex[]): Uint8Array {
  if (addresses.length === 0)
    throw new Error("encodeAllowedTargetsTerms: at least one target required");
  return concatBytes(...addresses.map((a) => hexToBytes(normalizeAddress(a))));
}

// ---------------------------------------------------------------------------
// Mandate → Delegation mapping (pure, no crypto)
// ---------------------------------------------------------------------------

export interface MandateToDelegationOpts {
  delegate: Hex;
  delegator: Hex;
  enforcers: EnforcerAddresses;
  /** ERC-20 token address. When present, transfer caps use the ERC-20 enforcers; else native. */
  token?: Hex;
  /** Delegation salt; defaults to a deterministic value derived from the mandate id. */
  salt?: bigint;
  /** Override the period→seconds mapping (e.g. a venue with a non-standard month). */
  periodSecondsOverride?: number;
}

/** Deterministic salt from a mandate id (FNV-1a 64-bit; no crypto needed). */
export function deterministicSalt(id: string): bigint {
  let hash = 0xcbf29ce484222325n;
  const prime = 0x100000001b3n;
  const mask = (1n << 64n) - 1n;
  for (let i = 0; i < id.length; i++) {
    hash ^= BigInt(id.charCodeAt(i));
    hash = (hash * prime) & mask;
  }
  return hash;
}

/**
 * Build an ERC-7710 root delegation from an OpenSolvency mandate.
 *
 * Caveats:
 *  - expiresAt → TimestampEnforcer (beforeThreshold).
 *  - perTxCap  → ERC20/Native TransferAmountEnforcer.
 *  - perPeriodCap + period + grantedAt → ERC20/Native PeriodTransferEnforcer.
 *  - scope.kind === "allowlist" → AllowedTargetsEnforcer (values MUST be 0x addresses).
 *  - allowedRails has no enforcer (off-chain only).
 *
 * Returns an unsigned delegation (`signature: "0x"`, `authority: ROOT_AUTHORITY`).
 */
export function mandateToDelegation(m: Mandate, opts: MandateToDelegationOpts): Delegation {
  const { delegate, delegator, enforcers, token } = opts;
  const caveats: Caveat[] = [];

  // expiresAt → TimestampEnforcer
  const beforeUnix = Math.floor(new Date(m.expiresAt).getTime() / 1000);
  if (!Number.isFinite(beforeUnix))
    throw new Error(`mandate expiresAt is not a valid date: ${m.expiresAt}`);
  caveats.push({
    enforcer: normalizeAddress(enforcers.timestamp),
    terms: bytesToHex(encodeTimestampTerms(beforeUnix)),
    args: EMPTY_ARGS,
  });

  // perTxCap → TransferAmountEnforcer
  if (token) {
    if (!enforcers.erc20TransferAmount)
      throw new Error("mandateToDelegation: token set but erc20TransferAmount enforcer missing");
    caveats.push({
      enforcer: normalizeAddress(enforcers.erc20TransferAmount),
      terms: bytesToHex(encodeErc20AmountTerms(token, BigInt(m.perTxCap))),
      args: EMPTY_ARGS,
    });
  } else {
    if (!enforcers.nativeTokenTransferAmount)
      throw new Error(
        "mandateToDelegation: no token and nativeTokenTransferAmount enforcer missing",
      );
    caveats.push({
      enforcer: normalizeAddress(enforcers.nativeTokenTransferAmount),
      terms: bytesToHex(encodeNativeAmountTerms(BigInt(m.perTxCap))),
      args: EMPTY_ARGS,
    });
  }

  // perPeriodCap + period + grantedAt → PeriodTransferEnforcer
  const periodDuration = opts.periodSecondsOverride ?? PERIOD_SECONDS[m.period];
  const startDate = Math.floor(new Date(m.grantedAt).getTime() / 1000);
  if (!Number.isFinite(startDate))
    throw new Error(`mandate grantedAt is not a valid date: ${m.grantedAt}`);
  if (token) {
    if (!enforcers.erc20PeriodTransfer)
      throw new Error("mandateToDelegation: token set but erc20PeriodTransfer enforcer missing");
    caveats.push({
      enforcer: normalizeAddress(enforcers.erc20PeriodTransfer),
      terms: bytesToHex(
        encodePeriodTerms(token, BigInt(m.perPeriodCap), periodDuration, startDate),
      ),
      args: EMPTY_ARGS,
    });
  } else {
    if (!enforcers.nativeTokenPeriodTransfer)
      throw new Error(
        "mandateToDelegation: no token and nativeTokenPeriodTransfer enforcer missing",
      );
    caveats.push({
      enforcer: normalizeAddress(enforcers.nativeTokenPeriodTransfer),
      terms: bytesToHex(encodeNativePeriodTerms(BigInt(m.perPeriodCap), periodDuration, startDate)),
      args: EMPTY_ARGS,
    });
  }

  // scope allowlist → AllowedTargetsEnforcer
  if (m.scope.kind === "allowlist") {
    if (!enforcers.allowedTargets)
      throw new Error("mandateToDelegation: allowlist scope but allowedTargets enforcer missing");
    caveats.push({
      enforcer: normalizeAddress(enforcers.allowedTargets),
      terms: bytesToHex(encodeAllowedTargetsTerms(m.scope.values as Hex[])),
      args: EMPTY_ARGS,
    });
  }

  return {
    delegate: normalizeAddress(delegate),
    delegator: normalizeAddress(delegator),
    authority: ROOT_AUTHORITY,
    caveats,
    salt: opts.salt ?? deterministicSalt(m.id),
    signature: "0x",
  };
}

// ---------------------------------------------------------------------------
// EIP-712 hashing / signing / verification (dynamic crypto import)
// ---------------------------------------------------------------------------

async function loadCrypto(): Promise<{
  keccak: (b: Uint8Array) => Uint8Array;
  secp: typeof import("@noble/curves/secp256k1").secp256k1;
}> {
  let keccakMod: typeof import("@noble/hashes/sha3");
  let curvesMod: typeof import("@noble/curves/secp256k1");
  try {
    keccakMod = await import("@noble/hashes/sha3");
    curvesMod = await import("@noble/curves/secp256k1");
  } catch {
    throw new Error(
      "ERC-7710 crypto requires the optional dependencies @noble/hashes and @noble/curves. Install them: npm i @noble/hashes @noble/curves",
    );
  }
  return { keccak: keccakMod.keccak_256, secp: curvesMod.secp256k1 };
}

/** keccak256 of bytes, async (uses the optional @noble/hashes dep). */
async function keccak256(bytes: Uint8Array): Promise<Uint8Array> {
  const { keccak } = await loadCrypto();
  return keccak(bytes);
}

function keccakSync(keccak: (b: Uint8Array) => Uint8Array, bytes: Uint8Array): Uint8Array {
  return keccak(bytes);
}

/**
 * Build the EIP-712 domain separator. Defaults name="DelegationManager", version="1".
 */
export async function domainSeparator(domain: Eip712Domain): Promise<Hex> {
  const { keccak } = await loadCrypto();
  const name = domain.name ?? "DelegationManager";
  const version = domain.version ?? "1";
  const typeHash = keccakSync(keccak, new TextEncoder().encode(EIP712_DOMAIN_TYPE_STRING));
  const nameHash = keccakSync(keccak, new TextEncoder().encode(name));
  const versionHash = keccakSync(keccak, new TextEncoder().encode(version));
  const sep = keccakSync(
    keccak,
    concatBytes(
      typeHash,
      nameHash,
      versionHash,
      abiWord(BigInt(domain.chainId)),
      abiWord(normalizeAddress(domain.verifyingContract)),
    ),
  );
  return bytesToHex(sep);
}

/** The struct hash of a delegation (no domain), per the ERC-7710 typed-data layout. */
export async function delegationStructHash(d: Delegation): Promise<Hex> {
  const { keccak } = await loadCrypto();
  const delegationTypeHash = keccakSync(keccak, new TextEncoder().encode(DELEGATION_TYPE_STRING));

  const caveatTypeHash = keccakSync(keccak, new TextEncoder().encode(CAVEAT_TYPE_STRING));
  const caveatHashes = d.caveats.map((c) => {
    const termsHash = keccakSync(keccak, hexToBytes(c.terms));
    return keccakSync(
      keccak,
      concatBytes(caveatTypeHash, abiWord(normalizeAddress(c.enforcer)), termsHash),
    );
  });
  const caveatsHash = keccakSync(keccak, concatBytes(...caveatHashes));

  const structHash = keccakSync(
    keccak,
    concatBytes(
      delegationTypeHash,
      abiWord(normalizeAddress(d.delegate)),
      abiWord(normalizeAddress(d.delegator)),
      abiWord(d.authority),
      caveatsHash,
      abiWord(d.salt),
    ),
  );
  return bytesToHex(structHash);
}

/** The full EIP-712 typed-data hash: keccak256(0x1901 ‖ domainSeparator ‖ structHash). */
export async function delegationHash(d: Delegation, domain: Eip712Domain): Promise<Hex> {
  const sep = await domainSeparator(domain);
  const structHash = await delegationStructHash(d);
  const digest = await keccak256(
    concatBytes(new Uint8Array([0x19, 0x01]), hexToBytes(sep), hexToBytes(structHash)),
  );
  return bytesToHex(digest);
}

/** Derive an EOA address from an uncompressed (65-byte, 0x04-prefixed) public key. */
async function addressFromPubKey(pub: Uint8Array): Promise<Hex> {
  const { keccak } = await loadCrypto();
  const body = pub.length === 65 ? pub.slice(1) : pub;
  const hash = keccakSync(keccak, body);
  return bytesToHex(hash.slice(-20));
}

/**
 * Sign a delegation with an EOA private key. Sets `signature = r ‖ s ‖ v` (65 bytes,
 * v = 27/28) and returns a new delegation; the input is not mutated.
 */
export async function signDelegation(
  d: Delegation,
  domain: Eip712Domain,
  privKey: Uint8Array | Hex,
): Promise<Delegation> {
  const { secp } = await loadCrypto();
  const digest = hexToBytes(await delegationHash(d, domain));
  const priv = typeof privKey === "string" ? hexToBytes(privKey) : privKey;
  const sig = secp.sign(digest, priv, { prehash: false });
  const r = abiWord(sig.r);
  const s = abiWord(sig.s);
  const v = new Uint8Array([27 + sig.recovery]);
  return { ...d, signature: bytesToHex(concatBytes(r, s, v)) };
}

export interface VerifyResult {
  ok: boolean;
  signer?: Hex;
  reason?: string;
}

/**
 * Verify a delegation's signature (ECDSA / EOA only). Recovers the signer from the
 * 65-byte signature and checks it equals `delegator`. EIP-1271 (contract) verification
 * needs an on-chain eth_call and is OUT OF SCOPE here.
 */
export async function verifyDelegation(d: Delegation, domain: Eip712Domain): Promise<VerifyResult> {
  const { secp } = await loadCrypto();
  const sigBytes = hexToBytes(d.signature);
  if (sigBytes.length !== 65) {
    return { ok: false, reason: `signature must be 65 bytes (got ${sigBytes.length})` };
  }
  const r = bytesToBigint(sigBytes.slice(0, 32));
  const s = bytesToBigint(sigBytes.slice(32, 64));
  const v = sigBytes[64];
  if (v !== 27 && v !== 28) {
    return { ok: false, reason: `unsupported recovery id v=${v} (EOA only, expected 27/28)` };
  }
  const recovery = v - 27;
  const digest = hexToBytes(await delegationHash(d, domain));
  let signer: Hex;
  try {
    const sig = new secp.Signature(r, s, recovery);
    const point = sig.recoverPublicKey(digest);
    const pub = point.toBytes(false);
    signer = await addressFromPubKey(pub);
  } catch (err) {
    return { ok: false, reason: `recovery failed: ${(err as Error).message}` };
  }
  const ok = signer.toLowerCase() === d.delegator.toLowerCase();
  return ok ? { ok, signer } : { ok, signer, reason: "recovered signer != delegator" };
}

function bytesToBigint(bytes: Uint8Array): bigint {
  let v = 0n;
  for (const b of bytes) v = (v << 8n) | BigInt(b);
  return v;
}
