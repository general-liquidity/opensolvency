import { test } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";

import {
  EnvKeyProvider,
  KmsKeyProvider,
  KeyRing,
  type KmsClient,
  type VersionedKey,
} from "../src/core/keyCustody.ts";

// Sign a fixed message with a key's material, the way audit.ts does locally —
// proves "old version still verifies prior data" without standing up AuditLog.
const sign = (k: VersionedKey, msg: string): string =>
  createHmac("sha256", k.material).update(msg).digest("hex");

test("EnvKeyProvider yields a stable, single-version key", () => {
  const p = new EnvKeyProvider({ env: { OPENSOLVENCY_AUDIT_KEY: "secret" } });
  const a = p.current();
  const b = p.current();
  assert.equal(a.version, "env-1");
  assert.equal(a.material.toString("utf8"), "secret");
  assert.deepEqual(a.material, b.material); // stable
  // resolve only knows its own version
  assert.deepEqual(p.resolve("env-1").material, a.material);
  assert.throws(() => p.resolve("env-2"), /unknown key version/);
});

test("EnvKeyProvider fails safe when the env var is unset", () => {
  assert.throws(() => new EnvKeyProvider({ env: {} }), /refusing to sign audit/);
});

test("rotation produces a new version while the old version still verifies prior data", () => {
  // A tiny in-memory KMS with two versions of the key.
  const store: Record<string, Buffer> = {
    v1: Buffer.from("key-material-one"),
    v2: Buffer.from("key-material-two"),
  };
  let latest = "v1";
  const client: KmsClient = {
    getKey(_keyId, version) {
      const v = version ?? latest;
      const material = store[v];
      if (!material) throw new Error(`no such version ${v}`);
      return { version: v, material };
    },
  };

  const p = new KmsKeyProvider({ client, keyId: "audit" });
  assert.equal(p.current().version, "v1");

  // Sign some "prior data" under v1.
  const priorSig = sign(p.current(), "entry-0");

  // Operator rotates the KMS key; provider pulls the new version.
  latest = "v2";
  const newVersion = p.rotate();
  assert.equal(newVersion, "v2");
  assert.equal(p.current().version, "v2");
  assert.notDeepEqual(p.current().material, store.v1);

  // New data signs under v2…
  const newSig = sign(p.current(), "entry-1");
  assert.notEqual(newSig, priorSig);

  // …and the OLD version still resolves + verifies the prior data (replay intact).
  const old = p.resolve("v1");
  assert.equal(old.version, "v1");
  assert.equal(sign(old, "entry-0"), priorSig);
});

test("KmsKeyProvider with a fake injected client returns the key", () => {
  const client: KmsClient = {
    getKey: (keyId, version) => {
      assert.equal(keyId, "audit-key-id");
      return { version: version ?? "kms-7", material: Buffer.from("from-kms") };
    },
  };
  const p = new KmsKeyProvider({ client, keyId: "audit-key-id" });
  assert.equal(p.current().version, "kms-7");
  assert.equal(p.current().material.toString("utf8"), "from-kms");
});

test("KmsKeyProvider with NO client fails safe (never signs)", () => {
  assert.throws(
    () => new KmsKeyProvider({ client: null, keyId: "audit" }),
    /no KmsClient injected/,
  );
  assert.throws(
    () => new KmsKeyProvider({ client: undefined, keyId: "audit" }),
    /no KmsClient injected/,
  );
});

test("KmsKeyProvider rejects empty key material from the KMS", () => {
  const client: KmsClient = {
    getKey: () => ({ version: "v1", material: Buffer.alloc(0) }),
  };
  assert.throws(() => new KmsKeyProvider({ client, keyId: "audit" }), /empty key material/);
});

test("KmsKeyProvider propagates an unreachable KMS (fail-safe, no fabrication)", () => {
  const client: KmsClient = {
    getKey: () => {
      throw new Error("KMS unreachable");
    },
  };
  assert.throws(() => new KmsKeyProvider({ client, keyId: "audit" }), /KMS unreachable/);
});

test("KeyRing resolves historical versions and reports unknown ones", () => {
  const ring = new KeyRing([
    { version: "v1", material: Buffer.from("one") },
    { version: "v2", material: Buffer.from("two") },
  ]);
  assert.deepEqual(ring.versions().sort(), ["v1", "v2"]);
  assert.equal(ring.has("v1"), true);
  assert.equal(ring.has("v9"), false);
  assert.equal(ring.resolve("v2").material.toString("utf8"), "two");
  assert.throws(() => ring.resolve("v9"), /no key for version/);

  // A persisted chain referencing v1 still verifies after rotation to v2.
  const sigV1 = sign(ring.resolve("v1"), "old-entry");
  ring.add({ version: "v3", material: Buffer.from("three") }); // rotation continues
  assert.equal(sign(ring.resolve("v1"), "old-entry"), sigV1);
});
