# Mandates

A `Mandate` is operator-granted, scoped, capped, expiring, revocable spend
authority — the only thing that authorizes an agent payment without a live human
confirm.

```
weekly groceries → class:groceries · GBP · card
  per-tx cap £500 · per-week cap £1000 · expires 2026-06-26
```

| Field | Meaning |
|---|---|
| `scope` | `{kind: "class", value}` or `{kind: "allowlist", values}` — who it can pay |
| `allowedRails` | which rails it authorizes (`card`, `checkout`, `onchain`) |
| `currency` | caps are measured in this currency (FX-converted if a rate exists) |
| `perTxCap` / `perPeriodCap` | hard ceilings (minor-units) per transaction / per period |
| `period` | `day` / `week` / `month` rolling window |
| `expiresAt` | after which it authorizes nothing |
| `status` | `active` / `revoked` |

Grant one with the CLI or SDK:

```bash
agentworth mandate grant --label groceries --class groceries --currency GBP \
    --rails card --per-tx 50000 --per-period 100000 --period week --expires-days 30
```

```ts
os.grantMandate({
  label: "groceries", scope: { kind: "class", value: "groceries" },
  currency: "GBP", allowedRails: ["card"],
  perTxCap: 500_00, perPeriodCap: 1000_00, period: "week", expiresInDays: 30,
});
```

Mandates have a lifecycle (amend / extend / templates) and can be revoked at any
time — a revoked or expired mandate authorizes nothing, so covered payments route to
the operator. **The deny-list and caps hold independently of trust:** a payee that
has earned auto-approval still cannot push past a cap or a hard deny rule.
