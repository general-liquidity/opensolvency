import { z } from "zod";
import type { Mandate } from "./types.ts";

export const SpendCardRequiredMandateSchema = z.object({
  class: z.string(),
  currency: z.string(),
  suggestedPerTxCap: z.number().int().positive(),
  suggestedPerPeriodCap: z.number().int().positive(),
  period: z.enum(["day", "week", "month"]),
  rails: z.array(z.enum(["card", "checkout", "onchain"])),
});

export const SpendMandateCardSchema = z.object({
  agentId: z.string(),
  requiredMandates: z.array(SpendCardRequiredMandateSchema),
});

export type SpendCardRequiredMandate = z.infer<typeof SpendCardRequiredMandateSchema>;
export type SpendMandateCard = z.infer<typeof SpendMandateCardSchema>;

/**
 * Generate a Spend Mandate Card (SMC) from a list of mandates.
 */
export function generateSpendCard(agentId: string, mandates: Mandate[]): SpendMandateCard {
  return {
    agentId,
    requiredMandates: mandates.map((m) => {
      const scopeClass = m.scope.kind === "class" ? m.scope.value : "custom";
      return {
        class: scopeClass,
        currency: m.currency,
        suggestedPerTxCap: m.perTxCap,
        suggestedPerPeriodCap: m.perPeriodCap,
        period: m.period,
        rails: m.allowedRails,
      };
    }),
  };
}

/**
 * Compare an agent's required Spend Mandate Card with the currently active mandates
 * to determine if the agent's required spend limits are covered.
 */
export function compareSpendCard(
  card: SpendMandateCard,
  activeMandates: Mandate[],
): { covers: boolean; missing: SpendCardRequiredMandate[] } {
  const missing: SpendCardRequiredMandate[] = [];

  for (const req of card.requiredMandates) {
    const covered = activeMandates.some((m) => {
      if (m.status !== "active") return false;
      const scopeClass = m.scope.kind === "class" ? m.scope.value : "";
      if (scopeClass !== req.class) return false;
      if (m.currency !== req.currency) return false;
      if (m.perTxCap < req.suggestedPerTxCap) return false;
      if (m.perPeriodCap < req.suggestedPerPeriodCap) return false;
      if (m.period !== req.period) return false;
      // All required rails must be allowed by the mandate
      const railsCovered = req.rails.every((r) => m.allowedRails.includes(r as any));
      if (!railsCovered) return false;

      return true;
    });

    if (!covered) {
      missing.push(req);
    }
  }

  return {
    covers: missing.length === 0,
    missing,
  };
}
