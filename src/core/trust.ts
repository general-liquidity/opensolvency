// Trust trajectory — adaptive auto-approval. A payee earns trust through clean
// settlement history: "new" (never paid) → "seen" (paid before) → "trusted"
// (paid repeatedly). Trust RELAXES scrutiny (a trusted payee is lower-risk and no
// longer triggers the new-payee confirm) but it NEVER relaxes the floor: the
// deny-list and caps are independent of trust (asserted in trust.test.ts). This
// is the "trust earns the right to be effortless" mechanic, bounded by the gate.

export type TrustLevel = "new" | "seen" | "trusted";

const TRUSTED_AT = 3; // clean settlements before a payee is "trusted"

export function payeeTrust(settledCount: number): TrustLevel {
  if (settledCount >= TRUSTED_AT) return "trusted";
  if (settledCount >= 1) return "seen";
  return "new";
}
