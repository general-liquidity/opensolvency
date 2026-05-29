// Mandate templates — presets for the common grants, so an operator (or an
// onboarding flow) can stand up sensible mandates without hand-specifying every
// field. Each returns a normal Mandate; the gate treats them identically.

import type { Mandate } from "./types.ts";

export type MandateTemplate = "groceries" | "subscriptions" | "transport" | "utilities";

interface TemplateDefaults {
  scopeClass: string;
  rails: Mandate["allowedRails"];
  perTxCap: number;
  perPeriodCap: number;
  period: Mandate["period"];
}

const TEMPLATES: Record<MandateTemplate, TemplateDefaults> = {
  groceries: { scopeClass: "groceries", rails: ["card"], perTxCap: 200_00, perPeriodCap: 800_00, period: "week" },
  subscriptions: { scopeClass: "subscription", rails: ["card", "checkout"], perTxCap: 50_00, perPeriodCap: 200_00, period: "month" },
  transport: { scopeClass: "transport", rails: ["card"], perTxCap: 100_00, perPeriodCap: 400_00, period: "month" },
  utilities: { scopeClass: "utilities", rails: ["card", "checkout"], perTxCap: 500_00, perPeriodCap: 1500_00, period: "month" },
};

export function templateMandate(
  template: MandateTemplate,
  spec: { id: string; currency: string; grantedAt: string; expiresAt: string; label?: string },
): Mandate {
  const t = TEMPLATES[template];
  return {
    id: spec.id,
    label: spec.label ?? template,
    scope: { kind: "class", value: t.scopeClass },
    currency: spec.currency,
    allowedRails: t.rails,
    perTxCap: t.perTxCap,
    perPeriodCap: t.perPeriodCap,
    period: t.period,
    grantedAt: spec.grantedAt,
    expiresAt: spec.expiresAt,
    status: "active",
  };
}
