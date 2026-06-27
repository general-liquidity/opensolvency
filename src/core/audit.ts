// Tamper-evident audit log. Ported from Gordon's HMAC-SHA256 audit primitive,
// extended into a hash-LINKED chain (each entry commits to the previous entry's
// hash) so any post-hoc edit, insertion, or deletion breaks verification.
//
// Every gate decision and every settlement is appended here. The log is the
// single source of truth — there are no parallel observation stores
// (Gordon's /journal single-substrate discipline).

import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import type { KeyProvider } from "./keyCustody.ts";

export type AuditEventType =
  | "mandate.granted"
  | "mandate.revoked"
  | "mandate.amended"
  | "gate.decision"
  | "payment.settled"
  | "payment.verified"
  | "payment.failed"
  | "payment.refunded"
  | "payment.halted" // kill switch or circuit breaker
  // earning side (the agent as a paid service)
  | "earning.quoted"
  | "earning.received"
  | "earning.rejected";

export interface AuditEntry {
  seq: number;
  ts: string; // ISO — injected by the caller
  type: AuditEventType;
  payload: unknown;
  prevHash: string; // hash of seq-1, or GENESIS for the first entry
  hash: string; // sha256 over (seq, ts, type, canonical(payload), prevHash)
  sig: string; // HMAC-SHA256(signing key, hash)
  /** the key version that signed this entry (rotation). Absent on legacy
   *  single-key chains, which verify under the one base key. Not part of `hash`
   *  (the signature already binds it via the key used), so adding it is
   *  backward-compatible with existing persisted chains. */
  keyVersion?: string;
}

const GENESIS = "0".repeat(64);

/** Deterministic JSON: object keys sorted recursively so the hash is stable.
 * Values JSON persistence drops from objects are omitted here too, and values it
 * converts to null inside arrays are normalized the same way. */
function canonicalize(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value) ?? "null";
  }
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
  const obj = value as Record<string, unknown>;
  const body = Object.keys(obj)
    .sort()
    .filter((k) => {
      const type = typeof obj[k];
      return type !== "undefined" && type !== "function" && type !== "symbol";
    })
    .map((k) => `${JSON.stringify(k)}:${canonicalize(obj[k])}`)
    .join(",");
  return `{${body}}`;
}

function hashEntry(
  seq: number,
  ts: string,
  type: AuditEventType,
  payload: unknown,
  prevHash: string,
): string {
  return createHash("sha256")
    .update(`${seq}\n${ts}\n${type}\n${canonicalize(payload)}\n${prevHash}`)
    .digest("hex");
}

function signHash(hash: string, key: string | Buffer): string {
  return createHmac("sha256", key).update(hash).digest("hex");
}

export interface VerifyResult {
  valid: boolean;
  /** seq of the first entry that failed verification, if any */
  brokenAt: number | null;
  reason: string | null;
}

export class AuditLog {
  readonly #sign: () => { material: string | Buffer; version: string | undefined };
  readonly #resolveKey: (version: string | undefined) => string | Buffer;
  readonly #entries: AuditEntry[] = [];

  /**
   * Sign the chain with EITHER a single operator key (string — the default,
   * unchanged behaviour: no per-entry key version) OR a versioned `KeyProvider`
   * for rotation. In provider mode each append is signed with the provider's
   * current key and stamped with its `keyVersion`, and `verify()` resolves each
   * entry's key by that version — so rotating the key never breaks replay of
   * entries signed under an older version. `legacyKey` lets a provider-mode log
   * verify pre-rotation entries that carry no keyVersion (signed under the old
   * single key), for an in-place migration.
   */
  constructor(
    signing: string | KeyProvider,
    seed: readonly AuditEntry[] = [],
    opts: { legacyKey?: string } = {},
  ) {
    if (typeof signing === "string") {
      if (!signing) throw new Error("AuditLog requires a non-empty operator key");
      this.#sign = () => ({ material: signing, version: undefined });
      this.#resolveKey = () => signing; // one key for every entry
    } else {
      // Query the provider on EACH append, so a mid-chain `rotate()` is picked up
      // (capturing the key once at construction would sign post-rotation entries
      // with the stale version).
      this.#sign = () => {
        const cur = signing.current();
        return { material: cur.material, version: cur.version };
      };
      this.#resolveKey = (version) => {
        if (version === undefined) {
          if (opts.legacyKey) return opts.legacyKey;
          throw new Error("entry has no keyVersion and no legacyKey was provided");
        }
        return signing.resolve(version).material;
      };
    }
    this.#entries.push(...seed);
  }

  append(type: AuditEventType, payload: unknown, ts: string): AuditEntry {
    const seq = this.#entries.length;
    const prevHash = seq === 0 ? GENESIS : this.#entries[seq - 1].hash;
    const hash = hashEntry(seq, ts, type, payload, prevHash);
    const { material, version } = this.#sign();
    const entry: AuditEntry = {
      seq,
      ts,
      type,
      payload,
      prevHash,
      hash,
      sig: signHash(hash, material),
      ...(version !== undefined ? { keyVersion: version } : {}),
    };
    this.#entries.push(entry);
    return entry;
  }

  /**
   * Append a `gate.decision` entry that BINDS the decision to the policy it ran
   * under: `policyHash` is folded into the signed payload, so the existing entry
   * hash + signature + chain link already cover it. The chain therefore proves
   * not just WHAT each decision was, but WHICH policy it was evaluated against
   * (Proof-of-Enforcement). The merge never overwrites a payload's own keys.
   */
  appendGateDecision(
    payload: Record<string, unknown>,
    policyHash: string,
    ts: string,
  ): AuditEntry {
    return this.append("gate.decision", { ...payload, policyHash }, ts);
  }

  entries(): readonly AuditEntry[] {
    return this.#entries;
  }

  /** Recompute the whole chain: link integrity + signature on every entry. */
  verify(): VerifyResult {
    let prevHash = GENESIS;
    for (const e of this.#entries) {
      if (e.prevHash !== prevHash) {
        return { valid: false, brokenAt: e.seq, reason: "broken chain link" };
      }
      const expectedHash = hashEntry(e.seq, e.ts, e.type, e.payload, e.prevHash);
      if (expectedHash !== e.hash) {
        return { valid: false, brokenAt: e.seq, reason: "content hash mismatch" };
      }
      let key: string | Buffer;
      try {
        key = this.#resolveKey(e.keyVersion);
      } catch (err) {
        return {
          valid: false,
          brokenAt: e.seq,
          reason: `key resolution failed: ${err instanceof Error ? err.message : String(err)}`,
        };
      }
      const expectedSig = Buffer.from(signHash(e.hash, key));
      const actualSig = Buffer.from(e.sig);
      if (
        expectedSig.length !== actualSig.length ||
        !timingSafeEqual(expectedSig, actualSig)
      ) {
        return { valid: false, brokenAt: e.seq, reason: "signature mismatch" };
      }
      prevHash = e.hash;
    }
    return { valid: true, brokenAt: null, reason: null };
  }
}
