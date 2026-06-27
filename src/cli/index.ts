#!/usr/bin/env node
// AgentWorth CLI — the first transport over the kernel. The same executor and
// gate are transport-agnostic, so an event ingress (x402/ACP webhook) will call
// the identical path later.
//
//   agentworth mandate grant --label "groceries" --class groceries \
//       --currency GBP --rails card --per-tx 50000 --per-period 100000 \
//       --period week --expires-days 30
//   agentworth agent "PAY 8000 GBP tesco groceries card :: weekly shop"
//   agentworth pending
//   agentworth approve <intentId> --rationale "yes, I know this payee"
//   agentworth audit verify
//
// Amounts are integer minor-units (8000 = £80.00).

import { randomUUID } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { AuditLog } from "../core/audit.ts";
import { createExecutor } from "../core/executor.ts";
import { DEFAULT_GATE_CONFIG } from "../core/types.ts";
import { DEFAULT_DENY_RULES } from "../core/denyList.ts";
import { createSqliteStore } from "../store/sqliteStore.ts";
import { createRailRegistry } from "../rails/registry.ts";
import { createFakeRail } from "../rails/fakeRail.ts";
import { runAgentTurn } from "../agent/loop.ts";
import { createStubModel } from "../agent/stubModel.ts";
import { runAiAgent } from "../agent/aiAgent.ts";
import {
  createAiModel,
  isModelProvider,
  DEFAULT_MODEL_ID,
  PROVIDER_API_KEY_ENV,
  type AiModelConfig,
} from "../agent/aiSdkModel.ts";
import { runFinanceAgent } from "../agent/financeAgent.ts";
import { createIngressServer } from "../ingress/server.ts";
import { getIngressToken, setIngressToken, isLoopbackHost } from "../ingress/auth.ts";
import { createRateLimiter } from "../ingress/rateLimit.ts";
import { runAcpStdio } from "../acp/entry.ts";
import { startAgentWorthMcp } from "../mcp/run.ts";
import { VERSION } from "../version.ts";
import { runEvalSuite } from "../evals/index.ts";
import { exportAuditChain, verifyAuditExport } from "../audit/export.ts";
import { rankSpendTrust, REFERENCE_SUBMISSIONS, type SpendTrustSubmission } from "../benchmark/spendTrust.ts";
import {
  buildAndSignDisclosure,
  loadOrCreateAgentKey,
  verifyAndEvaluate,
  type Grade,
  type VerificationPolicy,
} from "../disclosure/index.ts";
import { renderTimeline } from "../obs/replay.ts";
import { replayAudit } from "../obs/replaySim.ts";
import { buildProfile } from "../finance/onboarding.ts";
import { getProfile, setProfile, saveGoal, listGoals } from "../finance/profileStore.ts";
import type {
  AnxietyLevel,
  IncomeVolatility,
  LifeStage,
  SupportLevel,
} from "../finance/profile.ts";
import type { Mandate, PayeeScope, Period, RailKind } from "../core/types.ts";

function parseFlags(args: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i].startsWith("--")) {
      const key = args[i].slice(2);
      const val = args[i + 1] && !args[i + 1].startsWith("--") ? args[++i] : "true";
      out[key] = val;
    }
  }
  return out;
}

/** A real model is used (via the Vercel AI SDK) when a key is available for the
 * selected provider; otherwise the deterministic offline stub handles the
 * `PAY …` DSL. Provider chosen by AGENTWORTH_MODEL_PROVIDER (openai default). */
