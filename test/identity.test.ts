import { test } from "node:test";
import assert from "node:assert/strict";

import { generateKeyPairSync, sign as edSign } from "node:crypto";

import {
  noopVerifier,
  attestationFromIdentityResult,
  staticIdentityVerifier,
  visaTapVerifier,
  httpMessageSignaturesVerifier,
  type SignedRequest,
} from "../src/identity/verifier.ts";
import { evaluateGate } from "../src/core/gate.ts";
import { DEFAULT_DENY_RULES } from "../src/core/denyList.ts";
import {
  DEFAULT_GATE_CONFIG,
  type Attestation,
  type GateContext,
  type Mandate,
  type PaymentIntent,
} from "../src/core/types.ts";

test("the static verifier NEVER attests cryptographically (asserted id only)", async () => {
  const verifier = staticIdentityVerifier({
    "agent-a": { agentId: "agent-a", principal: "tiberiu", attestation: "registry_attested" },
  });
  // A matched record is asserted-but-unverified: it performs no signature check,
  // so it must NOT report a cryptographic attestation, and the gate must treat it
  // as untrusted (attestation "none", verified false).
  const matched = await verifier.verify("agent-a");
  assert.equal(matched.verified, false);
  assert.equal(matched.identity.attestation, "none");
  assert.equal(matched.identity.principal, "tiberiu"); // metadata preserved

  const unknown = await verifier.verify("agent-x");
  assert.equal(unknown.verified, false);
  assert.equal(unknown.identity.attestation, "none");

  assert.equal((await noopVerifier.verify("anything")).verified, false);
  assert.equal(attestationFromIdentityResult(matched), "none");
});

// --- Visa TAP RFC 9421 verification ------------------------------------------

const KEY_PAIR = generateKeyPairSync("ed25519");
const KEYID = "visa-key-1";

/** Build an RFC 9421 signed request over @method/@authority/@path covering the
 * stated created/expires window, signed with the test ed25519 key. */
function signRequest(over: {
  created: number;
  expires?: number;
  alg?: string;
  tamper?: boolean;
  key?: Parameters<typeof edSign>[2];
}): SignedRequest {
  const method = "POST";
  const authority = "api.example.com";
  const path = "/agent/pay";
  const alg = over.alg ?? "ed25519";
  const expiresPart = over.expires !== undefined ? `;expires=${over.expires}` : "";
  const inner = `("@method" "@authority" "@path");created=${over.created}${expiresPart};keyid="${KEYID}";alg="${alg}"`;
  const base = [
    `"@method": ${method}`,
    `"@authority": ${authority}`,
    `"@path": ${path}`,
    `"@signature-params": ${inner}`,
  ].join("\n");
  const sig = edSign(null, Buffer.from(base, "utf8"), over.key ?? KEY_PAIR.privateKey);
  const sigB64 = over.tamper
    ? Buffer.from("not-the-real-signature").toString("base64")
    : sig.toString("base64");
  return {
    method,
    authority,
    path,
    headers: {},
    signatureInput: `sig1=${inner}`,
    signature: `sig1=:${sigB64}:`,
  };
}

test("visaTapVerifier verifies a valid RFC 9421 ed25519 signature", async () => {
  const v = visaTapVerifier({
    resolveKey: (k) => (k === KEYID ? KEY_PAIR.publicKey : undefined),
    now: () => 1_000_000 * 1000,
  });
  const res = await v.verify(signRequest({ created: 999_900 }));
  assert.equal(res.verified, true);
  assert.equal(res.identity.attestation, "signed");
  assert.equal(res.identity.agentId, KEYID);
  assert.equal(attestationFromIdentityResult(res), "signed");
});

test("visaTapVerifier binds a principal via identityOf (registry_attested)", async () => {
  const v = visaTapVerifier({
    resolveKey: () => KEY_PAIR.publicKey,
    identityOf: (k) => ({ agentId: k, principal: "tiberiu", attestation: "registry_attested" }),
    now: () => 1_000_000 * 1000,
  });
  const res = await v.verify(signRequest({ created: 999_900 }));
  assert.equal(res.verified, true);
  assert.equal(res.identity.principal, "tiberiu");
  assert.equal(res.identity.attestation, "registry_attested");
});

test("visaTapVerifier rejects a tampered signature", async () => {
  const v = visaTapVerifier({ resolveKey: () => KEY_PAIR.publicKey, now: () => 1_000_000 * 1000 });
  const res = await v.verify(signRequest({ created: 999_900, tamper: true }));
  assert.equal(res.verified, false);
});

test("visaTapVerifier rejects a wrong key (unknown keyid)", async () => {
  const v = visaTapVerifier({ resolveKey: () => undefined, now: () => 1_000_000 * 1000 });
  const res = await v.verify(signRequest({ created: 999_900 }));
  assert.equal(res.verified, false);
  assert.ok(res.reasons.some((r) => r.includes("keyid")));
});

