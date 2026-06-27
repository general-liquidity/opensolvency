# World Agent — an agent backed by a World ID-verified human

[worldcoin/agentkit](https://github.com/worldcoin/agentkit) answers a question the
proof-of-personhood path does not: **is this agent operated by a real, World
ID-verified human, and who is accountable for it?** AgentWorth consumes that verdict
as the gate's `Attestation` input — the same risk channel as ERC-8128, SIWA, and World
ID. It never relaxes the floor (caps / deny-list); it only informs risk.

## The agentkit flow

1. **Registration.** An agent **wallet** is registered in the on-chain **AgentBook**
   via a World ID proof. AgentBook records the registering human's nullifier under the
   agent address (`lookupHuman(address) -> uint256`; World Chain deployment
   `0xA23aB2712eA7BBa896930544C7d6636a96b944dA`).
2. **Challenge.** A server (typically via x402) challenges the agent to sign a
   **CAIP-122 / SIWE** message (`AgentkitPayload`: `domain`, `address`, `uri`,
   `version`, `chainId`, `type`, `nonce`, `issuedAt`, …).
3. **Verification.** The server recovers the signer (EIP-191 for `type: "eip191"`),
   then resolves the registering human from AgentBook and applies its access policy.

AgentWorth mirrors steps 2–3 in two halves:

- **Core (no network).** `verifyWorldAgent` does structural CAIP-122 validation and —
  for `type: "eip191"` — EIP-191-recovers the signer from the signed `message`,
  requiring it to equal `address`. The secp256k1 recover is the same one ERC-8128 uses
  (`@noble`, dynamic-imported; no crypto pulled unless a World Agent is actually
  verified). agentkit reconstructs the signed string from the structured fields with
  viem's `createSiweMessage`; AgentWorth cannot pull viem into the kernel, so the consumer
  supplies the canonical `message` the agent signed.
- **Injected seam.** The AgentBook `eth_call` is an `AgentBookResolver` callback the
  consumer wires with viem/ethers. Without a resolver the result is
  **signature-valid-only** (`humanBacked: false`) — never thrown. Contract signatures
  (`eip1271`) and the Solana path (`ed25519`) are not recovered in the core; AgentBook
  registration can still establish human-backing in those cases.

## Attestation mapping

| signature recovered | AgentBook | `Attestation` |
|---|---|---|
| no (recovered ≠ address, or non-`eip191`) | — | `none` |
| yes | not registered / no resolver | `signed` (verifiable key control, no human binding) |
| yes | registered (human-backed) | `registry_attested` (issuer-attested human bound to the agent) |

When the agent is human-backed, the registering human's **nullifier** becomes the
accountable `principal` and the `agentId`; otherwise the agent address is the `agentId`.

## Usage

```ts
import { worldAgentIdentityVerifier } from "@general-liquidity/agentworth/identity";
import { createPublicClient, http } from "viem";
import { worldchain } from "viem/chains";

const client = createPublicClient({ chain: worldchain, transport: http() });
const AGENT_BOOK = "0xA23aB2712eA7BBa896930544C7d6636a96b944dA";
const ABI = [
  {
    type: "function",
    name: "lookupHuman",
    stateMutability: "view",
    inputs: [{ name: "", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
  },
] as const;

const verifier = worldAgentIdentityVerifier({
  // injected AgentBook resolver — the AgentWorth core never opens an RPC socket
  resolver: async (address) => {
    const humanId = await client.readContract({
      address: AGENT_BOOK,
      abi: ABI,
      functionName: "lookupHuman",
      args: [address as `0x${string}`],
    });
    if (humanId === 0n) return { registered: false };
    return { registered: true, humanNullifier: `0x${humanId.toString(16)}` };
  },
});

const result = await verifier.verify(worldAgentAttestation);
// result.identity.attestation === "registry_attested" when the agent is human-backed
```

Feed `result.identity.attestation` into the gate as its `attestation` input. A
human-backed agent lowers risk; it can never lift a payment over a mandate cap or past
the deny-list.
