# Introduction

AgentWorth is the **operator-aligned governance plane for agentic spend** — the
trust layer that sits *above* payment rails (x402, cards, ACP/checkout) and *below*
an agent, enforcing a single invariant:

> An agent payment can auto-execute only inside a live, operator-granted mandate
> that covers it — under its caps, below the risk and velocity thresholds, and clear
> of the deny-list. Everything else routes to the operator or is blocked. Every
> decision is signed and replayable.

It is **not** a wallet, a rail, or a payment processor. Autonomous-money agents
already move real funds with no mandate, no cap, no risk gate, and no approver;
AgentWorth is the missing layer that lets an agent spend autonomously *inside*
operator-defined bounds and confirm above them. **The gate is what lets autonomy go
further, safely — not less far.**

## Install

```bash
npm i @general-liquidity/agentworth           # library + `agentworth` CLI
npx -y @general-liquidity/agentworth-mcp       # the MCP server, zero-install
```

## The two halves

- **Safety** (this book's focus): the gate, mandates, signed audit, kill switch.
- **Helpfulness**: a behavioural harness derived from financial-resilience research
  that decides *what the agent should help with* — the operator's weakest pillar.

The rest of this book covers the safety plane: the gate, the mandate model, the
surfaces it's reachable from, and how to deploy and verify it.
