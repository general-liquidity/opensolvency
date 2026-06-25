import assert from "node:assert/strict";
import { test } from "node:test";
import type { Mandate } from "../src/core/types.ts";
import {
  ANY_DELEGATE,
  type Eip712Domain,
  type EnforcerAddresses,
  type Hex,
  ROOT_AUTHORITY,
  abiWord,
  bytesToHex,
  delegationHash,
  delegationStructHash,
  deterministicSalt,
  domainSeparator,
  encodeAllowedTargetsTerms,
  encodeErc20AmountTerms,
  encodeNativeAmountTerms,
  encodeNativePeriodTerms,
  encodePeriodTerms,
  encodeTimestampTerms,
  hexToBytes,
  mandateToDelegation,
  signDelegation,
  verifyDelegation,
} from "../src/erc7710/index.ts";

const ENFORCERS: EnforcerAddresses = {
  timestamp: "0x1111111111111111111111111111111111111111",
  nativeTokenTransferAmount: "0x2222222222222222222222222222222222222222",
  erc20TransferAmount: "0x3333333333333333333333333333333333333333",
  erc20PeriodTransfer: "0x4444444444444444444444444444444444444444",
  nativeTokenPeriodTransfer: "0x5555555555555555555555555555555555555555",
  allowedTargets: "0x6666666666666666666666666666666666666666",
};

const DELEGATE: Hex = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const DELEGATOR: Hex = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const TOKEN: Hex = "0xcccccccccccccccccccccccccccccccccccccccc";

const DOMAIN: Eip712Domain = {
  chainId: 1,
  verifyingContract: "0xdddddddddddddddddddddddddddddddddddddddd",
};

function baseMandate(overrides: Partial<Mandate> = {}): Mandate {
  return {
    id: "mandate-1",
    label: "weekly groceries",
    scope: { kind: "class", value: "groceries" },
    currency: "USDC",
    allowedRails: ["onchain"],
    perTxCap: 50_000,
    perPeriodCap: 200_000,
    period: "week",
    grantedAt: "2026-01-01T00:00:00.000Z",
    expiresAt: "2026-02-01T00:00:00.000Z",
    status: "active",
    ...overrides,
  };
}

// --- terms encoders ---------------------------------------------------------

test("encodeTimestampTerms produces 32 bytes with beforeThreshold in [16:32]", () => {
  const before = 1_900_000_000;
  const terms = encodeTimestampTerms(before);
  assert.equal(terms.length, 32);
  // afterThreshold (0) in low 16 bytes is zero
  for (let i = 0; i < 16; i++) assert.equal(terms[i], 0);
  // beforeThreshold occupies [16:32]
  const beforeFromBytes = Number(
    hexToBytes(bytesToHex(terms.slice(16))).reduce((acc, b) => (acc << 8n) | BigInt(b), 0n),
  );
  assert.equal(beforeFromBytes, before);
});

test("encodeTimestampTerms places afterThreshold in [0:16]", () => {
  const terms = encodeTimestampTerms(2000, 1000);
  const after = terms.slice(0, 16).reduce((acc, b) => (acc << 8n) | BigInt(b), 0n);
  const before = terms.slice(16, 32).reduce((acc, b) => (acc << 8n) | BigInt(b), 0n);
  assert.equal(after, 1000n);
  assert.equal(before, 2000n);
});

test("encodeNativeAmountTerms is a 32-byte big-endian uint256", () => {
  const terms = encodeNativeAmountTerms(255n);
  assert.equal(terms.length, 32);
  assert.equal(terms[31], 255);
  assert.equal(terms[30], 0);
});

test("encodeErc20AmountTerms is 64 bytes: token word ‖ allowance word", () => {
  const terms = encodeErc20AmountTerms(TOKEN, 1234n);
  assert.equal(terms.length, 64);
  // token left-padded into first word: address bytes occupy [12:32]
  assert.equal(bytesToHex(terms.slice(12, 32)), TOKEN);
  assert.equal(
    terms.slice(32).reduce((acc, b) => (acc << 8n) | BigInt(b), 0n),
    1234n,
  );
});

