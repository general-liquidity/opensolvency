# Security & compliance

The security model *is* the product. The full posture (and the honest gaps) lives in
[`SECURITY.md`](https://github.com/general-liquidity/opensolvency/blob/main/SECURITY.md);
the highlights:

- **Deny-first gate** over structured data — injection-resistant, fuzz-verified.
- **Single money path** — the executor; no surface adds authority.
- **Tamper-evident audit** — a hash-linked, HMAC-signed chain. Export it and verify
  standalone:

  ```bash
  opensolvency audit export > chain.jsonl
  opensolvency audit verify-export chain.jsonl
  ```

- **Non-custodial** — execution runs through the operator's own accounts; the system
  never holds funds.
- **Pluggable key custody** — the audit key comes from env / KMS / Vault with
  rotation, never the database.
- **Sanctions / AML** screening wired into the deny-list + risk classifier.
- **Multi-tenant isolation** — a separate store + audit chain per operator.

## Known gaps (honest)

- No third-party security audit yet (the load-bearing external step).
- Audit signatures are HMAC (symmetric) — integrity is provable to a key holder, not
  publicly; asymmetric (Ed25519) signing is planned.
- Live-rail webhook reconciliation is not wired (rail clients are operator-injected
  and fail safe).
