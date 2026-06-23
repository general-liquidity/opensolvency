// The personal-finance agent — where the behavioural harness drives the agent.
//
//   system prompt = the Networth persona (buildFinanceSystemPrompt)
//   tools = the harness (assess_resilience / plan_goal / review_spending /
//           check_action) + the ONE gate-enforced money-moving tool (pay)
//
// The harness tools are read/advisory; only `pay` moves money, and it routes
// through the executor (the gate) exactly as in runAiAgent. So the PF agent is
// helpful (resilience-aware, advice-gap-filling) AND still structurally unable
// to spend wrong. The operator's weakest pillar is baked into the system prompt
// as the standing agenda.

import { generateText, stepCountIs, tool, type LanguageModel } from "ai";
import { z } from "zod";

import { createPayTool } from "./aiAgent.ts";
import {
  DEFAULT_MAX_OUTPUT_TOKENS,
  DEFAULT_MAX_STEPS,
  repeatedToolCallStop,
  traceFrom,
  type RunTrace,
} from "./governance.ts";
import { RAIL_KINDS } from "./schema.ts";
import { reasoningSandwich } from "./reasoning.ts";
import { addLesson, getLessons } from "./lessons.ts";
import type { Executor, ExecuteResult } from "../core/executor.ts";
import type { Store } from "../core/store.ts";
import type { FinancialProfile } from "../finance/profile.ts";
import { assessResilience } from "../finance/resilience.ts";
import { buildFinanceSystemPrompt } from "../finance/persona.ts";
import { buildHotTier } from "../finance/hotTier.ts";
import { planGoal } from "../finance/goals.ts";
import { watchSpending } from "../finance/watch.ts";
import { checkEmpowerment } from "../finance/ethics.ts";
import { detectMoment, type MomentEvent } from "../finance/moments.ts";
import { listSkills, loadSkill } from "../skills/loader.ts";
import { evaluateOffer, type ServiceCatalog } from "../finance/offer.ts";
import { detectTraps } from "../finance/cognitiveTraps.ts";
import { forecastGoal, coverageReport } from "../finance/forecast.ts";
import { checkInPrompt, readCheckIn, applyCheckIn } from "../finance/emotionalCheckIn.ts";
import { findOptimizations, type MarketRates } from "../finance/optimizations.ts";

export interface FinanceAgentDeps {
  model: LanguageModel;
  executor: Executor;
  store: Store;
  profile: FinancialProfile;
  clock: () => string;
  newId: () => string;
  maxSteps?: number;
  /** Optional service catalog for discover/evaluate-offer tools. */
  catalog?: ServiceCatalog;
  /** Optional injected market source (a seam — already-fetched rates/offers, not
   * a live API) powering find_optimizations. Absent → the tool degrades cleanly
   * to a "no market data configured" result rather than failing. */
  marketRates?: MarketRates;
}

export interface FinanceAgentResult {
  text: string;
  executions: ExecuteResult[];
  trace: RunTrace;
}

const GoalInput = z.object({
  id: z.string(),
  label: z.string(),
  currency: z.string(),
  targetMinor: z.number().int().positive(),
  currentMinor: z.number().int().nonnegative(),
  deadline: z.string().optional(),
});

const SpendObsInput = z.object({
  recent: z.array(
    z.object({
      amountMinor: z.number().int().positive(),
      payeeClass: z.string(),
      rail: z.enum(RAIL_KINDS),
      highCostCredit: z.boolean().optional(),
      at: z.string(),
    }),
  ),
});

const ActionInput = z.object({
  summary: z.string(),
  usesHighCostCredit: z.boolean(),
  manufacturesUrgency: z.boolean(),
  exploitsAnxiety: z.boolean(),
  servesResilienceOrGoal: z.boolean(),
});

