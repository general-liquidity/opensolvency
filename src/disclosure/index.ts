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

// Attestation primitives (vendor-neutral)
export {
  generateAgentKeyPair,
  signDisclosure,
  verifyDisclosureSignature,
  isFresh,
  canonicalize,
  sha256Hex,
  signMessage,
  verifyMessage,
  exportAgentKey,
  agentKeyFromPrivateHex,
  type AgentKeyPair,
  type SignatureCheck,
} from "./attestation.ts";

// Verification handshake (vendor-neutral) — live challenge-response
export {
  createChallenge,
  respondToChallenge,
  verifyChallengeResponse,
  randomNonce,
  type Challenge,
  type ChallengeResponse,
  type HandshakePolicy,
  type HandshakeCheck,
} from "./handshake.ts";

// Counterparty verification (vendor-neutral)
export {
  evaluateDisclosure,
  verifyAndEvaluate,
  type VerificationPolicy,
  type DisclosureVerdict,
  type Grade,
  type AttestationLevel,
} from "./verify.ts";

// OpenSolvency field builders (the reference implementation — does NOT lift out)
export {
  buildAgentDisclosure,
  buildAndSignDisclosure,
  loadOrCreateAgentKey,
  type BuildDisclosureDeps,
} from "./builders.ts";

// Verifier-side over-the-wire loop (vendor-neutral)
export {
  verifyCounterparty,
  type FetchLike,
  type HttpResponse,
  type CounterpartyVerdict,
  type VerifyCounterpartyOptions,
} from "./client.ts";