test("encodePeriodTerms is 116 bytes with fields at the documented offsets", () => {
  const terms = encodePeriodTerms(TOKEN, 999n, 604800, 1_700_000_000);
  assert.equal(terms.length, 116);
  assert.equal(bytesToHex(terms.slice(0, 20)), TOKEN); // token packed (not padded)
  assert.equal(
    terms.slice(20, 52).reduce((a, b) => (a << 8n) | BigInt(b), 0n),
    999n,
  );
  assert.equal(
    terms.slice(52, 84).reduce((a, b) => (a << 8n) | BigInt(b), 0n),
    604800n,
  );
  assert.equal(
    terms.slice(84, 116).reduce((a, b) => (a << 8n) | BigInt(b), 0n),
    1_700_000_000n,
  );
});

test("encodeNativePeriodTerms is 96 bytes with three uint256 words", () => {
  const terms = encodeNativePeriodTerms(7n, 86400, 100);
  assert.equal(terms.length, 96);
  assert.equal(
    terms.slice(0, 32).reduce((a, b) => (a << 8n) | BigInt(b), 0n),
    7n,
  );
  assert.equal(
    terms.slice(32, 64).reduce((a, b) => (a << 8n) | BigInt(b), 0n),
    86400n,
  );
  assert.equal(
    terms.slice(64, 96).reduce((a, b) => (a << 8n) | BigInt(b), 0n),
    100n,
  );
});

test("encodeAllowedTargetsTerms packs 20-byte addresses (len % 20 == 0, len != 0)", () => {
  const terms = encodeAllowedTargetsTerms([DELEGATE, DELEGATOR]);
  assert.equal(terms.length, 40);
  assert.equal(terms.length % 20, 0);
  assert.equal(bytesToHex(terms.slice(0, 20)), DELEGATE);
  assert.equal(bytesToHex(terms.slice(20, 40)), DELEGATOR);
});

test("encodeAllowedTargetsTerms rejects an empty list", () => {
  assert.throws(() => encodeAllowedTargetsTerms([]));
});

test("terms encoders reject negative amounts", () => {
  assert.throws(() => encodeNativeAmountTerms(-1n));
  assert.throws(() => encodeErc20AmountTerms(TOKEN, -1n));
  assert.throws(() => encodePeriodTerms(TOKEN, -1n, 1, 0));
});

// --- abiWord ----------------------------------------------------------------

test("abiWord left-pads an address to 32 bytes", () => {
  const w = abiWord(DELEGATE);
  assert.equal(w.length, 32);
  for (let i = 0; i < 12; i++) assert.equal(w[i], 0);
  assert.equal(bytesToHex(w.slice(12)), DELEGATE);
});

test("abiWord encodes a bigint big-endian and rejects > 32 bytes", () => {
  const w = abiWord(1n);
  assert.equal(w[31], 1);
  assert.throws(() => abiWord(1n << 256n));
});

// --- deterministic salt -----------------------------------------------------

test("deterministicSalt is stable and id-dependent", () => {
  assert.equal(deterministicSalt("mandate-1"), deterministicSalt("mandate-1"));
  assert.notEqual(deterministicSalt("mandate-1"), deterministicSalt("mandate-2"));
});

// --- mandateToDelegation ----------------------------------------------------

test("mandateToDelegation (allowlist + caps + expiry, ERC-20) yields the expected caveat set", () => {
  const m = baseMandate({
    scope: { kind: "allowlist", values: [DELEGATE, DELEGATOR] },
  });
  const del = mandateToDelegation(m, {
    delegate: DELEGATE,
    delegator: DELEGATOR,
    enforcers: ENFORCERS,
    token: TOKEN,
  });

  assert.equal(del.authority, ROOT_AUTHORITY);
  assert.equal(del.signature, "0x");
  assert.equal(del.delegate, DELEGATE);
  assert.equal(del.delegator, DELEGATOR);
  assert.equal(del.salt, deterministicSalt(m.id));

  // 4 caveats: timestamp, erc20 amount, erc20 period, allowed targets
  assert.equal(del.caveats.length, 4);
  assert.equal(del.caveats[0].enforcer, ENFORCERS.timestamp);
  assert.equal(del.caveats[1].enforcer, ENFORCERS.erc20TransferAmount);
  assert.equal(del.caveats[2].enforcer, ENFORCERS.erc20PeriodTransfer);
  assert.equal(del.caveats[3].enforcer, ENFORCERS.allowedTargets);
  for (const c of del.caveats) assert.equal(c.args, "0x");

  // timestamp caveat carries the expiry as beforeThreshold
  const tsTerms = hexToBytes(del.caveats[0].terms);
  const before = tsTerms.slice(16, 32).reduce((a, b) => (a << 8n) | BigInt(b), 0n);
  assert.equal(before, BigInt(Math.floor(new Date(m.expiresAt).getTime() / 1000)));

  // per-tx amount caveat carries perTxCap as allowance
  const amtTerms = hexToBytes(del.caveats[1].terms);
  assert.equal(
    amtTerms.slice(32).reduce((a, b) => (a << 8n) | BigInt(b), 0n),
    BigInt(m.perTxCap),
  );

  // period caveat carries perPeriodCap, the week duration, and grantedAt as startDate
  const perTerms = hexToBytes(del.caveats[2].terms);
  assert.equal(
    perTerms.slice(20, 52).reduce((a, b) => (a << 8n) | BigInt(b), 0n),
    BigInt(m.perPeriodCap),
  );
  assert.equal(
    perTerms.slice(52, 84).reduce((a, b) => (a << 8n) | BigInt(b), 0n),
    604800n,
  );
  assert.equal(
    perTerms.slice(84, 116).reduce((a, b) => (a << 8n) | BigInt(b), 0n),
    BigInt(Math.floor(new Date(m.grantedAt).getTime() / 1000)),
  );
});

