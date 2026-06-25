import { test } from "node:test";
import assert from "node:assert/strict";

import { secp256k1 } from "@noble/curves/secp256k1";
import { keccak_256 } from "@noble/hashes/sha3";
import { bytesToHex } from "@noble/hashes/utils";

import {
  mapWorldAgentToAttestation,
  validateWorldAgentStructural,
  verifyWorldAgent,
  worldAgentIdentityVerifier,
  type AgentBookResolver,
  type WorldAgentAttestation,
} from "../src/identity/worldAgent.ts";
import { signErc8128 } from "../src/identity/erc8128.ts";

const PRIV = keccak_256(new TextEncoder().encode("worldagent-test-key"));
const PUB = secp256k1.getPublicKey(PRIV, false);
const ADDRESS = `0x${bytesToHex(keccak_256(PUB.slice(1)).slice(-20))}`;

// The canonical CAIP-122 / SIWE string the agent personal_signed (agentkit rebuilds
// this from the structured fields via viem's createSiweMessage).
const MESSAGE = [
  "example.com wants you to sign in with your Ethereum account:",
  ADDRESS,
  "",
  "Agent backed by a World ID human",
  "",
  "URI: https://example.com",
  "Version: 1",
  "Chain ID: 480",
  "Nonce: abc123def",
  "Issued At: 2026-06-25T00:00:00.000Z",
].join("\n");

const HUMAN_NULLIFIER = "0x000000000000000000000000000000000000000000000000000000000000beef";

/** Build a WorldAgent attestation signed EIP-191 by PRIV. `over` overrides fields
 * (e.g. a wrong `address` for the signer-mismatch case). The signature is over
 * `MESSAGE` regardless, so overriding `address` produces a recovered != address case. */
async function attestation(
  over: Partial<WorldAgentAttestation> = {},
): Promise<WorldAgentAttestation> {
  const sig = await signErc8128(MESSAGE, PRIV);
  return {
    scheme: "WorldAgent",
    address: ADDRESS,
    message: MESSAGE,
    signature: `0x${bytesToHex(sig)}`,
    chainId: "eip155:480",
    type: "eip191",
    domain: "example.com",
    uri: "https://example.com",
    version: "1",
    nonce: "abc123def",
    issuedAt: "2026-06-25T00:00:00.000Z",
    ...over,
  };
}

const registeredResolver: AgentBookResolver = async () => ({
  registered: true,
  humanNullifier: HUMAN_NULLIFIER,
});

test("validateWorldAgentStructural accepts a well-formed attestation", async () => {
  assert.equal(validateWorldAgentStructural(await attestation()), true);
});

test("validateWorldAgentStructural rejects malformed attestations", async () => {
  const base = await attestation();
  assert.equal(validateWorldAgentStructural({ ...base, address: "0xabc" }), false); // short address
  assert.equal(validateWorldAgentStructural({ ...base, message: "" }), false); // empty message
  assert.equal(validateWorldAgentStructural({ ...base, signature: "deadbeef" }), false); // not 0x-hex
  assert.equal(validateWorldAgentStructural({ ...base, chainId: "worldchain" }), false); // not CAIP-2
  assert.equal(
    validateWorldAgentStructural({ ...base, type: "schnorr" as never }),
    false,
  ); // type not in the enum
  assert.equal(validateWorldAgentStructural({ ...base, nonce: "" }), false); // empty nonce
  assert.equal(validateWorldAgentStructural({ scheme: "Other" } as never), false);
});

test("mapWorldAgentToAttestation: invalid → none; backed → registry_attested; unbacked → signed", () => {
  assert.equal(mapWorldAgentToAttestation(true, false), "none");
  assert.equal(mapWorldAgentToAttestation(false, false), "none");
  assert.equal(mapWorldAgentToAttestation(true, true), "registry_attested");
  assert.equal(mapWorldAgentToAttestation(false, true), "signed");
});

test("verifyWorldAgent: no resolver → signature-valid-only, humanBacked false, never throws", async () => {
  const res = await verifyWorldAgent(await attestation());
  assert.equal(res.structural, true);
  assert.equal(res.valid, true);
  assert.equal(res.address, ADDRESS.toLowerCase());
  assert.equal(res.humanBacked, false);
  assert.equal(res.nullifier, undefined);
  assert.ok(res.reason?.includes("no AgentBook resolver"));
});

