// AP2 — Agent Payments Protocol (https://ap2-protocol.org, Google + FIDO Alliance).
// AP2 is a TRUST/AUTHORIZATION layer, not a settlement rail: it produces SD-JWT
// "mandates" (verifiable credentials) that ride over whatever rail the Credential
// Provider / payment processor uses. Its v1 model has a Checkout Mandate and a
// Payment Mandate, each open (user-signed, constraint-bearing) or closed
// (agent-signed, bound to one transaction).
//
// THE RESONANCE: an AP2 *open* Payment Mandate carries `payment.amount_range`
// (per-tx cap), `payment.budget` (aggregate cap), `payment.allowed_payees`, and
// `payment.execution_date` (expiry) — which is exactly an AgentWorth Mandate.
// `mandateToAp2Constraints` makes that mapping concrete (interop: AgentWorth
// could issue AP2 open mandates from its own grants).
//
// This module models the mandate CONTENT + the constraint mapping (pure, tested).
// SD-JWT signing (ES256/ECDSA — NOT Ed25519, per spec) and presentation to the
// Credential Provider are the injected Ap2Client's job (see ap2Rail.ts).

import { createHash } from "node:crypto";
import type { Mandate, PaymentIntent } from "../../core/types.ts";

export interface Ap2Amount {
  amount: number; // minor units (ISO 4217) — matches our integer-minor-units
  currency: string;
}
export interface Ap2Merchant {
  id: string;
  name: string;
  website?: string;
}
export interface Ap2PaymentInstrument {
  id: string;
  type: string; // "card" | "UPI" | …
  description?: string;
}

/** The closed Payment Mandate content (vct "mandate.payment.1"). `transaction_id`
 * (the base64url hash of the merchant's checkout_jwt) is the binding to the
 * checkout; the Ap2Client fills it once it has assembled/known the checkout. */
export interface Ap2PaymentMandateContent {
  vct: "mandate.payment.1";
  transaction_id?: string;
  payee: Ap2Merchant;
  payment_amount: Ap2Amount;
  payment_instrument: Ap2PaymentInstrument;
  execution_date?: string; // ISO8601; absent ⇒ immediate
  risk_data?: Record<string, unknown>;
  iat?: number;
  exp?: number;
}

export interface Ap2PaymentReceipt {
  status: "Success" | "Error";
  iss: string;
  iat: number;
  reference: string; // hash binding to the closed mandate
  payment_id: string;
  psp_confirmation_id?: string;
  network_confirmation_id?: string;
  error?: string;
  error_description?: string;
}

/** AP2 open-mandate constraints (the typed authorization set). */
export type Ap2Constraint =
  | { type: "payment.amount_range"; currency: string; max: number; min?: number }
  | { type: "payment.budget"; currency: string; max: number }
  | { type: "payment.allowed_payees"; payees: Ap2Merchant[] }
  | { type: "payment.execution_date"; not_before?: string; not_after?: string };

export interface BuildMandateOptions {
  instrument: Ap2PaymentInstrument;
  executionDate?: string;
  iatSeconds?: number;
  expSeconds?: number;
}

/** Build the Payment Mandate content from an AgentWorth PaymentIntent. The
 * binding (`transaction_id`) is added later by the client via bindTransactionId. */
export function buildPaymentMandateContent(
  intent: PaymentIntent,
  opts: BuildMandateOptions,
): Ap2PaymentMandateContent {
  return {
    vct: "mandate.payment.1",
    payee: { id: intent.payee, name: intent.payee },
    payment_amount: { amount: intent.amount, currency: intent.currency },
    payment_instrument: opts.instrument,
    execution_date: opts.executionDate,
    iat: opts.iatSeconds,
    exp: opts.expSeconds,
  };
}

/** transaction_id = base64url( hash(checkout_jwt) ) — the Payment↔Checkout binding. */
export function bindTransactionId(checkoutJwt: string): string {
  return createHash("sha256").update(checkoutJwt).digest("base64url");
}

/** AgentWorth Mandate → AP2 open Payment Mandate constraints. This is the exact
 * correspondence: caps, payees, and expiry are the same authorization primitives. */
export function mandateToAp2Constraints(m: Mandate): Ap2Constraint[] {
  const constraints: Ap2Constraint[] = [
    { type: "payment.amount_range", currency: m.currency, max: m.perTxCap },
    { type: "payment.budget", currency: m.currency, max: m.perPeriodCap },
    { type: "payment.execution_date", not_after: m.expiresAt },
  ];
  if (m.scope.kind === "allowlist") {
    constraints.push({
      type: "payment.allowed_payees",
      payees: m.scope.values.map((id) => ({ id, name: id })),
    });
  }
  return constraints;
}
