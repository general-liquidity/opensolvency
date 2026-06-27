# Governed Wallet — the AgentWorth gate ABOVE the custody layer

A custody layer with native spend controls — **Coinbase CDP Spend Permissions**,
**AgentKit** actions, an ERC-4337 smart wallet — answers *can this key move this
money?* It does **not** answer *should this agent move this money, right now, under
the operator's standing authority?* If the wallet owns that decision, the wallet
**absorbs the governance gate** and the operator loses the single chokepoint AgentWorth
exists to defend.

The governed-wallet adapter inverts that: it puts `evaluateGate` **above** the
wallet. A spend is routed through the gate **first**; the live wallet call fires
**only** when the gate returns `auto_execute`. On `confirm_operator` / `block` the
money does not move — the caller gets the decision and routes to the operator.

This is a governance **wrapper**, not a rail. A rail *settles* an intent the gate
already authorized; the governed wallet *authorizes (or refuses)* a spend the
wallet itself will settle.

## The injected-execute seam

AgentWorth **cannot and must not** bundle a wallet SDK (no `@coinbase/cdp-sdk`, no AgentKit,
no viem). Like the World ID / AgentBook / SIWA verifiers, the live spend is an
**injected seam** the consumer wires:

```ts
import { governedWallet } from "@general-liquidity/agentworth/...";

const wallet = governedWallet({
  // The gate context (or a per-spend builder so spend history advances between calls).
  gate: buildGateContext,
  // The LIVE wallet call — fired ONLY on auto_execute. AgentWorth bundles none of this.
  execute: async (req, intent) => {
    const { transactionHash } = await cdpAccount.sendTransaction({
      to: req.to,
      value: req.amount,           // minor units
      network: req.network,
    });
    return { ref: transactionHash };
  },
});

const { decision, executed, receipt } = await wallet.spend({
  wallet: "0xAgentWallet",
  to: "0xVendor",
  amount: 40_00,                   // minor units, integer — never a float
  token: "USDC",
  network: "base",
  payeeClass: "saas",
  rationale: "monthly inference credits top-up",
});

if (decision.outcome === "confirm_operator") {
  // route to the operator — the seam did NOT run, executed === false
}
```

Without a covering mandate / under caps / clear of the deny-list, `executed` is
`false` and `receipt` is `null`: **AgentWorth never asserts a settlement it didn't authorize.**

## The structural request shape

`WalletSpendRequest` is SDK-free — `{ wallet, to, amount, token/currency, network,
rationale?, payeeClass?, payee? }`. `cdpSpendToIntent` maps it onto a `PaymentIntent`:

| Spend field            | Intent field        | Default                          |
| ---------------------- | ------------------- | -------------------------------- |
| `to`                   | `payee`             | —                                |
| `network`              | `payeeClass`        | `"wallet_spend"` if absent       |
| `token` / `currency`   | `currency`          | — (throws if both absent)        |
| —                      | `rail`              | `"onchain"` (a send is irreversible) |
| `rationale`            | `rationale`         | a default explanatory string     |

`now` is injected (no clock read in the kernel), so the mapping is deterministic and
replayable — the same discipline as the rest of AgentWorth.

## Why this is the #1 defense

The gate is a pure function over the **structured** intent and the **operator's**
mandate set. The wallet cannot mutate the mandates, the caps, or the deny-list, and a
prompt-injected "ignore the limit" never reaches the decision. By routing the spend
through `evaluateGate` before the seam, the operator's standing authority stays the
chokepoint — even when the underlying custody layer ships its own "spend controls."
