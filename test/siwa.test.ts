import { test } from "node:test";
import assert from "node:assert/strict";

import { secp256k1 } from "@noble/curves/secp256k1";
import { keccak_256 } from "@noble/hashes/sha3";
import { bytesToHex } from "@noble/hashes/utils";

import { signErc8128 } from "../src/identity/erc8128.ts";
import {
  formatSiwaMessage,
  mapSelfToAttestation,
  parseSiwaMessage,
  siwaIdentityVerifier,
  verifySiwa,
  type SiwaMessage,
} from "../src/identity/siwa.ts";

const PRIV = keccak_256(new TextEncoder().encode("siwa-test-key"));
const PUB = secp256k1.getPublicKey(PRIV, false);
const ADDRESS = `0x${bytesToHex(keccak_256(PUB.slice(1)).slice(-20))}`;

const NOW = Date.parse("2026-06-25T12:00:00Z");

function message(over: Partial<SiwaMessage> = {}): SiwaMessage {
  return {
    domain: "app.example.com",
    address: ADDRESS,
    uri: "https://app.example.com/login",
    version: "1",
    agentId: "42",
    agentRegistry: "eip155:8453:0xRegistry000000000000000000000000000000000",
    chainId: 8453,
    nonce: "abc12345",
    issuedAt: "2026-06-25T11:59:00Z",
    ...over,
  };
}

async function sign(m: SiwaMessage): Promise<Uint8Array> {
  return signErc8128(formatSiwaMessage(m), PRIV);
}

const baseOpts = {
  expectedDomain: "app.example.com",
  nonceValid: (n: string) => n === "abc12345",
  now: () => NOW,
};

test("formatSiwaMessage ↔ parseSiwaMessage round-trips (minimal)", () => {
  const m = message();
  const text = formatSiwaMessage(m);
  assert.deepEqual(parseSiwaMessage(text), { ...m, statement: undefined, expirationTime: undefined, notBefore: undefined, requestId: undefined });
});

test("formatSiwaMessage ↔ parseSiwaMessage round-trips (full, with optional fields)", () => {
  const m = message({
    statement: "I accept the agent terms",
    expirationTime: "2026-06-25T13:00:00Z",
    notBefore: "2026-06-25T11:00:00Z",
    requestId: "req-1",
  });
  const text = formatSiwaMessage(m);
  const parsed = parseSiwaMessage(text);
  assert.deepEqual(parsed, m);
});

test("formatSiwaMessage produces the spec header + fixed lines", () => {
  const text = formatSiwaMessage(message());
  assert.ok(text.startsWith("app.example.com wants you to sign in with your Agent account:\n"));
  assert.ok(text.includes("\nVersion: 1\n"));
  assert.ok(text.includes("\nAgent ID: 42\n"));
  assert.ok(text.includes("\nChain ID: 8453\n"));
});

test("verifySiwa: matching signature, no resolver → signed", async () => {
  const m = message();
  const res = await verifySiwa(m, await sign(m), baseOpts);
  assert.equal(res.verified, true);
  assert.equal(res.identity.attestation, "signed");
  assert.equal(res.identity.agentId, "42");
  assert.equal(res.identity.principal?.toLowerCase(), ADDRESS.toLowerCase());
});

test("verifySiwa: resolver owner == signer → registry_attested", async () => {
  const m = message();
  const res = await verifySiwa(m, await sign(m), {
    ...baseOpts,
    resolveRegistry: async () => ({ owner: ADDRESS, active: true, services: ["pay"] }),
  });
  assert.equal(res.verified, true);
  assert.equal(res.identity.attestation, "registry_attested");
  assert.deepEqual(res.identity.capabilities, ["pay"]);
});

test("verifySiwa: resolver owner != signer → signed (verified, not registry)", async () => {
  const m = message();
  const res = await verifySiwa(m, await sign(m), {
    ...baseOpts,
    resolveRegistry: async () => ({ owner: "0x9999999999999999999999999999999999999999" }),
  });
  assert.equal(res.verified, true);
  assert.equal(res.identity.attestation, "signed");
});

test("verifySiwa: wrong domain → unverified", async () => {
  const m = message();
  const res = await verifySiwa(m, await sign(m), { ...baseOpts, expectedDomain: "evil.com" });
  assert.equal(res.verified, false);
  assert.ok(res.reasons.some((r) => r.includes("domain")));
});

test("verifySiwa: invalid nonce → unverified", async () => {
  const m = message();
  const res = await verifySiwa(m, await sign(m), { ...baseOpts, nonceValid: () => false });
  assert.equal(res.verified, false);
  assert.ok(res.reasons.some((r) => r.includes("nonce")));
});

test("verifySiwa: expired message → unverified", async () => {
  const m = message({ expirationTime: "2026-06-25T11:00:00Z" });
  const res = await verifySiwa(m, await sign(m), baseOpts);
  assert.equal(res.verified, false);
  assert.ok(res.reasons.some((r) => r.includes("expired")));
});

test("verifySiwa: signer != address → unverified", async () => {
  const m = message();
  const sig = await sign(m);
  const tampered = { ...m, address: "0x0000000000000000000000000000000000000000" };
  const res = await verifySiwa(tampered, sig, baseOpts);
  assert.equal(res.verified, false);
  assert.ok(res.reasons.some((r) => r.includes("!=")));
});

test("siwaIdentityVerifier consumes { message, signature } and accepts a string message", async () => {
  const m = message();
  const v = siwaIdentityVerifier(baseOpts);
  const res = await v.verify({ message: formatSiwaMessage(m), signature: await sign(m) });
  assert.equal(res.verified, true);
  assert.equal(res.identity.attestation, "signed");

  const bad = await v.verify({ nope: true });
  assert.equal(bad.verified, false);
});

test("mapSelfToAttestation maps a Self verdict to an OS attestation", () => {
  assert.equal(mapSelfToAttestation({ valid: true, registryBacked: true }), "registry_attested");
  assert.equal(mapSelfToAttestation({ valid: true }), "signed");
  assert.equal(mapSelfToAttestation({ valid: true, registryBacked: false }), "signed");
  assert.equal(mapSelfToAttestation({ valid: false, registryBacked: true }), "none");
  assert.equal(mapSelfToAttestation({ valid: false }), "none");
});
