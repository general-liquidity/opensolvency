# AP2 interop

The **Agent Payments Protocol** ([AP2](https://github.com/google-agentic-commerce/ap2),
google-agentic-commerce) carries spend authorization between agents as three
mandates passed in A2A Message DataParts:

| AP2 mandate     | What it is                                              |
| --------------- | ------------------------------------------------------- |
| `IntentMandate` | The user's coarse intent ("buy running shoes under $80") |
| `CartMandate`   | A specific merchant cart, signed by the merchant         |
| `PaymentMandate`| The binding of a cart to a payment method (a VP)         |

AgentWorth is the **policy engine behind AP2 authorization**. AP2 says *what* the
agent wants to buy and *who* signed the cart; AgentWorth's gate decides *whether
the agent may pay autonomously* — under the operator's mandates, caps, deny-list,
and risk. The `src/ap2` module is the seam: it maps AP2 shapes to AgentWorth shapes and
calls the existing `evaluateGate`. It re-implements no policy.

```
AP2 CartMandate ──cartMandateToIntent──▶ AgentWorth PaymentIntent ──evaluateGate──▶ GateDecision
                                                              (auto_execute / confirm_operator / block)
```

## The IntentMandate is coarser than an AgentWorth Mandate

An AP2 `IntentMandate` carries **no amount caps** — it has `merchants`, `skus`,
`requires_refundability`, and an `intent_expiry`, but nothing like AgentWorth's `perTxCap`
/ `perPeriodCap`. So the two maps are asymmetric:

- `mandateToIntentMandate(m)` — drops the caps (there's no field for them). The
  allowlist scope becomes `merchants`; a class scope becomes `merchants: null`.
- `intentMandateToMandate(im, opts)` — the **caller supplies** `perTxCap`,
  `perPeriodCap`, `period`, `currency`, and `allowedRails` via `opts`, because AP2
  doesn't carry them. The `merchants` list becomes an `allowlist` scope; an absent
  list becomes a `class` scope (`opts.payeeClass ?? "ap2"`).

This is by design: AP2 expresses intent, AgentWorth expresses bounded authority.

## Money: major units → minor units

AgentWorth money is **integer minor-units** (cents, satoshis). W3C
`PaymentCurrencyAmount.value` (used in AP2's `PaymentRequest`) is a **major-unit
number** (e.g. `12.50` dollars). `cartTotal` / `cartMandateToIntent` convert with
an injectable `minorUnitsPerMajor` (default `100`, rounding to the nearest minor
unit). For a zero-decimal currency like JPY, pass `minorUnitsPerMajor: 1`.

## CartMandate verification

`verifyCartMandate(cart, { resolveKey, now?, canonicalize? })` is a best-effort
merchant-signature check over the cart's `merchant_authorization` JWT:

1. parse the compact JWS (`header.payload.sig`), read `alg`/`kid`/`iss`;
2. resolve the merchant's key (`resolveKey`) and verify the signature with
   `node:crypto` — **EdDSA / ES256 / RS256** are accepted (the `alg` header chooses);
3. enforce the `exp`/`iat` window (with a small skew tolerance);
4. recompute `cart_hash` over the canonical `CartContents` and compare to the
   signed `cart_hash` claim.

The result reports `ok`, `cartHashOk` (independent of signature validity, so a
tampered cart is visible even before the key resolves), the `reason`, and the
decoded `claims`. An **unsigned cart** (`merchant_authorization: null`) is
`{ ok: false, cartHashOk: false }` — AP2 leaves the field optional; AgentWorth treats
unsigned as unverified, never authorized.

### Canonicalization assumption (cart_hash)

**AP2 does not specify the canonical-JSON algorithm for `cart_hash`.** AgentWorth
chooses **RFC 8785 JCS** (reusing the `canonicalize` from
`@general-liquidity/agent-disclosure`, so AgentWorth and ADP agree on the canonical form),
hashed with **SHA-256** (hex). If you interoperate with a merchant that hashes
differently, inject your own `canonicalize` via the option. The accepted signature
algorithms (`EdDSA`/`ES256`/`RS256`) are likewise a documented choice — AP2 does
not mandate a curve.

## PaymentMandate binding (structural only)

`verifyPaymentMandateBinding(pm, cart)` checks that a `PaymentMandate` is bound to
the `CartMandate` it settles. It is **structural, not cryptographic**:

- the **details-id linkage** — `payment_mandate_contents.payment_details_id` must
  equal `cart.contents.payment_request.details.id`;
- the **`transaction_data` hashes** — the KB-JWT's `transaction_data` array (decoded
  best-effort from the VP's last `~`-segment) must contain both
  `hash(CartMandate)` and `hash(payment_mandate_contents)`.

**Out of scope (delegated):** the VP's issuer/holder SD-JWT-VC signatures. Verifying
that the holder actually presented a valid credential is a VC-verifier concern; AgentWorth
verifies only the cart→payment binding + id linkage. Use a dedicated SD-JWT-VC
verifier for the cryptographic VP check.

## A2A tie-in

- `ap2AgentCardExtension(roles, opts?)` — builds the AgentCard capability extension
  with the AP2 extension URI
  (`https://github.com/google-agentic-commerce/ap2/tree/v0.1`) and the agent's
  roles (`merchant` / `shopper` / `credentials-provider` / `payment-processor`).
- `toAp2DataPart(kind, mandate)` / `readAp2Mandates(message)` — pack and unpack the
  three mandates into / out of A2A DataParts under their fixed keys:
  `ap2.mandates.IntentMandate`, `ap2.mandates.CartMandate`,
  `ap2.mandates.PaymentMandate`.

## Example

```ts
import {
  cartMandateToIntent,
  gateAp2Cart,
  verifyCartMandate,
} from "@general-liquidity/agentworth/ap2";

// 1. verify the merchant signed the cart (and it wasn't tampered)
const v = await verifyCartMandate(cart, { resolveKey: (h) => merchantKeys.get(h.kid) });
if (!v.ok) throw new Error(`untrusted cart: ${v.reason}`);

// 2. run the cart through the operator's gate
const { intent, decision } = gateAp2Cart({}, cart, gateContext, {
  id: "pi_1",
  payeeClass: "shopping",
  rail: "card",
  rationale: "agentic cart checkout",
  createdAt: new Date().toISOString(),
});

if (decision.outcome === "auto_execute") {
  // settle via the executor / a rail
} else {
  // confirm_operator → ask the operator; block → refuse
}
```

The same gate, deny-list, caps, and signed audit chain that govern a native AgentWorth
`PaymentIntent` govern an AP2-originated one — AP2 is just another front door.
