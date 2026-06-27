# Deployment

The ingress (`agentworth serve`) turns the gate into an always-on HTTP service.
It adds no authority — it's another transport into the invariant — but an
internet-reachable endpoint must be authenticated.

## Fail-closed posture

`serve` binds loopback (`127.0.0.1`) by default. Binding a public interface
(`--host 0.0.0.0`) **requires an ingress token** — the command refuses to start
without one, so the endpoint is never exposed unauthenticated. Set the token via
`AGENTWORTH_INGRESS_TOKEN` or `agentworth token set <token>`; callers then send
`Authorization: Bearer <token>`. `/health` and `/ready` are always reachable.

## Docker

```bash
AGENTWORTH_INGRESS_TOKEN=$(openssl rand -hex 24) docker compose up --build
curl localhost:8787/ready
```

The image runs as non-root, healthchecks `/ready`, and stores the sqlite DB on a
volume. The decided runtime posture is **serverless hibernation** (Modal / Daytona /
Fly / Cloud Run) so the agent answers inbound payment challenges as *events*.

## Multi-instance

For multiple instances behind a load balancer, back the SDK with
`createPostgresStore` (durable source of truth + a read mirror kept coherent via
LISTEN/NOTIFY). The **signed audit chain is single-writer** — route writes through
one instance; others serve reads. For many operators in one process,
`createMultiTenantStore` gives each a structurally isolated store + audit chain.

## Real settlement

Every rail fails safe (never moves money without an injected client).
`scripts/testnet-settle.ts` runs a genuine on-chain stablecoin transfer through the
gate on a testnet — you bring a funded testnet key.
