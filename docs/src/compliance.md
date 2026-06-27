# Compliance-grade reporting (EU AI Act Article 26)

AgentWorth's signed audit chain is not just tamper-evidence — it is the evidentiary
substrate for **deployer-oversight reporting**. Article 26 of the EU AI Act puts
obligations on the *deployer* of a high-risk AI system (here: the operator running an
agent that spends money). `deployerOversightReport` projects the audit chain + the
mandate set into those obligations, and `exportCompliancePackage` bundles the proof a
regulator or auditor can re-verify offline.

Both are **pure** — no I/O, no clock. Everything is derived from entries the caller
already holds, and the integrity verdict reuses the same `AuditLog.verify()` as the
rest of the kernel. There is no second hashing implementation to drift out of sync.

## The report

```ts
import { AgentWorth } from "@general-liquidity/agentworth";
import { deployerOversightReport } from "@general-liquidity/agentworth/compliance";

const os = new AgentWorth();
// … grant mandates, run the agent through the gate …

const report = deployerOversightReport({
  audit: os.auditTimeline(),
  mandates: os.listMandates(),
  integrity: os.verifyAudit(), // injected — the module never re-hashes
  period: { start: "2026-06-01T00:00:00.000Z", end: "2026-07-01T00:00:00.000Z" },
});
```

The report maps one-to-one onto the Article 26 obligations:

| Section | Obligation | What it carries |
|---|---|---|
| `humanOversight` | Art. 26(1)/(2) — human oversight | Spend split into **auto-executed** (under a mandate, no live human), **operator-confirmed** (the gate parked it, a human approved), and **blocked** (structurally refused), each with a count + per-currency total. Plus the **deny-list** hits and reasons — the non-overridable floor. |
| `monitoring` | Art. 26(5) — monitoring | Mandates granted / revoked in the window, mandates active at period end, and the realized settled spend (per currency). |
| `recordKeeping` | Art. 26(6) — record-keeping | Total + in-period entry counts and the chain **integrity verdict**. |

Classification keys off the signed `gate.decision` entries (which carry both the
outcome and the intent amount); settlement totals come from `payment.settled`, the
authoritative record that money actually moved. Money is summed **per currency** —
the report never cross-currency-adds.

## The compliance package

For an external auditor, bundle the chain + report + an integrity proof, then let them
re-verify it standalone with the operator key:

```ts
import {
  exportCompliancePackage,
  verifyCompliancePackage,
} from "@general-liquidity/agentworth/compliance";

const pkg = exportCompliancePackage({
  entries: os.auditTimeline(),
  mandates: os.listMandates(),
  period: { start: "2026-06-01T00:00:00.000Z", end: "2026-07-01T00:00:00.000Z" },
  operatorKey: process.env.AGENTWORTH_AUDIT_KEY!,
});

// … hand `pkg` to the auditor …

const v = verifyCompliancePackage(pkg, process.env.AGENTWORTH_AUDIT_KEY!);
// v.valid === true   only when the bundled chain re-verifies AND the integrity
//                    proof (tip, entry count, verdict) matches what the chain says
```

`verifyCompliancePackage` re-parses and re-verifies the bundled chain (reusing
`verifyAuditExport`), then confirms the package's own integrity proof is internally
consistent. A tampered chain, a swapped report, or a forged "still valid" verdict all
fail.

## Honest scope

- Signatures are HMAC (symmetric): the package proves integrity to a holder of the
  operator key (the operator, or an auditor they share it with), not publicly.
  Asymmetric (Ed25519) signing for public verifiability is the same future enhancement
  noted for the base audit export.
- The report is a faithful projection of what the gate recorded — it does not assert
  legal sufficiency. It gives a regulator the structured, replayable evidence the
  Article 26 obligations call for; the legal mapping is the deployer's to make with
  counsel.
