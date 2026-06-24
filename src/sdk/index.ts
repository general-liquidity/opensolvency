// The OpenSolvency SDK — the ergonomic, typed façade over the trust kernel.
//
// A host (a server, a bot, an agent loop) constructs one `OpenSolvency` with a
// Store (default: in-memory) and drives the whole governance plane in-process:
// grant mandates, submit payment intents THROUGH the gate, approve what the gate
// parked, and verify the signed audit chain. Every method delegates to the same
// executor / gate / store / audit the CLI uses — the gate is never bypassed.
//
// This is a library, not a CLI: it returns typed values, never prints.

import { randomUUID } from "node:crypto";
import { AuditLog } from "../core/audit.ts";
import type { AuditEntry, AuditEventType, VerifyResult } from "../core/audit.ts";
import { createExecutor, type ExecuteResult, type RefundResult } from "../core/executor.ts";
import { DEFAULT_DENY_RULES } from "../core/denyList.ts";
import { DEFAULT_GATE_CONFIG } from "../core/types.ts";
import { createMemoryStore } from "../store/memoryStore.ts";
import { createRailRegistry, type RailRegistry } from "../rails/registry.ts";
import { createFakeRail } from "../rails/fakeRail.ts";
import type { Store, StoredIntent } from "../core/store.ts";
import type {
  Attestation,
  DenyRule,
  GateConfig,
  Mandate,
  PaymentIntent,
  PayeeScope,
  Period,
  RailKind,
} from "../core/types.ts";

/** The mandate-granting input. The SDK fills `id`, `grantedAt`, `status`, and
 * resolves `expiresAt` from `expiresInDays` when an explicit instant isn't given. */
export interface GrantMandateInput {
  label: string;
  scope: PayeeScope;
  currency: string;
  allowedRails: RailKind[];
  perTxCap: number; // minor-units
  perPeriodCap: number; // minor-units
  period: Period;
  /** ISO instant the mandate dies. Provide this OR `expiresInDays`. */
  expiresAt?: string;
  /** Days from now until expiry (used only when `expiresAt` is absent). */
  expiresInDays?: number;
  /** Override the generated id (defaults to `m_<8 hex>`). */
  id?: string;
}

/** A payment the caller wants the agent to make. The SDK fills `id`, `createdAt`,
 * and defaults `payeeClass` to the payee when omitted. Goes THROUGH the gate. */
export interface PayInput {
  payee: string;
  amount: number; // minor-units, > 0
  currency: string;
  rail: RailKind;
  rationale: string; // >= gate's minRationaleChars
  /** The class the mandate scopes on (defaults to `payee`). */
  payeeClass?: string;
  /** Acting-agent identity level; feeds risk, never relaxes the floor. */
  attestation?: Attestation;
  /** Override the generated id (defaults to `pi_<8 hex>`). */
  id?: string;
  /** Override the createdAt timestamp (defaults to the SDK clock). */
  createdAt?: string;
}

export interface ApproveOptions {
  rationale: string;
  /** Challenge-response acknowledgement for high-risk / irreversible / large. */
  ack?: boolean;
}

export interface OpenSolvencyOptions {
  /** Persistence boundary. Defaults to a fresh in-memory store. */
  store?: Store;
  /** Audit-signing key. Defaults to the store's own operator key. */
  auditKey?: string;
  /** Rail registry. Defaults to in-process fake rails for every RailKind. */
  rails?: RailRegistry;
  /** Gate tuning. Defaults to DEFAULT_GATE_CONFIG. */
  config?: GateConfig;
  /** Hard deny-list. Defaults to DEFAULT_DENY_RULES. */
  denyRules?: DenyRule[];
  /** Injected clock. Defaults to wall-clock ISO. The kernel never reads a clock
   * itself, so a fixed clock makes the whole SDK deterministic for tests/replay. */
  clock?: () => string;
  /** Consecutive blocks/failures before the circuit breaker trips. */
  circuitBreakerThreshold?: number;
  /** Pending intents at/above this amount require challenge-response on approve. */
  challengeThresholdMinor?: number;
  /** Durability barrier awaited after each payment op (async stores wire their
   * `flush` here). Synchronous stores (memory/sqlite) leave it unset. */
  commit?: () => Promise<void>;
}

