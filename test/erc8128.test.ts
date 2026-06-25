import { test } from "node:test";
import assert from "node:assert/strict";

import { secp256k1 } from "@noble/curves/secp256k1";
import { keccak_256 } from "@noble/hashes/sha3";
import { bytesToHex } from "@noble/hashes/utils";

import type { SignedRequest } from "../src/identity/verifier.ts";
import {
  erc8128Verifier,
  parseErc8128KeyId,
  recoverErc8128Address,
  signErc8128,
} from "../src/identity/erc8128.ts";

const PRIV = keccak_256(new TextEncoder().encode("erc8128-test-key"));
const PUB = secp256k1.getPublicKey(PRIV, false);
const ADDRESS = `0x${bytesToHex(keccak_256(PUB.slice(1)).slice(-20))}`;
const CHAIN_ID = 8453; // Base

const NOW_SEC = 1_000_000;

/** Build the RFC 9421 base over @method/@authority/@path for a sample request and
 * sign it EIP-191. Returns a SignedRequest the verifier can consume. */
async function signed(over: {
  created?: number;
  expires?: number;
  keyidAddress?: string; // override the keyid's address (for the mismatch case)
  tamperMethod?: boolean; // sign over GET but present POST (covered-component tamper)
} = {}): Promise<SignedRequest> {
  const created = over.created ?? NOW_SEC - 100;
  const method = "POST";
  const authority = "api.example.com";
  const path = "/agent/pay";
  const keyidAddress = over.keyidAddress ?? ADDRESS;
  const keyid = `erc8128:${CHAIN_ID}:${keyidAddress}`;
  const expiresPart = over.expires !== undefined ? `;expires=${over.expires}` : "";
  const inner = `("@method" "@authority" "@path");created=${created}${expiresPart};keyid="${keyid}";nonce="abc123"`;
  const signMethod = over.tamperMethod ? "GET" : method;
  const base = [
    `"@method": ${signMethod}`,
    `"@authority": ${authority}`,
    `"@path": ${path}`,
    `"@signature-params": ${inner}`,
  ].join("\n");
  const sig = await signErc8128(base, PRIV);
  const sigB64 = Buffer.from(sig).toString("base64");
  return {
    method,
    authority,
    path,
    headers: {},
    signatureInput: `sig1=${inner}`,
    signature: `sig1=:${sigB64}:`,
  };
}

test("parseErc8128KeyId parses valid ids and rejects malformed ones", () => {
  const ok = parseErc8128KeyId(`erc8128:8453:${ADDRESS}`);
  assert.deepEqual(ok, { chainId: 8453, address: ADDRESS.toLowerCase() });
  // case-insensitive address, normalized to lowercase
  const mixed = parseErc8128KeyId(`erc8128:1:0xABCDEF0123456789abcdef0123456789ABCDEF01`);
  assert.equal(mixed?.address, "0xabcdef0123456789abcdef0123456789abcdef01");
  assert.equal(parseErc8128KeyId("visa-key-1"), undefined);
  assert.equal(parseErc8128KeyId("erc8128:abc:0x00"), undefined);
  assert.equal(parseErc8128KeyId(`erc8128:1:${ADDRESS.slice(0, 20)}`), undefined);
});

test("recoverErc8128Address round-trips signErc8128 to the signer address", async () => {
  const M = "the signature base string";
  const sig = await signErc8128(M, PRIV);
  assert.equal(sig.length, 65);
  const recovered = await recoverErc8128Address(M, sig);
  assert.equal(recovered, ADDRESS.toLowerCase());
});

test("erc8128Verifier verifies a valid EIP-191 signed request", async () => {
  const v = erc8128Verifier({ now: () => NOW_SEC * 1000 });
  const res = await v.verify(await signed());
  assert.equal(res.verified, true);
  assert.equal(res.identity.attestation, "signed");
  assert.equal(res.identity.agentId, ADDRESS.toLowerCase());
});

test("erc8128Verifier binds a principal via identityOf (registry_attested)", async () => {
  const v = erc8128Verifier({
    now: () => NOW_SEC * 1000,
    identityOf: (addr) => ({
      agentId: addr,
      principal: "tiberiu",
      attestation: "registry_attested",
    }),
  });
  const res = await v.verify(await signed());
  assert.equal(res.verified, true);
  assert.equal(res.identity.principal, "tiberiu");
  assert.equal(res.identity.attestation, "registry_attested");
});

test("erc8128Verifier rejects a tampered covered component", async () => {
  const v = erc8128Verifier({ now: () => NOW_SEC * 1000 });
  // Signed over GET, presented as POST → recovered address won't match keyid.
  const res = await v.verify(await signed({ tamperMethod: true }));
  assert.equal(res.verified, false);
  assert.ok(res.reasons.some((r) => r.includes("does not match")));
});

test("erc8128Verifier rejects a wrong keyid address (recovered != keyid)", async () => {
  const v = erc8128Verifier({ now: () => NOW_SEC * 1000 });
  const res = await v.verify(
    await signed({ keyidAddress: "0x0000000000000000000000000000000000000000" }),
  );
  assert.equal(res.verified, false);
  assert.ok(res.reasons.some((r) => r.includes("does not match")));
});

test("erc8128Verifier enforces the expires freshness window", async () => {
  const v = erc8128Verifier({ now: () => NOW_SEC * 1000 });
  const res = await v.verify(await signed({ created: NOW_SEC - 1000, expires: NOW_SEC - 500 }));
  assert.equal(res.verified, false);
  assert.ok(res.reasons.some((r) => r.includes("expired")));
});

test("erc8128Verifier rejects a too-old signature (no expires, beyond max-age)", async () => {
  const v = erc8128Verifier({ now: () => NOW_SEC * 1000, maxAgeSeconds: 60 });
  const res = await v.verify(await signed({ created: NOW_SEC - 1000 }));
  assert.equal(res.verified, false);
  assert.ok(res.reasons.some((r) => r.includes("too old")));
});

test("erc8128Verifier rejects a non-erc8128 keyid", async () => {
  const v = erc8128Verifier({ now: () => NOW_SEC * 1000 });
  const req = await signed();
  req.signatureInput = req.signatureInput.replace(/keyid="[^"]*"/, 'keyid="visa-key-1"');
  const res = await v.verify(req);
  assert.equal(res.verified, false);
  assert.ok(res.reasons.some((r) => r.includes("erc8128")));
});

test("erc8128Verifier rejects a non-request artifact", async () => {
  const v = erc8128Verifier({ now: () => NOW_SEC * 1000 });
  const res = await v.verify({ foo: "bar" });
  assert.equal(res.verified, false);
});

test("erc8128Verifier supports an injected ERC-1271 contract signer", async () => {
  // A contract address (not derivable by plain recovery) accepted by an injected
  // resolver. Use a keyid address that recovery will never match.
  const contractAddr = "0x1111111111111111111111111111111111111111";
  const v = erc8128Verifier({
    now: () => NOW_SEC * 1000,
    resolveContractSig: (addr) => addr === contractAddr,
  });
  const res = await v.verify(await signed({ keyidAddress: contractAddr }));
  assert.equal(res.verified, true);
  assert.equal(res.identity.attestation, "signed");
  assert.equal(res.identity.agentId, contractAddr);
});
