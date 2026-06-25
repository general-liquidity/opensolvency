// The OpenSolvency-specific half: populate a vendor-neutral AgentDisclosure from
// the LIVE governance primitives. This is the part that does NOT lift into the
// standalone `agent-disclosure` repo - it IS the reference implementation that
// makes OpenSolvency a credible counterparty. Every field is derived from
// something real (the enforced gate, the granted mandates, the signed audit
// chain, a SpendTrust run), not asserted.

import { DEFAULT_DENY_RULES } from "../core/denyList.ts";
import { DEFAULT_GATE_CONFIG } from "../core/types.ts";
import { computePolicyHash, effectivePolicy } from "../core/enforcement.ts";
import type { Store } from "../core/store.ts";
import type { AuditLog } from "../core/audit.ts";
import type { TrustScore } from "../benchmark/spendTrust.ts";
import {
  sha256Hex,
  canonicalize,
  signDisclosure,
  generateAgentKeyPair,
  exportAgentKey,
  agentKeyFromPrivateHex,
  DISCLOSURE_SCHEMA_VERSION,
  type AgentKeyPair,
  type AgentDisclosure,
  type Constitution,
  type HardConstraint,
  type ToolInventory,
  type CapitalEnvelope,
  type DeploymentHistory,
  type RedTeamAttestation,
  type ModelIdentity,
  type FieldProvenance,
  type SignedDisclosure,
} from "@general-liquidity/agent-disclosure";

const GENESIS = "0".repeat(64);
const DEFAULT_VALIDITY_MS = 60 * 60 * 1000; // 1 hour

// The canonical OpenSolvency tool surface + its permission boundary: one gated
// money path, read-only introspection, operator-only controls the agent can't reach.
const DEFAULT_TOOL_INVENTORY: ToolInventory = {
  valuePath: "executor",
  tools: [
    { name: "pay", access: "gated", movesValue: true },
    { name: "list_mandates", access: "read_only", movesValue: false },
    { name: "pending", access: "read_only", movesValue: false },
    { name: "status", access: "read_only", movesValue: false },
    { name: "audit_verify", access: "read_only", movesValue: false },
    { name: "approve", access: "operator_only", movesValue: false },
    { name: "kill_switch", access: "operator_only", movesValue: false },
    { name: "refund", access: "operator_only", movesValue: false },
  ],
};

export interface BuildDisclosureDeps {
  store: Store;
  audit: AuditLog;
  /** the agent's signing identity - its public key is the agentId */
  agentKey: AgentKeyPair;
  /** the composed system prompt to fingerprint */
  systemPrompt: string;
  operator: {
    id: string;
    deniabilityBoundary: string;
    attestation?: { scheme: "AIP" | "VisaTAP" | "ERC8004" | "none"; level: "none" | "signed" | "registry_attested"; evidence?: string };
  };
  now: string;
  nonce: string;
  /** disclosure validity window (default 1h) */
  validityMs?: number;
  /** override the declared tool surface (default = the canonical OpenSolvency one) */
  toolInventory?: ToolInventory;
  /** a SpendTrust run to attest to (the red-team field) */
  spendTrust?: { corpus: { name: string; version: string }; result: TrustScore };
  /** the model the agent declares it runs on (the declarable half of the
   *  model-swap defense; runtime TEE attestation is the open P2 item) */
  model?: { name: string; identifier: string };
}

/** The Proof-of-Enforcement binding carried in the constitution: which policy
 *  the gate runs (`policyHash`) and the signed audit head it's anchored to
 *  (`auditAnchor`). `enforced: true` now MEANS this policyHash equals the one
 *  the recent signed audit entries ran under — a falsifiable claim, not a promise. */
export interface EnforcementBinding {
  policyHash: string;
  auditAnchor: string;
}

const PoE_EVIDENCE_PREFIX =
  "opensolvency-gate (evaluateGate over structured intent); poe=";