const DEFAULT_EXPIRY_DAYS = 30;

function defaultRails(): RailRegistry {
  return createRailRegistry([
    createFakeRail("card"),
    createFakeRail("checkout"),
    createFakeRail("onchain"),
  ]);
}

/**
 * The programmatic OpenSolvency façade. Wraps the executor + gate + store + audit
 * so any host can drive the governance plane in-process without re-implementing
 * the wiring the CLI does. The single invariant holds exactly as in the CLI:
 * `pay()` returns the gate's decision and only settles on `auto_execute`; nothing
 * here reaches a rail except through the gate.
 */
export class OpenSolvency {
  readonly store: Store;
  readonly audit: AuditLog;
  readonly rails: RailRegistry;
  readonly #clock: () => string;
  readonly #executor: ReturnType<typeof createExecutor>;

  constructor(options: OpenSolvencyOptions = {}) {
    this.store = options.store ?? createMemoryStore(options.auditKey);
    this.audit = new AuditLog(
      options.auditKey ?? this.store.operatorKey(),
      this.store.loadAudit(),
    );
    this.rails = options.rails ?? defaultRails();
    this.#clock = options.clock ?? (() => new Date().toISOString());
    this.#executor = createExecutor({
      store: this.store,
      rails: this.rails,
      audit: this.audit,
      config: options.config ?? DEFAULT_GATE_CONFIG,
      denyRules: options.denyRules ?? DEFAULT_DENY_RULES,
      clock: this.#clock,
      circuitBreakerThreshold: options.circuitBreakerThreshold,
      challengeThresholdMinor: options.challengeThresholdMinor,
      commit: options.commit,
    });
  }

  // --- Mandates (operator-granted spend authority) ---------------------------

  /** Grant a new mandate and record `mandate.granted` to the signed audit chain. */
  grantMandate(input: GrantMandateInput): Mandate {
    const now = this.#clock();
    const expiresAt =
      input.expiresAt ??
      new Date(
        Date.parse(now) + (input.expiresInDays ?? DEFAULT_EXPIRY_DAYS) * 86_400_000,
      ).toISOString();
    const mandate: Mandate = {
      id: input.id ?? `m_${randomUUID().slice(0, 8)}`,
      label: input.label,
      scope: input.scope,
      currency: input.currency,
      allowedRails: input.allowedRails,
      perTxCap: input.perTxCap,
      perPeriodCap: input.perPeriodCap,
      period: input.period,
      grantedAt: now,
      expiresAt,
      status: "active",
    };
    this.store.insertMandate(mandate);
    this.#record("mandate.granted", { id: mandate.id, label: mandate.label }, now);
    return mandate;
  }

  listMandates(): Mandate[] {
    return this.store.listMandates();
  }

  getMandate(id: string): Mandate | undefined {
    return this.store.getMandate(id);
  }

  /** Amend a mandate's caps / scope / expiry. Delegates to the executor so the
   * change lands as `mandate.amended` in the audit chain. */
  amendMandate(id: string, patch: Partial<Mandate>): void {
    this.#executor.amendMandate(id, patch);
  }

  /** Extend a mandate's expiry. Recorded as `mandate.amended`. */
  extendMandate(id: string, expiresAt: string): void {
    this.#executor.extendMandate(id, expiresAt);
  }

  /** Revoke a mandate and record `mandate.revoked`. A revoked mandate authorizes
   * nothing — subsequent covered payments route to the operator. */
  revokeMandate(id: string): void {
    this.store.revokeMandate(id);
    this.#record("mandate.revoked", { id }, this.#clock());
  }

  // --- Payments (always through the gate) ------------------------------------

  /** Submit a payment intent THROUGH the executor/gate. Returns the full
   * ExecuteResult whose `decision.outcome` is `auto_execute` (settled),
   * `confirm_operator` (parked pending), or `block` (refused). Never bypasses
   * the gate, even on auto-execute. */
  pay(input: PayInput): Promise<ExecuteResult> {
    const intent: PaymentIntent = {
      id: input.id ?? `pi_${randomUUID().slice(0, 8)}`,
      payee: input.payee,
      payeeClass: input.payeeClass ?? input.payee,
      amount: input.amount,
      currency: input.currency,
      rail: input.rail,
      rationale: input.rationale,
      createdAt: input.createdAt ?? this.#clock(),
    };
    return this.#executor.execute(intent, { attestation: input.attestation });
  }

  /** Intents the gate parked for operator confirmation. */
  pending(): StoredIntent[] {
    return this.store.listPendingIntents();
  }

  getIntent(id: string): StoredIntent | undefined {
    return this.store.getIntent(id);
  }

  /** Operator authorizes a parked intent. The gate is re-run on current state —
   * a hard block (deny-list/caps) cannot be approved away. High-risk /
   * irreversible / large intents need `ack: true` (challenge-response); without
   * it the result stays `pending` with a populated `challenge`. */
  approve(intentId: string, opts: ApproveOptions): Promise<ExecuteResult> {
    return this.#executor.approve(intentId, opts.rationale, { acknowledged: opts.ack === true });
  }

  /** Reverse a settled payment on a reversible rail and free the budget. An
   * irreversible refund is refused (a safety property, not a limitation). */
  refund(
    intentId: string,
    opts: { amountMinor?: number; reason?: string } = {},
  ): Promise<RefundResult> {
    return this.#executor.refund(intentId, opts);
  }

  // --- Operator controls (NOT agent-reachable) -------------------------------

  engageKillSwitch(): void {
    this.#executor.engageKillSwitch();
  }
  disengageKillSwitch(): void {
    this.#executor.disengageKillSwitch();
  }
  isKillSwitchEngaged(): boolean {
    return this.#executor.isKillSwitchEngaged();
  }
  resetCircuitBreaker(): void {
    this.#executor.resetCircuitBreaker();
  }
  isCircuitBreakerOpen(): boolean {
    return this.#executor.isCircuitBreakerOpen();
  }
  consecutiveFailures(): number {
    return this.#executor.consecutiveFailures();
  }

  // --- Audit (signed, replayable timeline) -----------------------------------

  /** Recompute the whole audit chain: link integrity + signature on every entry. */
  verifyAudit(): VerifyResult {
    return this.audit.verify();
  }

  /** The signed audit entries, oldest first. */
  auditTimeline(): readonly AuditEntry[] {
    return this.audit.entries();
  }

  // ---------------------------------------------------------------------------

  /** Append to the signed chain AND mirror into the store, exactly as the
   * executor does, so SDK-originated mandate events share one source of truth. */
  #record(type: AuditEventType, payload: unknown, ts: string): void {
    this.store.appendAudit(this.audit.append(type, payload, ts));
  }
}

// A typed re-export of the core domain types a consumer needs to drive the SDK.
export type {
  Attestation,
  CurrencyCode,
  DenyRule,
  GateConfig,
  GateDecision,
  GateOutcome,
  Mandate,
  MandateStatus,
  PayeeScope,
  PaymentIntent,
  Period,
  RailKind,
  Receipt,
  Reversibility,
  SpendRisk,
  SpendRiskTier,
} from "../core/types.ts";
export type { AuditEntry, AuditEventType, VerifyResult } from "../core/audit.ts";
export type { ExecuteResult, RefundResult } from "../core/executor.ts";
export type { Store, StoredIntent, IntentStatus } from "../core/store.ts";
export { createMemoryStore } from "../store/memoryStore.ts";
export {
  exportAuditChain,
  parseAuditExport,
  verifyAuditExport,
  type AuditExportFormat,
} from "../audit/export.ts";
export { createPostgresStore } from "../store/postgresStore.ts";
export type {
  PgClient,
  PostgresStoreHandle,
  PgNotificationListener,
  PostgresStoreOptions,
} from "../store/postgresStore.ts";