test("visaTapVerifier rejects a key that doesn't match the signature", async () => {
  const other = generateKeyPairSync("ed25519");
  const v = visaTapVerifier({ resolveKey: () => other.publicKey, now: () => 1_000_000 * 1000 });
  const res = await v.verify(signRequest({ created: 999_900 }));
  assert.equal(res.verified, false);
});

test("visaTapVerifier enforces the expires freshness window", async () => {
  const v = visaTapVerifier({ resolveKey: () => KEY_PAIR.publicKey, now: () => 2_000_000 * 1000 });
  const res = await v.verify(signRequest({ created: 999_900, expires: 1_000_000 }));
  assert.equal(res.verified, false);
  assert.ok(res.reasons.some((r) => r.includes("expired")));
});

test("visaTapVerifier rejects a too-old signature (no expires, beyond max-age)", async () => {
  const v = visaTapVerifier({
    resolveKey: () => KEY_PAIR.publicKey,
    now: () => 1_000_000 * 1000,
    maxAgeSeconds: 60,
  });
  const res = await v.verify(signRequest({ created: 999_000 }));
  assert.equal(res.verified, false);
});

test("visaTapVerifier rejects a non-ed25519 alg", async () => {
  const v = visaTapVerifier({ resolveKey: () => KEY_PAIR.publicKey, now: () => 1_000_000 * 1000 });
  const res = await v.verify(signRequest({ created: 999_900, alg: "rsa-pss-sha512" }));
  assert.equal(res.verified, false);
  assert.ok(res.reasons.some((r) => r.includes("ed25519")));
});

// --- Optional http-message-signatures path verifies the SAME vector -----------
test("httpMessageSignaturesVerifier verifies the same vector as the bespoke verifier", async () => {
  const opts = {
    resolveKey: (k: string) => (k === KEYID ? KEY_PAIR.publicKey : undefined),
    now: () => 1_000_000 * 1000,
  };
  const req = signRequest({ created: 999_900 });
  const bespoke = await visaTapVerifier(opts).verify(req);
  const lib = await httpMessageSignaturesVerifier(opts).verify(req);
  // The optional dep is absent in CI → the lib-backed verifier delegates to bespoke
  // and yields the same verdict (verified, attestation, agentId) on the same vector.
  assert.equal(lib.verified, bespoke.verified);
  assert.equal(lib.verified, true);
  assert.equal(lib.identity.attestation, bespoke.identity.attestation);
  assert.equal(lib.identity.agentId, bespoke.identity.agentId);
});

test("httpMessageSignaturesVerifier rejects a tampered signature like the bespoke path", async () => {
  const opts = { resolveKey: () => KEY_PAIR.publicKey, now: () => 1_000_000 * 1000 };
  const res = await httpMessageSignaturesVerifier(opts).verify(signRequest({ created: 999_900, tamper: true }));
  assert.equal(res.verified, false);
});

const NOW = "2026-05-30T12:00:00.000Z";
const mandate: Mandate = {
  id: "m",
  label: "groceries",
  scope: { kind: "class", value: "groceries" },
  currency: "GBP",
  allowedRails: ["card"],
  perTxCap: 500_00,
  perPeriodCap: 1000_00,
  period: "week",
  grantedAt: "2026-05-26T00:00:00.000Z",
  expiresAt: "2026-06-26T00:00:00.000Z",
  status: "active",
};
const intent = (over: Partial<PaymentIntent> = {}): PaymentIntent => ({
  id: "pi",
  payee: "tesco",
  payeeClass: "groceries",
  amount: 80_00,
  currency: "GBP",
  rail: "card",
  rationale: "weekly shop",
  createdAt: NOW,
  ...over,
});
const ctx = (attestation?: Attestation): GateContext => ({
  now: NOW,
  mandates: [mandate],
  periodSpendByMandate: () => [],
  knownPayees: new Set(["tesco"]),
  denyRules: DEFAULT_DENY_RULES,
  config: DEFAULT_GATE_CONFIG,
  attestation,
});

test("an unverified agent is riskier than a registry-attested one", () => {
  const unverified = evaluateGate(intent(), ctx("none"));
  const attested = evaluateGate(intent(), ctx("registry_attested"));
  assert.ok(unverified.risk.score > attested.risk.score);
  assert.ok(unverified.risk.reasons.some((r) => r.includes("unverified")));
});

test("attestation NEVER relaxes the floor (over-cap still blocks, even attested)", () => {
  const d = evaluateGate(intent({ amount: 600_00 }), ctx("registry_attested"));
  assert.equal(d.outcome, "block");
  assert.ok(d.reasons.some((r) => r.includes("per-transaction cap")));
});

test("attestation is opt-in: undefined leaves risk unchanged", () => {
  const withoutSignal = evaluateGate(intent(), ctx(undefined));
  assert.ok(!withoutSignal.risk.reasons.some((r) => r.includes("agent")));
});
