#!/usr/bin/env node
// OpenSolvency CLI — the first transport over the kernel. The same executor and
// gate are transport-agnostic, so an event ingress (x402/ACP webhook) will call
// the identical path later.
//
//   opensolvency mandate grant --label "groceries" --class groceries \
//       --currency GBP --rails card --per-tx 50000 --per-period 100000 \
//       --period week --expires-days 30
//   opensolvency agent "PAY 8000 GBP tesco groceries card :: weekly shop"
//   opensolvency pending
//   opensolvency approve <intentId> --rationale "yes, I know this payee"
//   opensolvency audit verify
//
// Amounts are integer minor-units (8000 = £80.00).

import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
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
import { getIngressToken, setIngressToken } from "../ingress/auth.ts";
import { createRateLimiter } from "../ingress/rateLimit.ts";
import { runAcpStdio } from "../acp/entry.ts";
import { createOpenSolvencyMcpServer, startMcpStdio } from "../mcp/server.ts";
import { VERSION } from "../version.ts";
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
 * `PAY …` DSL. Provider chosen by OPENSOLVENCY_MODEL_PROVIDER (openai default). */
function realModelConfig(): AiModelConfig | null {
  const raw = process.env.OPENSOLVENCY_MODEL_PROVIDER ?? "openai";
  const provider = isModelProvider(raw) ? raw : "openai";
  const apiKey =
    process.env.OPENSOLVENCY_MODEL_API_KEY ??
    process.env[PROVIDER_API_KEY_ENV[provider]];
  if (!apiKey) return null;
  const modelId = process.env.OPENSOLVENCY_MODEL ?? DEFAULT_MODEL_ID[provider];
  return { provider, modelId, apiKey };
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const [command, sub, ...rest] = argv;
  const dbPath = process.env.OPENSOLVENCY_DB ?? "opensolvency.db";

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
      console.log("the finance agent needs a model key (OPENSOLVENCY_MODEL_API_KEY).");
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

  // ── ingress token (operator-only; gates the HTTP transport) ─────────────────
  if (command === "token" && sub === "set") {
    if (!rest[0]) {
      console.log("usage: opensolvency token set <token>");
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
    const newId = () => `pi_${randomUUID().slice(0, 8)}`;
    const server = createIngressServer({
      executor,
      clock,
      newId,
      store,
      ingressToken: () => getIngressToken(store.getMeta.bind(store)),
      version: VERSION,
      rateLimiter: createRateLimiter(),
    });
    const tokenSet = getIngressToken(store.getMeta.bind(store)) !== undefined;
    server.listen(port, "127.0.0.1", () => {
      console.log(
        `ingress on http://127.0.0.1:${port} (OpenAPI at /openapi.json) — ` +
          `auth ${tokenSet ? "ON (bearer token required)" : "OFF (loopback dev; set one with `token set`)"}`,
      );
    });
    return;
  }

  // ── mcp: the MCP server over stdio (Claude Code / Cursor) ────────────────────
  if (command === "mcp") {
    const newId = () => `pi_${randomUUID().slice(0, 8)}`;
    const server = createOpenSolvencyMcpServer({ executor, store, audit, clock, newId });
    await startMcpStdio(server);
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
      console.error("the ACP agent needs a model key (OPENSOLVENCY_MODEL_API_KEY).");
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
    "usage: opensolvency <mandate grant|mandate list|mandate revoke|pay|" +
      "agent|finance|profile set|profile show|goal set|pending|approve [--ack]|" +
      "kill|unkill|reset-breaker|status|audit verify|audit log|audit replay|" +
      "audit replay-sim [--mandates file.json]|serve [--port N]|token set <token>|" +
      "mcp|acp>",
  );
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exitCode = 1;
});
