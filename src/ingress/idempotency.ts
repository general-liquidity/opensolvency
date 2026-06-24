// Idempotency keys for the payment-intent endpoint. Networks retry; an agent may
// resubmit. Without a guard, a retried POST /payment-intent would create a SECOND
// intent and, if covered, settle twice. With an `Idempotency-Key` header, the
// first submission's result is recorded against the key and replayed verbatim on
// any retry — the gate runs exactly once per key.
//
// The mapping (key → intentId) is persisted in the store's operator meta, so it
// survives restarts and is shared with whatever store backs the executor. Pure
// helpers here; the ingress handler does the store I/O.

import type { Store } from "../core/store.ts";
import type { IntentStatus } from "../core/store.ts";

const PREFIX = "idem:";

/** The meta key under which a given idempotency key records its intent id. */
export function idempotencyMetaKey(key: string): string {
  return `${PREFIX}${key}`;
}

/** Map a stored intent's status to the same HTTP status the live path returns, so
 *  a replay is byte-identical to the original response's status. */
export function httpStatusForIntentStatus(status: IntentStatus): number {
  switch (status) {
    case "settled":
      return 200;
    case "pending":
      return 202;
    case "failed":
      return 502;
    default:
      return 403; // blocked
  }
}

export interface IdempotentReplay {
  status: number;
  body: {
    intentId: string;
    outcome: IntentStatus;
    reasons: string[];
    receiptId: string | null;
    verified: null;
    idempotentReplay: true;
  };
}

/** If this idempotency key was already used, rebuild the original response from
 *  the stored intent (so the retry returns the same outcome without re-running the
 *  gate). Returns null when the key is new. */
export function replayIfSeen(store: Store, key: string): IdempotentReplay | null {
  const priorId = store.getMeta(idempotencyMetaKey(key));
  if (!priorId) return null;
  const si = store.getIntent(priorId);
  if (!si) return null;
  return {
    status: httpStatusForIntentStatus(si.status),
    body: {
      intentId: si.intent.id,
      outcome: si.status,
      reasons: si.reasons,
      receiptId: si.receiptId,
      verified: null,
      idempotentReplay: true,
    },
  };
}

/** Record that this idempotency key produced this intent id (first submission). */
export function rememberKey(store: Store, key: string, intentId: string): void {
  store.setMeta(idempotencyMetaKey(key), intentId);
}
