# Deploying AgentWorth

The ingress (`agentworth serve`) turns the gate into an always-on HTTP service:
external systems and agents submit payment intents over HTTP and they run through
the **same executor and gate** as the CLI. The HTTP layer adds no authority — it is
just another transport into the invariant.

## Safety posture (read first)

- **The transport fails closed.** `serve` binds loopback (`127.0.0.1`) by default.
  Binding a public interface (`--host 0.0.0.0`) **requires an ingress token** — the
  command refuses to start without one, so the endpoint is never exposed
  unauthenticated. The gate still governs every payment regardless.
- **Set the token** via `AGENTWORTH_INGRESS_TOKEN` (preferred for containers) or
  `agentworth token set <token>`. Callers then send `Authorization: Bearer <token>`.
- `/health` and `/ready` are always reachable (probes); everything else needs the token.

## Docker

```bash
# Build + run, with a generated token (the volume persists the sqlite store).
AGENTWORTH_INGRESS_TOKEN=$(openssl rand -hex 24) docker compose up --build

# Verify it's live (no auth needed for the probe):
curl localhost:8787/ready

# Submit an intent (auth required):
curl -X POST localhost:8787/payment-intent \
  -H "authorization: Bearer $AGENTWORTH_INGRESS_TOKEN" \
  -H "idempotency-key: $(uuidgen)" \
  -H "content-type: application/json" \
  -d '{"payee":"tesco","payeeClass":"groceries","amount":8000,"currency":"GBP","rail":"card","rationale":"the weekly grocery shop"}'
```

The image runs as non-root, healthchecks `/ready`, and stores the sqlite DB on the
`osdata` volume at `/data/agentworth.db`.

## Environment

| Variable | Purpose |
|---|---|
| `AGENTWORTH_INGRESS_TOKEN` | Bearer token guarding the HTTP transport (required to bind a public interface). |
| `AGENTWORTH_DB` | sqlite path (default `/data/agentworth.db` in the image). |
| `AGENTWORTH_MODEL_API_KEY` + `AGENTWORTH_MODEL_PROVIDER` | Optional — enable the real agent (else the deterministic stub). |

## Always-on / hibernating hosts

The decided runtime posture is **serverless hibernation** (Modal / Daytona / Fly
Machines / Cloud Run) rather than a cron: a money agent must answer inbound payment
challenges (x402 / ACP) as *events*, which a periodic cron can't. The container here
is the deployable artifact for any of those — point your platform at it, set the
token, and mount a volume (or move to Postgres via the SDK for multi-instance).

## Multi-instance

The CLI is single-node (sqlite). For multiple instances behind a load balancer,
compose your own host with the SDK's `createPostgresStore` (durable source of truth
+ a read mirror kept coherent via LISTEN/NOTIFY). The **signed audit chain is
single-writer** — route writes through one instance; others serve reads.
