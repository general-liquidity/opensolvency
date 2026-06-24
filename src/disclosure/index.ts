// Verifiable Agency - the agent-disclosure protocol. The vendor-neutral core
// (schema + attestation + verification) is what an agent exposes before transacting
// to be a credible counterparty; OpenSolvency's builders populate it from the live
// gate / mandates / audit / SpendTrust. Designed to lift into a standalone
// `verifiable-agency` repo once the shape stabilizes.

export {
  DISCLOSURE_SCHEMA_VERSION,
  AgentDisclosureSchema,
  SignedDisclosureSchema,
  SystemPromptFingerprintSchema,
  ConstitutionSchema,
  HardConstraintSchema,
  ToolInventorySchema,
  ToolSchema,
  CapitalEnvelopeSchema,
  MandateDisclosureSchema,
  OperatorIdentitySchema,
  DeploymentHistorySchema,
  RedTeamAttestationSchema,
  parseDisclosure,
  parseSignedDisclosure,
  type AgentDisclosure,
  type SignedDisclosure,
  type SystemPromptFingerprint,
  type Constitution,
  type HardConstraint,
  type ToolInventory,
  type Tool,
  type CapitalEnvelope,
  type MandateDisclosure,
  type OperatorIdentity,
  type DeploymentHistory,
  type RedTeamAttestation,
} from "./schema.ts";