function financeTools(deps: FinanceAgentDeps, anxietyDriven: boolean, sink: ExecuteResult[]) {
  return {
    pay: createPayTool(deps, sink),
    assess_resilience: tool({
      description:
        "Assess the operator's financial resilience across the Four Pillars " +
        "(economic, social, policy, infrastructure). Ground advice in this; the " +
        "weakest pillar is your agenda.",
      inputSchema: z.object({}),
      execute: async () => assessResilience(deps.profile),
    }),
    plan_goal: tool({
      description:
        "Compute what reaching a financial goal requires: the monthly " +
        "contribution and whether it is feasible against the operator's surplus.",
      inputSchema: GoalInput,
      execute: async (goal) => planGoal(goal, deps.profile, deps.clock()),
    }),
    review_spending: tool({
      description:
        "Review recent spending for concerns (high-cost credit reliance, " +
        "overspend, buffer erosion, subscription creep). Non-punitive.",
      inputSchema: SpendObsInput,
      execute: async ({ recent }) => watchSpending(recent, deps.profile),
    }),
    check_action: tool({
      description:
        "Before suggesting an action, self-check it against the empower-don't-" +
        "exploit guardrail. Returns empowering | caution | exploitative.",
      inputSchema: ActionInput,
      execute: async (action) => checkEmpowerment(action, { anxietyDriven }),
    }),
    list_skills: tool({
      description: "List the available financial playbooks (skills) by name + description.",
      inputSchema: z.object({}),
      execute: async () => listSkills(),
    }),
    load_skill: tool({
      description: "Load a playbook's full instructions by name (from list_skills).",
      inputSchema: z.object({ name: z.string() }),
      execute: async ({ name }) => loadSkill(name) ?? { error: `no skill "${name}"` },
    }),
    recall: tool({
      description:
        "Cold-recall: search the operator's signed history (audit log) for a term " +
        "— a payee, an amount, an event type. Returns the most recent matches.",
      inputSchema: z.object({ query: z.string() }),
      execute: async ({ query }) => {
        const q = query.toLowerCase();
        return deps.store
          .loadAudit()
          .filter((e) => JSON.stringify(e).toLowerCase().includes(q))
          .slice(-10)
          .map((e) => ({ seq: e.seq, ts: e.ts, type: e.type, payload: e.payload }));
      },
    }),
    propose_lesson: tool({
      description:
        "Record a durable lesson (advisory guidance) for future runs. Lessons " +
        "shape advice only — they can NEVER change what you're allowed to spend.",
      inputSchema: z.object({ lesson: z.string() }),
      execute: async ({ lesson }) => {
        addLesson(deps.store, lesson);
        return { recorded: true };
      },
    }),
    discover_services: tool({
      description:
        "Discover paid services in the agentic economy (machine-readable prices). " +
        "Optionally filter by a query.",
      inputSchema: z.object({ query: z.string().optional() }),
      execute: async ({ query }) =>
        deps.catalog ? (query ? deps.catalog.find(query) : deps.catalog.list()) : [],
    }),
    evaluate_offer: tool({
      description:
        "Before paying for a service, check its price against the operator's live " +
        "mandates (advisory — the gate is still the authority on the actual payment).",
      inputSchema: z.object({
        service: z.string(),
        payee: z.string(),
        payeeClass: z.string(),
        priceMinor: z.number().int().positive(),
        currency: z.string(),
        rail: z.enum(RAIL_KINDS),
      }),
      execute: async (offer) =>
        evaluateOffer(offer, deps.store.listActiveMandates(deps.clock()), deps.clock()),
    }),
    forecast_goal: tool({
      description:
        "Project the savings timeline to a goal (e.g. a house deposit): the " +
        "projected hit-date at the current rate, the £/month gap, and the " +
        "action-first next step. Advisory — moves no money.",
      inputSchema: GoalInput.extend({
        currentMonthlyMinor: z.number().int().nonnegative().optional(),
        monthlyGrowthRate: z.number().nonnegative().optional(),
      }),
      execute: async ({ currentMonthlyMinor, monthlyGrowthRate, ...goal }) =>
        forecastGoal(deps.profile, goal, deps.clock(), {
          currentMonthlyMinor,
          monthlyGrowthRate,
        }),
    }),
    coverage: tool({
      description:
        "The 'what you're missing' view: flags absent foundations (emergency " +
        "buffer, high-cost debt, idle cash, unused LISA, pension, unclaimed " +
        "support) and which goals are behind, each with a concrete next step.",
      inputSchema: z.object({
        goals: z.array(GoalInput),
        monthlyGrowthRate: z.number().nonnegative().optional(),
      }),
      execute: async ({ goals, monthlyGrowthRate }) =>
        coverageReport(deps.profile, goals, deps.clock(), { monthlyGrowthRate }),
    }),
    detect_traps: tool({
      description:
        "Detect the engagement-blocking beliefs active for this operator (e.g. " +
        "'investing is gambling', 'I'll plan when I have a real job') and the " +
        "action-first counter for each. Pass the operator's own words to sharpen it.",
      inputSchema: z.object({ text: z.string().optional() }),
      execute: async ({ text }) => detectTraps(deps.profile, text),
    }),
    check_in: tool({
      description:
        "Emotional check-in: with no `pick`, returns the emoji prompt to ask. " +
        "With a `pick` (an emoji, label, or feeling), records the operator's " +
        "money-feeling onto the profile so comms recalibrate. Moves no money.",
      inputSchema: z.object({ pick: z.string().optional() }),
      execute: async ({ pick }) => {
        if (!pick) return { prompt: checkInPrompt() };
        const state = readCheckIn(pick);
        if (!state) return { recorded: false, reason: `unrecognised check-in: "${pick}"` };
        deps.profile = applyCheckIn(deps.profile, state);
        return { recorded: true, state };
      },
    }),
    find_optimizations: tool({
      description:
        "Find the boring free-money wins (idle cash losing to inflation, better " +
        "savings rates, switch bonuses, unused ISA/LISA allowance) plus scam/FOMO " +
        "guardrails, sorted by £/year. Advisory — proposes, never moves money.",
      inputSchema: z.object({}),
      execute: async () =>
        deps.marketRates
          ? findOptimizations(deps.profile, deps.marketRates)
          : { optimizations: [], note: "no market data configured" },
    }),
  };
}

