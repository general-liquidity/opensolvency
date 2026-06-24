# Changelog

All notable changes to OpenSolvency are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/), and the project aims to adhere to
semantic versioning once it reaches 1.0.

## [0.1.0] — 2026-06-24

First named release (graduated from the `opensolvency` placeholder). The kernel,
gate, audit chain, rails, agent loop, and the Networth-derived behavioural harness
were built across the preceding milestones; this release adds the production
hardening and integration surfaces.

### Added
- **Payments / HTTP hardening** — **idempotency keys** (`Idempotency-Key` header:
  a retried `POST /payment-intent` replays the first result and the gate runs once,
  so a network retry can't settle twice), a per-IP **rate limiter** (fixed-window,
  `429` + `Retry-After`), a **request body-size cap** (`413`), and a **`/ready`**
  readiness probe (distinct from `/health`). All documented in the OpenAPI doc.
- **Editor integration (ACP)** — an Agent Client Protocol stdio surface
  (`src/acp/`) so editors/IDEs can drive the gate-enforced finance agent in-editor,
  alongside the existing MCP server (Claude Code / Cursor) and HTTP ingress.
- **OpenAPI 3.1 document** served at `GET /openapi.json` describing the ingress
  surface for machine discovery.
- **Ingress authentication** — an operator-set bearer token gates the HTTP
  transport (`/health` always open); the surface stays open on loopback when no
  token is configured.
- **Operator notifications** — an injected `Notifier` seam (no-op default, console
  and webhook implementations) pings the operator out-of-band when a payment is
  routed to confirmation, so the pending queue need not be polled. Best-effort:
  it can never block or alter a gate decision.
- **OTLP tracer** — a real `Tracer` that ships executor lifecycle events to an
  OpenTelemetry collector over OTLP/HTTP (JSON), with no hard `@opentelemetry/*`
  dependency.
- **Postgres store** (`createPostgresStore`, exported from the SDK) — durable,
  server-grade persistence. Postgres is the source of truth; an in-process mirror
  serves the synchronous `Store` reads (so the gate stays pure and nothing else
  changes), and writes are persisted through a serialized queue with a `flush()`
  barrier the executor awaits (the new `commit` dep) so a payment's writes are
  durable before `execute()`/`approve()` resolves — no write-behind data-loss risk.
  The `pg` client is injected (operator brings `pg.Pool`); single-writer for now
  (multi-instance cache invalidation via LISTEN/NOTIFY is a documented follow-on).
- Packaging: `LICENSE` (MIT), this changelog, and a publishable package manifest.
- **Publishable build** — `npm run build` compiles `src` → `dist` (ESM + `.d.ts`),
  rewriting `.ts` import specifiers to `.js` (TS `rewriteRelativeImportExtensions`).
  `bin`/`main`/`types`/`exports` point at `dist`, `prepublishOnly` runs the build,
  and the package is no longer `private` — ready for `npm publish` once the name is
  claimed. CI now builds the dist on every run.
