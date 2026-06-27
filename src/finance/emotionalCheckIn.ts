// Emotional check-in — a zero-friction emotional-state capture. In the
// field research, students were asked to pick an EMOJI for how money makes them
// feel before any numbers were discussed; that single tap surfaced an affect
// state the harness can calibrate tone from. This productizes that as an
// onboarding + ongoing primitive that feeds communication.ts.
//
// The 19 interviews clustered money-feeling into five states: overwhelm,
// confusion, disengagement, aspiration, defeat. The harness's existing emotional
// model is FinancialProfile.financialAnxiety (AnxietyLevel) + LifeStage, which
// chooseCommunication() already reasons over — so a pick maps onto that.
//
// GAP (reported, not patched here): the research's DEFEAT state ("nothing is
// attainable", interview #2) is behaviourally distinct from overwhelm — it needs
// its own comms handling (re-establish attainability, not just reassurance), but
// there is no distinct state for it in profile.ts today, so it maps onto the
// closest existing one (`high` anxiety). See the report for the one-line addition.

import type { AnxietyLevel, FinancialProfile } from "./profile.ts";

/** The five money-feeling clusters from the field interviews. */
export type MoneyFeeling =
  | "overwhelm" // 😰 scared / too much (#1, #17)
  | "confusion" // 😵‍💫 baffled / don't understand it (#2, #3, #5, #6)
  | "disengagement" // 😐 neutral / limbo / tuned out (#10, #15)
  | "aspiration" // 😁 confident, hopeful — possibly avoidant (#4, #8)
  | "defeat"; // nothing is attainable — distinct from overwhelm (#2)

/** A pick the operator can make in one tap: the emoji + a plain feeling label. */
export interface EmojiOption {
  emoji: string;
  /** Plain-language label the operator reads (also an accepted text input). */
  label: string;
  feeling: MoneyFeeling;
}

/** The mapped result of a check-in: the cluster + the harness anxiety state. */
export interface EmotionalState {
  feeling: MoneyFeeling;
  /**
   * The closest existing harness state (FinancialProfile.financialAnxiety), so
   * chooseCommunication() can already calibrate tone/agenda from a check-in.
   */
  anxiety: AnxietyLevel;
  /**
   * True when `feeling` had no exact home in the harness's state model and was
   * mapped onto the closest existing one. Every cluster now has a first-class
   * state (defeat → "defeated"), so this is currently always false — kept as a
   * forward seam for any future feeling that lacks an exact mapping.
   */
  approximated: boolean;
}

/**
 * Canonical option set — a few emojis, not a wall. Order is the display order.
 * One option per research cluster, including the distinct `defeat` state (which
 * maps to its own first-class `"defeated"` anxiety level → restore_agency comms).
 */
export const EMOJI_OPTIONS: readonly EmojiOption[] = [
  { emoji: "😰", label: "overwhelmed", feeling: "overwhelm" },
  { emoji: "😵‍💫", label: "confused", feeling: "confusion" },
  { emoji: "😐", label: "tuned out", feeling: "disengagement" },
  { emoji: "😁", label: "hopeful", feeling: "aspiration" },
  { emoji: "😞", label: "defeated", feeling: "defeat" },
] as const;

/** feeling → closest existing harness anxiety state. */
const FEELING_TO_ANXIETY: Record<MoneyFeeling, AnxietyLevel> = {
  overwhelm: "high",
  confusion: "high", // confusion drives avoidance — same low-friction tone as high anxiety
  disengagement: "moderate", // limbo is a risk signal, not security
  aspiration: "low",
  defeat: "defeated", // now a first-class harness state → restore_agency comms
};

/** Feelings that have no exact home in the harness state model (approximated). */
const APPROXIMATED: ReadonlySet<MoneyFeeling> = new Set([]);

function normalize(s: string): string {
  return s.trim().toLowerCase();
}

/**
 * Map a pick — an emoji, a feeling label ("overwhelmed"), or a cluster name
 * ("overwhelm") — onto an EmotionalState. Returns `undefined` for anything we
 * can't recognise (the caller decides how to handle an unknown input; see
 * `readCheckInOrDefault` for the graceful-default variant).
 */
export function readCheckIn(input: string): EmotionalState | undefined {
  const q = normalize(input);
  if (q.length === 0) return undefined;

  const match = EMOJI_OPTIONS.find(
    (o) => o.emoji === input.trim() || normalize(o.label) === q || o.feeling === q,
  );
  if (!match) return undefined;

  return {
    feeling: match.feeling,
    anxiety: FEELING_TO_ANXIETY[match.feeling],
    approximated: APPROXIMATED.has(match.feeling),
  };
}

/**
 * Graceful variant: an unknown / skipped check-in shouldn't lower the agent's
 * guard, so it falls back to `moderate` anxiety (the same conservative default
 * onboarding.ts uses) under the `disengagement` cluster — an operator who won't
 * answer is, behaviourally, disengaged.
 */
export function readCheckInOrDefault(input: string): EmotionalState {
  return (
    readCheckIn(input) ?? {
      feeling: "disengagement",
      anxiety: "moderate",
      approximated: false,
    }
  );
}

export interface CheckInPrompt {
  question: string;
  options: readonly EmojiOption[];
}

/** The onboarding/ongoing question + the option set the UX surfaces. */
export function checkInPrompt(): CheckInPrompt {
  return {
    question: "Before we look at any numbers — how does money make you feel right now?",
    options: EMOJI_OPTIONS,
  };
}

/**
 * Record a check-in onto the profile: writes the mapped anxiety state onto
 * `financialAnxiety` so the rest of the harness (chooseCommunication, resilience
 * agenda) reacts to it. Pure — returns a new profile, never mutates.
 */
export function applyCheckIn(profile: FinancialProfile, state: EmotionalState): FinancialProfile {
  return { ...profile, financialAnxiety: state.anxiety };
}