test("verifyWorldAgent: malformed attestation → structural false, never throws", async () => {
  const res = await verifyWorldAgent({ ...(await attestation()), signature: "nothex" }, {
    resolver: registeredResolver,
  });
  assert.equal(res.structural, false);
  assert.equal(res.valid, false);
  assert.equal(res.humanBacked, false);
});

test("verifyWorldAgent: resolver registered:true → humanBacked + nullifier", async () => {
  const res = await verifyWorldAgent(await attestation(), { resolver: registeredResolver });
  assert.equal(res.valid, true);
  assert.equal(res.humanBacked, true);
  assert.equal(res.nullifier, HUMAN_NULLIFIER);
});

test("verifyWorldAgent: signer != address → invalid (recovered mismatch)", async () => {
  const res = await verifyWorldAgent(
    await attestation({ address: "0x0000000000000000000000000000000000000000" }),
    { resolver: registeredResolver },
  );
  assert.equal(res.valid, false);
  assert.equal(res.address, undefined);
  assert.ok(res.reason?.includes("does not match"));
});

test("verifyWorldAgent: resolver returns null → valid sig but humanBacked false", async () => {
  const res = await verifyWorldAgent(await attestation(), { resolver: async () => null });
  assert.equal(res.valid, true);
  assert.equal(res.humanBacked, false);
  assert.equal(res.nullifier, undefined);
});

test("verifyWorldAgent: resolver registered:false → valid sig but humanBacked false", async () => {
  const res = await verifyWorldAgent(await attestation(), {
    resolver: async () => ({ registered: false }),
  });
  assert.equal(res.valid, true);
  assert.equal(res.humanBacked, false);
});

test("verifyWorldAgent: non-eip191 type not recovered locally (signature-valid-only false)", async () => {
  const res = await verifyWorldAgent(await attestation({ type: "ed25519" }));
  assert.equal(res.structural, true);
  assert.equal(res.valid, false);
  assert.ok(res.reason?.includes("not recovered locally"));
});

test("worldAgentIdentityVerifier: backed → registry_attested, agentId = human nullifier", async () => {
  const v = worldAgentIdentityVerifier({ resolver: registeredResolver });
  const res = await v.verify(await attestation());
  assert.equal(res.verified, true);
  assert.equal(res.identity.attestation, "registry_attested");
  assert.equal(res.identity.agentId, HUMAN_NULLIFIER);
  assert.equal(res.identity.principal, HUMAN_NULLIFIER);
});

test("worldAgentIdentityVerifier: valid sig, unbacked → signed, agentId = address", async () => {
  const v = worldAgentIdentityVerifier({ resolver: async () => ({ registered: false }) });
  const res = await v.verify(await attestation());
  assert.equal(res.verified, true);
  assert.equal(res.identity.attestation, "signed");
  assert.equal(res.identity.agentId, ADDRESS.toLowerCase());
  assert.equal(res.identity.principal, undefined);
});

test("worldAgentIdentityVerifier: no resolver → signed, not human-backed", async () => {
  const v = worldAgentIdentityVerifier();
  const res = await v.verify(await attestation());
  assert.equal(res.verified, true);
  assert.equal(res.identity.attestation, "signed");
});

test("worldAgentIdentityVerifier: invalid signature → not verified, none", async () => {
  const v = worldAgentIdentityVerifier({ resolver: registeredResolver });
  const res = await v.verify(
    await attestation({ address: "0x0000000000000000000000000000000000000000" }),
  );
  assert.equal(res.verified, false);
  assert.equal(res.identity.attestation, "none");
});

test("worldAgentIdentityVerifier: non-World-Agent artifact → unverified none", async () => {
  const v = worldAgentIdentityVerifier({ resolver: registeredResolver });
  const res = await v.verify({ nope: true });
  assert.equal(res.verified, false);
  assert.equal(res.identity.attestation, "none");
  assert.ok(res.reasons.some((r) => r.includes("not a World Agent")));
});