test("mandateToDelegation (class scope, native) omits allowedTargets and uses native enforcers", () => {
  const m = baseMandate();
  const del = mandateToDelegation(m, {
    delegate: DELEGATE,
    delegator: DELEGATOR,
    enforcers: ENFORCERS,
  });
  assert.equal(del.caveats.length, 3); // timestamp, native amount, native period
  assert.equal(del.caveats[1].enforcer, ENFORCERS.nativeTokenTransferAmount);
  assert.equal(del.caveats[2].enforcer, ENFORCERS.nativeTokenPeriodTransfer);
});

test("mandateToDelegation is deterministic (no clock/random) and honors a salt override", () => {
  const m = baseMandate();
  const a = mandateToDelegation(m, {
    delegate: DELEGATE,
    delegator: DELEGATOR,
    enforcers: ENFORCERS,
    salt: 42n,
  });
  const b = mandateToDelegation(m, {
    delegate: DELEGATE,
    delegator: DELEGATOR,
    enforcers: ENFORCERS,
    salt: 42n,
  });
  assert.deepEqual(a, b);
  assert.equal(a.salt, 42n);
});

test("mandateToDelegation throws when a required enforcer is missing", () => {
  const m = baseMandate({ scope: { kind: "allowlist", values: [DELEGATE] } });
  assert.throws(() =>
    mandateToDelegation(m, {
      delegate: DELEGATE,
      delegator: DELEGATOR,
      enforcers: { timestamp: ENFORCERS.timestamp }, // missing native + allowedTargets
    }),
  );
});

// --- hashing ----------------------------------------------------------------

test("domainSeparator is deterministic for fixed inputs", async () => {
  const a = await domainSeparator(DOMAIN);
  const b = await domainSeparator(DOMAIN);
  assert.equal(a, b);
  assert.match(a, /^0x[0-9a-f]{64}$/);
});

test("delegationStructHash and delegationHash are deterministic 32-byte digests", async () => {
  const m = baseMandate({ scope: { kind: "allowlist", values: [DELEGATE] } });
  const del = mandateToDelegation(m, {
    delegate: DELEGATE,
    delegator: DELEGATOR,
    enforcers: ENFORCERS,
    token: TOKEN,
    salt: 7n,
  });
  const sh1 = await delegationStructHash(del);
  const sh2 = await delegationStructHash(del);
  assert.equal(sh1, sh2);
  assert.match(sh1, /^0x[0-9a-f]{64}$/);

  const h1 = await delegationHash(del, DOMAIN);
  const h2 = await delegationHash(del, DOMAIN);
  assert.equal(h1, h2);
  assert.match(h1, /^0x[0-9a-f]{64}$/);
  // domain matters
  const hOther = await delegationHash(del, { ...DOMAIN, chainId: 8453 });
  assert.notEqual(h1, hOther);
});