function realModelConfig(): AiModelConfig | null {
  const raw = process.env.AGENTWORTH_MODEL_PROVIDER ?? "openai";
  const provider = isModelProvider(raw) ? raw : "openai";
  const apiKey =
    process.env.AGENTWORTH_MODEL_API_KEY ??
    process.env[PROVIDER_API_KEY_ENV[provider]];
  if (!apiKey) return null;
  const modelId = process.env.AGENTWORTH_MODEL ?? DEFAULT_MODEL_ID[provider];
  return { provider, modelId, apiKey };
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const [command, sub, ...rest] = argv;
  const dbPath = process.env.AGENTWORTH_DB ?? "agentworth.db";

  const store = createSqliteStore(dbPath);
  const audit = new AuditLog(store.operatorKey(), store.loadAudit());
  const rails = createRailRegistry([
    createFakeRail("card"),
    createFakeRail("checkout"),
    createFakeRail("onchain"),
  ]);
  const clock = () => new Date().toISOString();
  const executor = createExecutor({
    store,
    rails,
    audit,
    config: DEFAULT_GATE_CONFIG,
    denyRules: DEFAULT_DENY_RULES,
    clock,
  });

  // ── init: guided first-run setup ─────────────────────────────────────────────
  if (command === "init") {
    const hasMandates = store.listMandates().length > 0;
    const hasProfile = getProfile(store) !== undefined;
    const tokenSet = getIngressToken(store.getMeta.bind(store)) !== undefined;
    console.log("AgentWorth — first-run setup\n");
    if (!hasMandates) {
      const m: Mandate = {
        id: `m_${randomUUID().slice(0, 8)}`, label: "starter",
        scope: { kind: "class", value: "misc" }, currency: "GBP", allowedRails: ["card"],
        perTxCap: 50_00, perPeriodCap: 200_00, period: "week",
        grantedAt: clock(), expiresAt: new Date(Date.now() + 30 * 86_400_000).toISOString(), status: "active",
      };
      store.insertMandate(m);
      console.log(`✓ granted a small starter mandate (${m.id}): misc · GBP · card · per-tx £0.50 · per-week £2.00`);
    } else {
      console.log(`✓ ${store.listMandates().length} mandate(s) already configured`);
    }
    console.log(hasProfile ? "✓ a finance profile is set" : "• no finance profile yet — `profile set …` (for the advisory agent)");
    console.log(tokenSet ? "✓ an ingress token is set" : "• no ingress token — `token set <token>` before exposing the HTTP ingress");
    console.log("\nNext steps:");
    console.log("  agentworth mandate grant --label groceries --class groceries --currency GBP \\");
    console.log("      --rails card --per-tx 50000 --per-period 100000 --period week --expires-days 30");
    console.log("  agentworth pay --payee tesco --class groceries --amount 8000 --rationale 'weekly shop'");
    console.log("  agentworth serve            # the HTTP ingress (set a token first)");
    console.log("  npx -y @general-liquidity/agentworth-mcp   # the MCP server for your editor");
    return;
  }

  if (command === "mandate" && sub === "grant") {
    const f = parseFlags(rest);
    const scope: PayeeScope = f.payees
      ? { kind: "allowlist", values: f.payees.split(",") }
      : { kind: "class", value: f.class ?? "general" };
    const ttlDays = Number(f["expires-days"] ?? "30");
    const m: Mandate = {
      id: `m_${randomUUID().slice(0, 8)}`,
      label: f.label ?? "unnamed",
      scope,
      currency: f.currency ?? "GBP",
      allowedRails: (f.rails ?? "card").split(",") as RailKind[],
      perTxCap: Number(f["per-tx"] ?? "0"),
      perPeriodCap: Number(f["per-period"] ?? "0"),
      period: (f.period ?? "week") as Period,
      grantedAt: clock(),
      expiresAt: new Date(Date.now() + ttlDays * 86_400_000).toISOString(),
      status: "active",
    };
    store.insertMandate(m);
    console.log(`granted ${m.id} — ${m.label}`);
    return;
  }

  if (command === "mandate" && sub === "list") {
    for (const m of store.listMandates()) {
      console.log(
        `${m.id}  ${m.status.padEnd(8)} ${m.label} — ${JSON.stringify(m.scope)} ` +
          `${m.currency} per-tx ${m.perTxCap} per-${m.period} ${m.perPeriodCap} ` +
          `expires ${m.expiresAt}`,
      );
    }
    return;
  }

  if (command === "mandate" && sub === "revoke") {
    store.revokeMandate(rest[0]);
    console.log(`revoked ${rest[0]}`);
    return;
  }

  if (command === "pay") {
    const f = parseFlags([sub, ...rest].filter(Boolean));
    const result = await executor.execute({
      id: `pi_${randomUUID().slice(0, 8)}`,
      payee: f.payee ?? "",
      payeeClass: f.class ?? "general",
      amount: Number(f.amount ?? "0"),
      currency: f.currency ?? "GBP",
      rail: (f.rail ?? "card") as RailKind,
      rationale: f.rationale ?? "",
      createdAt: clock(),
    });
    console.log(`${result.status}: ${result.decision.reasons.join("; ")}`);
    if (result.intentId && result.status === "pending") {
      console.log(`  pending intent ${result.intentId} — approve to settle`);
    }
    return;
  }

  if (command === "agent") {
    const goal = sub ? [sub, ...rest].join(" ") : "";
    const newId = () => `pi_${randomUUID().slice(0, 8)}`;
    const cfg = realModelConfig();

    const run = cfg
      ? // Real multi-step loop on the Vercel AI SDK; the `pay` tool is
        // gate-enforced, so the autonomous loop still can't bypass the gate.
        runAiAgent(goal, {
          model: createAiModel(cfg),
          executor,
          store,
          clock,
          newId,
        }).then((r) => {
          for (const ex of r.executions) {
            console.log(`${ex.status}: ${ex.decision.reasons.join("; ")}`);
            if (ex.status === "pending") {
              console.log(`  pending intent ${ex.intentId} — approve to settle`);
            }
          }
          if (r.text) console.log(r.text);
        })
      : // Offline deterministic path (the PAY … DSL), no model key required.
        runAgentTurn(goal, {
          model: createStubModel(),
          executor,
          store,
          clock,
          newId,
        }).then((r) => {
          if (!r.execution) {
            console.log(
              r.decision.kind === "message" ? r.decision.message : "(no payment)",
            );
            return;
          }
          console.log(
            `${r.execution.status}: ${r.execution.decision.reasons.join("; ")}`,
          );
          if (r.execution.status === "pending") {
            console.log(
              `  pending intent ${r.execution.intentId} — approve to settle`,
            );
          }
        });

    await run.catch((e) => {
      console.error("agent error:", e instanceof Error ? e.message : e);
      process.exitCode = 1;
    });
    return;
  }

  if (command === "pending") {
    for (const s of store.listPendingIntents()) {
      console.log(
        `${s.intent.id}  ${s.intent.amount} ${s.intent.currency} → ` +
          `${s.intent.payee} (${s.intent.rail}) — ${s.reasons.join("; ")}`,
      );
    }
    return;
  }

  if (command === "approve") {
    const f = parseFlags(rest);
    const result = await executor.approve(sub, f.rationale ?? "operator approved", {
      acknowledged: f.ack === "true",
    });
    if (result.challenge) {
      console.log("CHALLENGE — re-run with --ack after confirming:");
      for (const q of result.challenge) console.log(`  • ${q}`);
      return;
    }
    console.log(`${result.status}: ${result.decision.reasons.join("; ")}`);
    return;
  }

  if (command === "refund") {
    const f = parseFlags(rest);
    const r = await executor.refund(sub, {
      amountMinor: f.amount ? Number(f.amount) : undefined,
      reason: f.reason,
    });
    console.log(r.ok ? `refunded ${r.refundedMinor}` : `refund refused: ${r.reason}`);
    return;
  }

  if (command === "kill") {
    executor.engageKillSwitch();
    console.log("KILL SWITCH ENGAGED — all agent spend is frozen until `unkill`.");
    return;
  }
  if (command === "unkill") {
    executor.disengageKillSwitch();
    console.log("kill switch released.");
    return;
  }
  if (command === "reset-breaker") {
    executor.resetCircuitBreaker();
    console.log("circuit breaker reset.");
    return;
  }
  if (command === "status") {
    console.log(
      `kill switch: ${executor.isKillSwitchEngaged() ? "ENGAGED" : "off"} | ` +
        `circuit breaker: ${executor.isCircuitBreakerOpen() ? "OPEN" : "closed"} ` +
        `(${executor.consecutiveFailures()} consecutive blocks/failures)`,
    );
    return;
  }

  if (command === "audit" && sub === "verify") {
    const r = audit.verify();
    console.log(
      r.valid
        ? `audit chain OK — ${audit.entries().length} entries`
        : `audit chain INVALID at seq ${r.brokenAt}: ${r.reason}`,
    );
    if (!r.valid) process.exitCode = 1;
    return;
  }

  if (command === "audit" && sub === "log") {
    for (const e of audit.entries()) {
      console.log(`#${e.seq} ${e.ts} ${e.type} ${JSON.stringify(e.payload)}`);
    }
    return;
  }

  if (command === "audit" && sub === "export") {
    // Dump the signed chain to a portable file (jsonl default) for archival /
    // independent verification. `--format json` for a single array.
    const f = parseFlags(rest);
    process.stdout.write(exportAuditChain(audit.entries(), f.format === "json" ? "json" : "jsonl"));
    process.stdout.write("\n");
    return;
  }

  if (command === "audit" && sub === "verify-export") {
    // Verify a previously-exported chain standalone, with this operator's key.
    const path = rest[0];
    if (!path) {
      console.log("usage: agentworth audit verify-export <file>");
      return;
    }
    const r = verifyAuditExport(readFileSync(path, "utf8"), store.operatorKey());
    console.log(
      r.valid
        ? "exported chain OK — verified standalone"
        : `exported chain INVALID at seq ${r.brokenAt}: ${r.reason}`,
    );
    if (!r.valid) process.exitCode = 1;
    return;
  }

  if (command === "audit" && sub === "replay") {
    for (const line of renderTimeline(audit.entries())) console.log(line);
    const v = audit.verify();
    console.log(v.valid ? "— chain verified —" : `— chain INVALID at seq ${v.brokenAt} —`);
    return;
  }

  if (command === "audit" && sub === "replay-sim") {
    const f = parseFlags(rest);
    const candidate = f.mandates
      ? (JSON.parse(readFileSync(f.mandates, "utf8")) as Mandate[])
      : store.listMandates();
    const report = replayAudit(audit.entries(), { mandates: candidate });
    const source = f.mandates ? f.mandates : "current mandate set";
    console.log(
      `counterfactual replay vs ${source}: ` +
        `${report.total} decisions, ${report.changed} changed, ${report.unchanged} unchanged`,
    );
    for (const r of report.records) {
      const mark = r.changed ? "Δ" : " ";
      console.log(`${mark} ${r.intentId}: ${r.original} → ${r.replayed}`);
    }
    return;
  }

  if (command === "profile" && sub === "set") {
    const f = parseFlags(rest);
    const profile = buildProfile({
      currency: f.currency,
      monthlyIncomeMinor: Number(f.income ?? "0"),
      monthlyEssentialSpendMinor: Number(f.essentials ?? "0"),
      liquidSavingsMinor: f.savings ? Number(f.savings) : undefined,
      highCostDebtMinor: f.debt ? Number(f.debt) : undefined,
      incomeVolatility: f.volatility as IncomeVolatility | undefined,
      supportNetwork: f.support as SupportLevel | undefined,
      hasRoleModel: f["role-model"] === "true" ? true : undefined,
      entitlementsAware: f["entitlements-aware"] === "true" ? true : undefined,
      hasUnclaimedSupport: f["unclaimed-support"] === "true" ? true : undefined,
      reliesOnInformalCredit: f["informal-credit"] === "true" ? true : undefined,
      stage: f.stage as LifeStage | undefined,
      financialAnxiety: f.anxiety as AnxietyLevel | undefined,
    });
    setProfile(store, profile);
    console.log("profile saved.");
    return;
  }
  if (command === "profile" && sub === "show") {
    const p = getProfile(store);
    console.log(p ? JSON.stringify(p, null, 2) : "no profile — run `profile set` first.");
    return;
  }
  if (command === "goal" && sub === "set") {
    const f = parseFlags(rest);
    saveGoal(store, {
      id: f.id ?? `g_${randomUUID().slice(0, 8)}`,
      label: f.label ?? "goal",
      currency: f.currency ?? getProfile(store)?.currency ?? "GBP",
      targetMinor: Number(f.target ?? "0"),
      currentMinor: Number(f.current ?? "0"),
      deadline: f.deadline,
    });
    console.log(`goals: ${listGoals(store).length}`);
    return;
  }
  if (command === "finance") {
    const goal = sub ? [sub, ...rest].join(" ") : "";
    const profile = getProfile(store);
    if (!profile) {
      console.log("no profile — run `profile set` first.");
      return;
    }
    const cfg = realModelConfig();
    if (!cfg) {
      console.log("the finance agent needs a model key (AGENTWORTH_MODEL_API_KEY).");
      return;
    }
    const r = await runFinanceAgent(goal, {
      model: createAiModel(cfg),
      executor,
      store,
      profile,
      clock,
      newId: () => `pi_${randomUUID().slice(0, 8)}`,
    });
    for (const ex of r.executions) {
      console.log(`${ex.status}: ${ex.decision.reasons.join("; ")}`);
    }
    if (r.text) console.log(r.text);
    console.log(
      `[trace] ${r.trace.steps} steps, ${r.trace.totalTokens} tokens, ${r.trace.finishReason}`,
    );
    return;
  }

  // ── disclose: emit a signed agent disclosure (Verifiable Agency) ─────────────
  if (command === "disclose") {
    const f = parseFlags([sub, ...rest].filter(Boolean));
    const agentKey = loadOrCreateAgentKey(store);
    const signed = buildAndSignDisclosure({
      store,
      audit,
      agentKey,
      systemPrompt: "AgentWorth spending agent: every payment passes the governance gate.",
      operator: {
        id: f["operator-id"] ?? "operator",
        deniabilityBoundary:
          f.deniability ??
          "The operator authorizes spend only within the disclosed mandates; not liable for counterparty conduct.",
      },
      now: clock(),
      nonce: randomUUID(),
    });
    const json = JSON.stringify(signed, null, 2);
    if (f.out) writeFileSync(f.out, json);
    else console.log(json);
    return;
  }

  // ── verify-disclosure: a counterparty checks a disclosure before transacting ──
  if (command === "verify-disclosure") {
    if (!sub) {
      console.log("usage: agentworth verify-disclosure <file> [--require-grade B] [--require-enforced] [--require-non-custodial]");
      return;
    }
    const f = parseFlags(rest);
    const policy: VerificationPolicy = {
      now: clock(),
      requireEnforcedConstitution: f["require-enforced"] === "true",
      requireNonCustodial: f["require-non-custodial"] === "true",
      requireRedTeam: f["require-redteam"] === "true",
      minRedTeamGrade: (f["require-grade"] as Grade | undefined) ?? undefined,
      requireDeploymentHistory: f["require-history"] === "true",
      requireAuditAnchor: f["require-anchor"] === "true",
    };
    const verdict = verifyAndEvaluate(JSON.parse(readFileSync(sub, "utf8")), policy);
    console.log(`${verdict.decision.toUpperCase()}${verdict.reasons.length ? ":" : ""}`);
    for (const r of verdict.reasons) console.log(`  - ${r}`);
    if (verdict.decision === "refuse") process.exitCode = 1;
    return;
  }

  // ── benchmark: SpendTrust — rank how safely agents spend ─────────────────────
  if (command === "benchmark") {
    const subs: SpendTrustSubmission[] = sub
      ? (JSON.parse(readFileSync(sub, "utf8")) as SpendTrustSubmission[])
      : REFERENCE_SUBMISSIONS;
    const board = rankSpendTrust(subs);
    for (const [i, r] of board.entries()) {
      console.log(
        `${String(i + 1).padStart(2)}. ${r.grade}  ${String(r.score).padStart(3)}  ` +
          `${r.agentId}${r.hardFail ? "  [HARD FAIL]" : ""}` +
          (r.violations.length ? `\n      ${r.violations.join("\n      ")}` : ""),
      );
    }
    return;
  }

  // ── evals: run the generated scenario suite (gate decisions + process checks) ─
  if (command === "evals") {
    const suite = await runEvalSuite();
    for (const r of suite.results) {
      console.log(
        `${r.passed ? "✓" : "✗"} ${r.scenarioId.padEnd(36)} [${r.derivedFrom}] ` +
          (r.passed ? r.actualStatus : `expected ${r.expectedStatus}, got ${r.actualStatus}`),
      );
    }
    console.log(`${suite.passed}/${suite.total} scenarios passed.`);
    if (!suite.ok) process.exitCode = 1;
    return;
  }

  // ── ingress token (operator-only; gates the HTTP transport) ─────────────────
  if (command === "token" && sub === "set") {
    if (!rest[0]) {
      console.log("usage: agentworth token set <token>");
      return;
    }
    setIngressToken(store.setMeta.bind(store), rest[0]);
    console.log("ingress token set — HTTP requests now require a bearer token.");
    return;
  }

  // ── serve: the HTTP ingress (same executor/gate as the CLI) ─────────────────
  if (command === "serve") {
    const f = parseFlags([sub, ...rest].filter(Boolean));
    const port = Number(f.port ?? "8787");
    const host = f.host ?? "127.0.0.1";
    const newId = () => `pi_${randomUUID().slice(0, 8)}`;
    // Token resolution: an env var (ergonomic for containers) overrides the stored
    // one, so a deployment configures auth without a writable DB step.
    const resolveToken = () =>
      process.env.AGENTWORTH_INGRESS_TOKEN ?? getIngressToken(store.getMeta.bind(store));
    const isLoopback = isLoopbackHost(host);
    // FAIL CLOSED: binding to a public interface without a token would expose the
    // ingress unauthenticated. The gate still governs spend, but the transport must
    // not be open to the internet — refuse to start.
    if (!isLoopback && !resolveToken()) {
      console.error(
        `refusing to bind ${host} without an ingress token — set AGENTWORTH_INGRESS_TOKEN ` +
          "or run `token set <token>` first (binding a public interface unauthenticated is unsafe).",
      );
      process.exitCode = 1;
      return;
    }
    const server = createIngressServer({
      executor,
      clock,
      newId,
      store,
      ingressToken: resolveToken,
      version: VERSION,
      rateLimiter: createRateLimiter(),
      // Verifiable Agency: serve this agent's disclosure + answer live challenges.
      disclosure: {
        audit,
        operator: {
          id: f["operator-id"] ?? "operator",
          deniabilityBoundary:
            f.deniability ??
            "The operator authorizes spend only within the disclosed mandates; not liable for counterparty conduct.",
        },
      },
    });
    server.listen(port, host, () => {
      console.log(
        `ingress on http://${host}:${port} (OpenAPI at /openapi.json) — ` +
          `auth ${resolveToken() ? "ON (bearer token required)" : "OFF (loopback dev; set one with `token set`)"}`,
      );
    });
    return;
  }

  // ── mcp: the MCP server over stdio (Claude Code / Cursor) ────────────────────
  if (command === "mcp") {
    // Reuse the already-composed runtime (no second sqlite connection).
    await startAgentWorthMcp({ store, executor, audit, clock });
    return;
  }

  // ── acp: the Agent Client Protocol over stdio (editors/IDEs) ─────────────────
  if (command === "acp") {
    const profile = getProfile(store);
    const cfg = realModelConfig();
    if (!profile) {
      console.error("no profile — run `profile set` first.");
      process.exitCode = 1;
      return;
    }
    if (!cfg) {
      console.error("the ACP agent needs a model key (AGENTWORTH_MODEL_API_KEY).");
      process.exitCode = 1;
      return;
    }
    const newId = () => `pi_${randomUUID().slice(0, 8)}`;
    runAcpStdio({
      newSessionId: () => `sess_${randomUUID().slice(0, 8)}`,
      runPrompt: async (_sessionId, text) => {
        const r = await runFinanceAgent(text, {
          model: createAiModel(cfg),
          executor,
          store,
          profile,
          clock,
          newId,
        });
        return r.text ?? "";
      },
    });
    return;
  }

  console.log(
    "usage: agentworth <init|mandate grant|mandate list|mandate revoke|pay|" +
      "agent|finance|profile set|profile show|goal set|pending|approve [--ack]|" +
      "kill|unkill|reset-breaker|status|audit verify|audit log|audit replay|" +
      "audit replay-sim [--mandates file.json]|audit export|audit verify-export <file>|" +
      "serve [--port N]|token set <token>|mcp|acp|evals|benchmark [subs.json]|" +
      "disclose [--out f]|verify-disclosure <file>>",
  );
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exitCode = 1;
});
