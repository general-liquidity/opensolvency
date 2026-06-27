// Public rails surface. Settlement rails behind the gate — each a thin adapter
// over `createNetworkRail` with a live `RailClient` supplied by the operator.
//
// NOT here, deliberately, because they are not settlement rails:
//  - XMTP (https://xmtp.org) — agent messaging; belongs to event ingress.
//  - AIP (https://agentidentityprotocol.io) and Visa Trusted Agent Protocol —
//    agent identity/trust; feed the mandate + risk side, not settlement.
//  - Artemis agentic-payments tracker — a market map, nothing to implement.

export type { PaymentProvider, ProviderCapabilities } from "./provider.ts";
export { createRailRegistry, type RailRegistry } from "./registry.ts";
export { createFakeRail, type FakeRailOptions } from "./fakeRail.ts";
export {
  createNetworkRail,
  type RailClient,
  type RailSettlement,
  type NetworkRailSpec,
} from "./networkRail.ts";

export { createX402Rail, type X402Client } from "./x402.ts";
export { createOnchainRail, type OnchainClient } from "./onchain.ts";
export {
  createAgenticCommerceRail,
  type AgenticCommerceClient,
} from "./agentic-commerce.ts";
export { createUcpRail, type UcpClient } from "./ucp.ts";
export { createMppRail, type MppClient } from "./mpp.ts";
export {
  createVisaIntelligentCommerceRail,
  type VisaIntelligentCommerceClient,
} from "./visaIntelligentCommerce.ts";
export {
  createMastercardAgentPayRail,
  type MastercardAgentPayClient,
} from "./mastercardAgentPay.ts";
export { createAp2Rail, type Ap2Client, type Ap2RailOptions } from "./ap2/ap2Rail.ts";
export {
  buildPaymentMandateContent,
  bindTransactionId,
  mandateToAp2Constraints,
  type Ap2PaymentMandateContent,
  type Ap2PaymentReceipt,
  type Ap2Constraint,
  type Ap2Merchant,
  type Ap2PaymentInstrument,
} from "./ap2/mandate.ts";
export {
  createOnchainRailClient,
  type Address,
  type TxHash,
  type OnchainSigner,
  type OnchainRailConfig,
} from "./clients/onchainClient.ts";
export {
  createVirtualCardRailClient,
  type CardIssuer,
  type IssuedCard,
  type VirtualCardRailConfig,
} from "./clients/virtualCardClient.ts";
export {
  createX402RailClient,
  encodePaymentHeader,
  decodePaymentHeader,
  X402_VERSION,
  type PaymentRequirements,
  type X402Authorization,
  type X402PaymentPayload,
  type X402SettleResponse,
  type SettledPayment,
  type X402Facilitator,
  type X402RailConfig,
} from "./clients/x402Client.ts";
