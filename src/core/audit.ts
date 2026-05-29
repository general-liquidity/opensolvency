// Tamper-evident audit log. Ported from Gordon's HMAC-SHA256 audit primitive,
// extended into a hash-LINKED chain (each entry commits to the previous entry's
// hash) so any post-hoc edit, insertion, or deletion breaks verification.
//
// Every gate decision and every settlement is appended here. The log is the
// single source of truth — there are no parallel observation stores
// (Gordon's /journal single-substrate discipline).

import { createHash, createHmac, timingSafeEqual } from "node:crypto";

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
  sig: string; // HMAC-SHA256(operatorKey, hash)
}

const GENESIS = "0".repeat(64);

/** Deterministic JSON: object keys sorted recursively so the hash is stable. */
function canonicalize(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
  const obj = value as Record<string, unknown>;
  const body = Object.keys(obj)
    .sort()
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

function signHash(hash: string, key: string): string {
  return createHmac("sha256", key).update(hash).digest("hex");
}

export interface VerifyResult {
  valid: boolean;
  /** seq of the first entry that failed verification, if any */
  brokenAt: number | null;
  reason: string | null;
}

export class AuditLog {
  readonly #key: string;
  readonly #entries: AuditEntry[] = [];

  constructor(operatorKey: string, seed: readonly AuditEntry[] = []) {
    if (!operatorKey) throw new Error("AuditLog requires a non-empty operator key");
    this.#key = operatorKey;
    this.#entries.push(...seed);
  }

  append(type: AuditEventType, payload: unknown, ts: string): AuditEntry {
    const seq = this.#entries.length;
    const prevHash = seq === 0 ? GENESIS : this.#entries[seq - 1].hash;
    const hash = hashEntry(seq, ts, type, payload, prevHash);
    const entry: AuditEntry = {
      seq,
      ts,
      type,
      payload,
      prevHash,
      hash,
      sig: signHash(hash, this.#key),
    };
    this.#entries.push(entry);
    return entry;
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
      const expectedSig = Buffer.from(signHash(e.hash, this.#key));
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