function composeSystemPrompt(deps: FinanceAgentDeps): string {
  const resilience = assessResilience(deps.profile);
  const now = deps.clock();
  const hot = buildHotTier({
    mandates: deps.store.listActiveMandates(now),
    resilience,
    killSwitchEngaged: deps.executor.isKillSwitchEngaged(),
    circuitBreakerOpen: deps.executor.isCircuitBreakerOpen(),
    recentPayees: [...deps.store.knownPayees()],
  });
  const lessons = getLessons(deps.store);
  const lessonBlock =
    lessons.length > 0 ? `\n\n## Lessons learned\n${lessons.map((l) => `- ${l}`).join("\n")}` : "";
  return `${buildFinanceSystemPrompt(deps.profile, resilience)}\n\n## Live state (hot tier)\n${hot}${lessonBlock}`;
}

export async function runFinanceAgent(
  goal: string,
  deps: FinanceAgentDeps,
): Promise<FinanceAgentResult> {
  const resilience = assessResilience(deps.profile);
  const executions: ExecuteResult[] = [];
  const maxSteps = deps.maxSteps ?? DEFAULT_MAX_STEPS;

  const result = await generateText({
    model: deps.model,
    system: composeSystemPrompt(deps),
    prompt: goal,
    tools: financeTools(deps, resilience.anxietyDriven, executions),
    temperature: 0,
    maxOutputTokens: DEFAULT_MAX_OUTPUT_TOKENS,
    stopWhen: [stepCountIs(maxSteps), repeatedToolCallStop()],
    prepareStep: reasoningSandwich(maxSteps), // phase-differentiated reasoning effort
  });

  return { text: result.text, executions, trace: traceFrom(result) };
}

/** Proactive face of the harness: an event happens → if it's a teachable AND
 * reachable moment, run the agent on the moment's suggested action (still
 * gate-enforced). Teachable-but-not-reachable moments are held, not surfaced. */
export async function runProactiveMoment(
  event: MomentEvent,
  deps: FinanceAgentDeps & { operatorEngaged: boolean },
): Promise<{ surfaced: boolean; result: FinanceAgentResult | null }> {
  const resilience = assessResilience(deps.profile);
  const moment = detectMoment(event, {
    profile: deps.profile,
    resilience,
    operatorEngaged: deps.operatorEngaged,
  });
  if (!moment || !moment.surface) return { surfaced: false, result: null };
  return { surfaced: true, result: await runFinanceAgent(moment.suggestedAction, deps) };
}
