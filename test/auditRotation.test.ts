import { test } from "node:test";
import assert from "node:assert/strict";
import { AuditLog, type AuditEntry } from "../src/core/audit.ts";
import {
  KmsKeyProvider,
  staticKeyProvider,
  keyRingProvider,
  type KmsClient,
} from "../src/core/keyCustody.ts";

const TS = (m: number) => `2026-06-01T00:0${m}:00.000Z`;

/** A fake KMS whose "latest" version is advanceable, so we can drive a rotation. */
function fakeKms(material: Record<string, string>) {
  let latest = Object.keys(material)[0];
  const client: KmsClient = {
    getKey: (_keyId, version) => {
      const v = version ?? latest;
      const m = material[v];
      if (!m) throw new Error(`fakeKms: no key for version ${v}`);
      return { version: v, material: Buffer.from(m, "utf8") };
    },
  };
  return { client, setLatest: (v: string) => (latest = v) };
}

const roundTrip = (entries: readonly AuditEntry[]): AuditEntry[] =>
  JSON.parse(JSON.stringify(entries)) as AuditEntry[];

test("legacy string-key chain is unchanged: no keyVersion, verifies after round-trip", () => {
  const log = new AuditLog("legacy-key");
  // an entry with an explicit-undefined field (the audit round-trip regression case)
  log.append("gate.decision", { intentId: "x", attestation: undefined }, TS(0));
  log.append("payment.settled", { intentId: "x" }, TS(1));

  assert.equal(log.entries()[0].keyVersion, undefined); // no version stamped in string mode
  assert.equal(log.verify().valid, true);

  // reloaded from a JSON round-trip (sqlite/postgres path) still verifies
  const reloaded = new AuditLog("legacy-key", roundTrip(log.entries()));
  assert.equal(reloaded.verify().valid, true);
  // wrong key -> invalid
  assert.equal(new AuditLog("other-key", roundTrip(log.entries())).verify().valid, false);
});

test("provider mode stamps keyVersion and verifies after round-trip", () => {
  const log = new AuditLog(staticKeyProvider("k", "v1"));
  log.append("gate.decision", { intentId: "a" }, TS(0));
  assert.equal(log.entries()[0].keyVersion, "v1");

  const reloaded = new AuditLog(staticKeyProvider("k", "v1"), roundTrip(log.entries()));
  assert.equal(reloaded.verify().valid, true);
});

test("audit chain verifies across a key rotation (per-entry keyVersion)", () => {
  const kms = fakeKms({ v1: "key-one", v2: "key-two" });
  const provider = new KmsKeyProvider({ client: kms.client, keyId: "audit" }); // current = v1
  const log = new AuditLog(provider);

  log.append("gate.decision", { intentId: "a" }, TS(0)); // signed under v1
  kms.setLatest("v2");
  provider.rotate(); // current = v2
  log.append("payment.settled", { intentId: "a" }, TS(1)); // signed under v2

  assert.equal(log.entries()[0].keyVersion, "v1");
  assert.equal(log.entries()[1].keyVersion, "v2");

  const persisted = roundTrip(log.entries());

  // same provider (its cache resolves both versions) verifies the rotated chain
  assert.equal(new AuditLog(provider, persisted).verify().valid, true);

  // offline verify with a key ring built from the two versions (no live KMS)
  const offline = new AuditLog(
    keyRingProvider({ version: "v2", material: Buffer.from("key-two") }, [
      { version: "v1", material: Buffer.from("key-one") },
    ]),
    persisted,
  );
  assert.equal(offline.verify().valid, true);

  // tampering the v1 entry's payload breaks verification
  const tampered = persisted.map((e, i) =>
    i === 0 ? { ...e, payload: { intentId: "EVIL" } } : e,
  );
  assert.equal(new AuditLog(provider, tampered).verify().valid, false);

  // a ring missing the v1 key cannot verify the v1 entry
  const missingV1 = new AuditLog(
    keyRingProvider({ version: "v2", material: Buffer.from("key-two") }),
    persisted,
  );
  const r = missingV1.verify();
  assert.equal(r.valid, false);
  assert.equal(r.brokenAt, 0);
});

test("provider mode can verify a legacy (no-keyVersion) seed via legacyKey", () => {
  const legacy = new AuditLog("old-key");
  legacy.append("gate.decision", { intentId: "old" }, TS(0));
  const seed = roundTrip(legacy.entries());

  // continue under a versioned provider, supplying the old key for the pre-rotation entry
  const withLegacy = new AuditLog(staticKeyProvider("new-key", "v2"), seed, { legacyKey: "old-key" });
  assert.equal(withLegacy.verify().valid, true);

  // without legacyKey, the no-version entry can't be resolved -> fails closed
  const noLegacy = new AuditLog(staticKeyProvider("new-key", "v2"), seed);
  assert.equal(noLegacy.verify().valid, false);
});