test("delegationHash golden vector (fixed inputs)", async () => {
  // A fully fixed delegation — guards against accidental changes to the hashing layout.
  const del = mandateToDelegation(
    baseMandate({ scope: { kind: "allowlist", values: [DELEGATE] } }),
    { delegate: DELEGATE, delegator: DELEGATOR, enforcers: ENFORCERS, token: TOKEN, salt: 1n },
  );
  const h = await delegationHash(del, DOMAIN);
  // Cross-checked against viem's hashTypedData (DelegationManager domain) — the
  // exact EIP-712 digest for this fixed delegation. Guards the hashing layout.
  assert.equal(h, "0xbf897562704065a28ccf280ce165324c1f202a08e8f9918f362cc77ee8ca12c6");
  // The empty-caveats edge case must hash deterministically too.
  const emptyHash = await delegationStructHash({
    delegate: DELEGATE,
    delegator: DELEGATOR,
    authority: ROOT_AUTHORITY,
    caveats: [],
    salt: 0n,
    signature: "0x",
  });
  assert.match(emptyHash, /^0x[0-9a-f]{64}$/);
});

// --- sign / verify round-trip -----------------------------------------------

const PRIV: Hex = `0x${"01".repeat(32)}`;

async function delegatorAddress(): Promise<Hex> {
  const { secp256k1 } = await import("@noble/curves/secp256k1");
  const { keccak_256 } = await import("@noble/hashes/sha3");
  const pub = secp256k1.getPublicKey(hexToBytes(PRIV), false);
  return bytesToHex(keccak_256(pub.slice(1)).slice(-20));
}

test("signDelegation → verifyDelegation round-trips with signer == delegator", async () => {
  const delegator = await delegatorAddress();
  const m = baseMandate({ scope: { kind: "allowlist", values: [DELEGATE] } });
  const del = mandateToDelegation(m, {
    delegate: DELEGATE,
    delegator,
    enforcers: ENFORCERS,
    token: TOKEN,
  });

  const signed = await signDelegation(del, DOMAIN, PRIV);
  assert.equal(hexToBytes(signed.signature).length, 65);
  const v = hexToBytes(signed.signature)[64];
  assert.ok(v === 27 || v === 28);
  // input not mutated
  assert.equal(del.signature, "0x");

  const result = await verifyDelegation(signed, DOMAIN);
  assert.equal(result.ok, true);
  assert.equal(result.signer?.toLowerCase(), delegator.toLowerCase());
});

test("verifyDelegation fails when a caveat term is tampered", async () => {
  const delegator = await delegatorAddress();
  const m = baseMandate({ scope: { kind: "allowlist", values: [DELEGATE] } });
  const del = mandateToDelegation(m, {
    delegate: DELEGATE,
    delegator,
    enforcers: ENFORCERS,
    token: TOKEN,
  });
  const signed = await signDelegation(del, DOMAIN, PRIV);

  // Tamper the first caveat's terms (flip a byte).
  const tamperedTerms = hexToBytes(signed.caveats[0].terms);
  tamperedTerms[31] ^= 0x01;
  const tampered = {
    ...signed,
    caveats: signed.caveats.map((c, i) =>
      i === 0 ? { ...c, terms: bytesToHex(tamperedTerms) } : c,
    ),
  };

  const result = await verifyDelegation(tampered, DOMAIN);
  assert.equal(result.ok, false);
});

test("verifyDelegation rejects a malformed signature length", async () => {
  const del = mandateToDelegation(baseMandate(), {
    delegate: DELEGATE,
    delegator: DELEGATOR,
    enforcers: ENFORCERS,
  });
  const r = await verifyDelegation({ ...del, signature: "0x1234" }, DOMAIN);
  assert.equal(r.ok, false);
  assert.match(r.reason ?? "", /65 bytes/);
});

test("verifyDelegation reports mismatch when delegator is not the signer", async () => {
  const m = baseMandate({ scope: { kind: "allowlist", values: [DELEGATE] } });
  // delegator deliberately wrong (not the key's address)
  const del = mandateToDelegation(m, {
    delegate: DELEGATE,
    delegator: DELEGATOR,
    enforcers: ENFORCERS,
    token: TOKEN,
  });
  const signed = await signDelegation(del, DOMAIN, PRIV);
  const result = await verifyDelegation(signed, DOMAIN);
  assert.equal(result.ok, false);
  assert.match(result.reason ?? "", /delegator/);
});

// --- constants --------------------------------------------------------------

test("constants have the expected shapes", () => {
  assert.equal(ROOT_AUTHORITY, `0x${"ff".repeat(32)}`);
  assert.equal(ANY_DELEGATE, "0x0000000000000000000000000000000000000a11");
});