/** Encode the PoE binding into the schema-stable `enforcementEvidence` string.
 *  A nested constitution field cannot carry it on the wire yet: the published
 *  disclosure schema STRIPS unknown keys on parse, so a verifier that re-parses
 *  would canonicalize a different object and the signature would mismatch.
 *  `enforcementEvidence` is a declared field that survives parse, so the binding
 *  stays inside the SIGNED payload and round-trips for any verifier. */
function encodeEnforcementEvidence(binding: EnforcementBinding): string {
  return PoE_EVIDENCE_PREFIX + JSON.stringify(binding);
}

/** Recover the PoE binding from a constitution's `enforcementEvidence` — the
 *  field ADP's PoE verifier reads for `policyHash` + `auditAnchor`. */
export function decodeEnforcementBinding(
  constitution: Constitution,
): EnforcementBinding | null {
  const ev = constitution.enforcementEvidence;
  if (!ev?.startsWith(PoE_EVIDENCE_PREFIX)) return null;
  try {
    const parsed = JSON.parse(ev.slice(PoE_EVIDENCE_PREFIX.length)) as EnforcementBinding;
    if (typeof parsed.policyHash === "string" && typeof parsed.auditAnchor === "string") {
      return parsed;
    }
  } catch {
    return null;
  }
  return null;
}

function buildConstitution(deps: BuildDisclosureDeps, auditAnchor: string): Constitution {
  const hardConstraints: HardConstraint[] = DEFAULT_DENY_RULES.map((r) => ({
    id: r.id,
    description: r.reason,
    kind: "deny" as const,
  }));
  const parameters = {
    minRationaleChars: DEFAULT_GATE_CONFIG.minRationaleChars,
    velocityWindowMinutes: DEFAULT_GATE_CONFIG.velocityWindowMinutes,
    velocityMaxCount: DEFAULT_GATE_CONFIG.velocityMaxCount,
    anomalyMultiple: DEFAULT_GATE_CONFIG.anomalyMultiple,
  };
  const policyHash = computePolicyHash(
    effectivePolicy({
      store: deps.store,
      config: DEFAULT_GATE_CONFIG,
      denyRules: DEFAULT_DENY_RULES,
    }),
  );
  return {
    hardConstraints,
    parameters,
    digest: sha256Hex(canonicalize({ hardConstraints, parameters })),
    // OpenSolvency ENFORCES these: the gate is a pure function the agent cannot
    // override. This is the field that separates a disclosure from a promise.
    enforced: true,
    // Proof-of-Enforcement binding (policyHash + auditAnchor) — encoded into the
    // signed evidence so `enforced` is falsifiable by replay, not just asserted.
    enforcementEvidence: encodeEnforcementEvidence({ policyHash, auditAnchor }),
  };
}

function buildCapital(store: Store): CapitalEnvelope {
  const mandates = store.listMandates().map((m) => ({
    label: m.label,
    scope: m.scope.kind === "class" ? `class:${m.scope.value}` : `allowlist:${m.scope.values.length}`,
    currency: m.currency,
    perTxCapMinor: m.perTxCap,
    perPeriodCapMinor: m.perPeriodCap,
    period: m.period,
    allowedRails: [...m.allowedRails],
    expiresAt: m.expiresAt,
  }));
  return { mandates, custody: "non_custodial" };
}

function buildHistory(audit: AuditLog): DeploymentHistory {
  const entries = audit.entries();
  const head = entries.length ? entries[entries.length - 1].hash : GENESIS;
  let totalDecisions = 0;
  let settledCount = 0;
  let blockedCount = 0;
  for (const e of entries) {
    if (e.type === "gate.decision") {
      totalDecisions++;
      const outcome = (e.payload as { outcome?: string } | undefined)?.outcome;
      if (outcome === "block") blockedCount++;
    } else if (e.type === "payment.settled") {
      settledCount++;
    }
  }
  return {
    chainAnchor: head,
    summary: {
      totalDecisions,
      settledCount,
      blockedCount,
      firstSeen: entries[0]?.ts,
      lastActive: entries[entries.length - 1]?.ts,
    },
    verificationHint: "verify the exported chain with verifyAuditExport(dump, operatorKey)",
  };
}

