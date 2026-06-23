// Key custody for the audit-signing key. Ported posture: the audit chain is
// HMAC-SHA256-signed LOCALLY (see audit.ts `signHash`), so a provider's job is to
// yield the KEY MATERIAL — not to perform a remote sign. (If a future KMS does
// the HMAC itself, that would be a different `sign`-shaped seam; we deliberately
// keep the bytes-yielding shape because audit.ts hashes + HMACs in-process.)
//
// Why this exists: the signing key is currently a raw env var read straight into
// `new AuditLog(key)`. For production the key should be able to come from a KMS
// (AWS KMS / GCP KMS / Vault) with ROTATION, without dragging an AWS SDK into the
// repo — so the live KMS is an INJECTED seam (`KmsClient`), not a dependency.
//
// Rotation + versioning: each signing key has a `version`. The audit chain records
// which version signed each link (the wiring note adds `keyVersion` to AuditEntry),
// so verification can resolve the RIGHT historical key per entry — rotation never
// breaks replay of entries signed under an older key.
//
// Fail-safe invariant (mirrors the rails layer): a KMS provider with no client, or
// an unreachable one, THROWS. It never falls back to a fabricated/empty key — a
// money agent must never sign audit with a key it could not actually fetch.

/** A signing key plus the version under which it was issued. `material` is the
 * raw HMAC key bytes audit.ts feeds to `createHmac`. */
export interface VersionedKey {
  version: string;
  material: Buffer;
}

/** Yields the CURRENT audit-signing key (for new appends) and resolves any
 * HISTORICAL version (for verifying older entries). */
export interface KeyProvider {
  /** The key new audit entries should be signed with. */
  current(): VersionedKey;
  /** Resolve a specific version's key material — used by verification to pick the
   * key that actually signed a given entry. Throws if the version is unknown. */
  resolve(version: string): VersionedKey;
}

/** The injected KMS seam. The repo never talks to a cloud SDK directly: a caller
 * wires an adapter that satisfies this shape over AWS KMS / GCP KMS / Vault. */
export interface KmsClient {
  /** Fetch raw key bytes for `keyId` at `version` (latest when omitted). Must
   * return the version actually fetched, so the provider records it on the chain. */
  getKey(keyId: string, version?: string): { version: string; material: Buffer };
}

const utf8 = (s: string): Buffer => Buffer.from(s, "utf8");

/**
 * Reference provider: the CURRENT behavior, wrapped. Reads the key from an env
 * var (default `OPENSOLVENCY_AUDIT_KEY`). Single, fixed version — rotation under
 * env means issuing a new provider with a new version label.
 */
export class EnvKeyProvider implements KeyProvider {
  readonly #version: string;
  readonly #material: Buffer;

  constructor(opts: { env?: NodeJS.ProcessEnv; varName?: string; version?: string } = {}) {
    const env = opts.env ?? process.env;
    const varName = opts.varName ?? "OPENSOLVENCY_AUDIT_KEY";
    const raw = env[varName];
    if (!raw) {
      throw new Error(`EnvKeyProvider: ${varName} is unset — refusing to sign audit without a key`);
    }
    this.#version = opts.version ?? "env-1";
    this.#material = utf8(raw);
  }

  current(): VersionedKey {
    return { version: this.#version, material: this.#material };
  }

  resolve(version: string): VersionedKey {
    if (version !== this.#version) {
      throw new Error(`EnvKeyProvider: unknown key version "${version}"`);
    }
    return this.current();
  }
}

/**
 * KMS-backed provider. Fetches key bytes through the INJECTED `KmsClient` — no
 * cloud SDK in-repo. Fail-safe: no client (or a throwing/unreachable one) means
 * NO key, which means the audit log refuses to sign.
 *
 * Rotation: call `rotate()` to fetch the latest version from the KMS and make it
 * `current()`. Previously-fetched versions stay resolvable (cached) so old entries
 * keep verifying.
 */
export class KmsKeyProvider implements KeyProvider {
  readonly #client: KmsClient;
  readonly #keyId: string;
  readonly #cache = new Map<string, Buffer>();
  #currentVersion: string;

  constructor(opts: { client: KmsClient | null | undefined; keyId: string; version?: string }) {
    if (!opts.client) {
      // Fail-safe: surface the misconfiguration at construction, never sign blind.
      throw new Error("KmsKeyProvider: no KmsClient injected — refusing to sign audit");
    }
    if (!opts.keyId) throw new Error("KmsKeyProvider: keyId is required");
    this.#client = opts.client;
    this.#keyId = opts.keyId;
    const fetched = this.#fetch(opts.version);
    this.#currentVersion = fetched.version;
  }

  /** Fetch from the KMS and cache. A throwing client propagates — fail-safe. */
  #fetch(version?: string): VersionedKey {
    const { version: v, material } = this.#client.getKey(this.#keyId, version);
    if (!material || material.length === 0) {
      throw new Error(`KmsKeyProvider: KMS returned empty key material for version "${v}"`);
    }
    this.#cache.set(v, material);
    return { version: v, material };
  }

  /** Pull the latest key version from the KMS and make it current. Returns the new
   * version. Old versions remain resolvable for verifying historical entries. */
  rotate(): string {
    const next = this.#fetch();
    this.#currentVersion = next.version;
    return next.version;
  }

  current(): VersionedKey {
    const material = this.#cache.get(this.#currentVersion);
    if (!material) throw new Error("KmsKeyProvider: current key material missing");
    return { version: this.#currentVersion, material };
  }

  resolve(version: string): VersionedKey {
    const cached = this.#cache.get(version);
    if (cached) return { version, material: cached };
    // Not cached — try the KMS for this historical version (fail-safe on throw).
    return this.#fetch(version);
  }
}

/**
 * A read-only resolver over a fixed set of historical key versions. Built from a
 * provider (or an explicit map) so verification of a persisted chain can resolve
 * each entry's signing key WITHOUT a live provider — e.g. when re-verifying an
 * exported chain offline. Rotation doesn't break replay: every version a chain
 * references must exist in the ring.
 */
export class KeyRing {
  readonly #keys = new Map<string, Buffer>();

  constructor(keys: Iterable<VersionedKey> = []) {
    for (const k of keys) this.#keys.set(k.version, k.material);
  }

  /** Add (or replace) a version's material. */
  add(key: VersionedKey): this {
    this.#keys.set(key.version, key.material);
    return this;
  }

  /** True if the ring can resolve this version. */
  has(version: string): boolean {
    return this.#keys.has(version);
  }

  resolve(version: string): VersionedKey {
    const material = this.#keys.get(version);
    if (!material) throw new Error(`KeyRing: no key for version "${version}"`);
    return { version, material };
  }

  versions(): string[] {
    return [...this.#keys.keys()];
  }
}
