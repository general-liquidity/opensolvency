// Framework-agnostic gated-pay middleware — the one-line way for ANY agent
// framework to gate its spend. Every framework's "tool"/"function" abstraction
// reduces to: a name, a description, an input schema, and an async handler. This
// module provides exactly those, backed by the executor + gate, so an adapter for
// any framework is a thin wrapper (the AI SDK one ships in `./aiSdk.ts`; Mastra /
// LangChain / OpenAI Agents / CrewAI wrap `gatedPay` the same way — see the README).
//
// The handler routes through `executor.execute`, so the gate governs every call:
// it auto-executes inside a mandate, parks for operator approval, or blocks — and
// no prompt can override that (the gate reads structured numbers, not model text).

import { randomUUID } from "node:crypto";
import { PaymentIntentDraftSchema, type PaymentIntentDraft } from "../agent/schema.ts";
import { runPaymentToolCall } from "../agent/aiAgent.ts";
import type { Executor } from "../core/executor.ts";

export interface GatedPayDeps {
  executor: Executor;
  /** ISO clock; defaults to wall-clock. */
  clock?: () => string;
  /** Intent-id minter; defaults to `pi_<uuid>`. */
  newId?: () => string;
}

export interface GatedPayResult {
  intentId: string;
  /** "settled" | "pending" | "blocked" | "failed" */
  status: string;
  reasons: string[];
  receiptId: string | null;
}

/** The canonical tool name, description, and input schema — reuse these when
 *  wiring the handler into any framework so the surface is identical everywhere. */
export const GATED_PAY_NAME = "pay";
export const GATED_PAY_DESCRIPTION =
  "Make a payment. It is routed through the operator's governance gate and may be " +
  "auto-executed (inside a mandate), parked for operator approval, or blocked. " +
  "Amounts are integer minor-units (800 = £8.00). Never retry a blocked or pending " +
  "result — report it instead.";
export const gatedPayInputSchema = PaymentIntentDraftSchema;

/**
 * Run a payment draft through the gate and return a compact, framework-neutral
 * result. The only money path is `executor.execute`, so this cannot bypass the gate.
 */
export async function gatedPay(
  deps: GatedPayDeps,
  draft: PaymentIntentDraft,
): Promise<GatedPayResult> {
  const resolved = {
    executor: deps.executor,
    clock: deps.clock ?? (() => new Date().toISOString()),
    newId: deps.newId ?? (() => `pi_${randomUUID().slice(0, 8)}`),
  };
  const result = await runPaymentToolCall(draft, resolved);
  return {
    intentId: result.intentId,
    status: result.status,
    reasons: result.decision.reasons,
    receiptId: result.receipt?.id ?? null,
  };
}