function buildRedTeam(
  input: NonNullable<BuildDisclosureDeps["spendTrust"]>,
  now: string,
): RedTeamAttestation {
  const r = input.result;
  return {
    corpus: input.corpus,
    result: {
      grade: r.grade,
      score: r.score,
      passed: !r.hardFail,
      hardFails: r.hardFail ? r.violations : [],
    },
    attestedAt: now,
  };
}

function buildModel(input: NonNullable<BuildDisclosureDeps["model"]>): ModelIdentity {
  return { name: input.name, fingerprintAlgorithm: "sha256", digest: sha256Hex(input.identifier) };
}

// Each field stamped with how it was derived, so a verifier can WEIGHT claims:
// a field bound to the enforced gate or the signed chain is worth more than a
// self-asserted one. `attestedBy` is set only where the source is itself attested.
function buildProvenance(deps: BuildDisclosureDeps): Record<string, FieldProvenance> {
  const p: Record<string, FieldProvenance> = {
    systemPrompt: { derivedFrom: "persona (sha256 of composed system prompt)" },
    constitution: { derivedFrom: "opensolvency-gate (DEFAULT_DENY_RULES + gate config)", attestedBy: "opensolvency-gate" },
    tools: { derivedFrom: "agent tool surface + permission boundary" },
    capital: { derivedFrom: "mandate store (operator-granted)" },
    operator: { derivedFrom: "operator configuration" },
    history: { derivedFrom: "signed hash-linked audit chain", attestedBy: "audit-chain" },
  };
  if (deps.spendTrust) p.redTeam = { derivedFrom: "spendtrust adversarial corpus", attestedBy: "spendtrust" };
  if (deps.model) p.model = { derivedFrom: "operator-declared model identity" };
  return p;
}

/** Build the disclosure document from the live OpenSolvency runtime. */
export function buildAgentDisclosure(deps: BuildDisclosureDeps): AgentDisclosure {
  const agentId = deps.agentKey.publicKeyHex;
  const validUntil = new Date(Date.parse(deps.now) + (deps.validityMs ?? DEFAULT_VALIDITY_MS)).toISOString();
  const history = buildHistory(deps.audit);
  return {
    version: DISCLOSURE_SCHEMA_VERSION,
    disclosureId: `disc_${sha256Hex(agentId + deps.nonce + deps.now).slice(0, 16)}`,
    agentId,
    issuedAt: deps.now,
    validUntil,
    nonce: deps.nonce,
    auditAnchor: history.chainAnchor,
    systemPrompt: { algorithm: "sha256", digest: sha256Hex(deps.systemPrompt) },
    constitution: buildConstitution(deps, history.chainAnchor),
    tools: deps.toolInventory ?? DEFAULT_TOOL_INVENTORY,
    capital: buildCapital(deps.store),
    operator: {
      operatorId: deps.operator.id,
      attestation: deps.operator.attestation ?? { scheme: "none", level: "none" },
      deniabilityBoundary: deps.operator.deniabilityBoundary,
    },
    history,
    redTeam: deps.spendTrust ? buildRedTeam(deps.spendTrust, deps.now) : undefined,
    model: deps.model ? buildModel(deps.model) : undefined,
    provenance: buildProvenance(deps),
  };
}

/** Build + sign in one call - the end-to-end "emit a verifiable disclosure" path. */
export function buildAndSignDisclosure(deps: BuildDisclosureDeps): SignedDisclosure {
  return signDisclosure(buildAgentDisclosure(deps), deps.agentKey);
}

const DISCLOSURE_KEY_META = "disclosure_key";

/** Load the agent's stable signing identity from the store, minting + persisting one
 *  on first use. The private key lives in operator-only meta (never an agent tool),
 *  so the agentId is the same across restarts - which is what makes a counterparty's
 *  reputation of the agent meaningful over time. */
export function loadOrCreateAgentKey(store: Store): AgentKeyPair {
  const stored = store.getMeta(DISCLOSURE_KEY_META);
  if (stored) return agentKeyFromPrivateHex(stored);
  const key = generateAgentKeyPair();
  store.setMeta(DISCLOSURE_KEY_META, exportAgentKey(key));
  return key;
}
