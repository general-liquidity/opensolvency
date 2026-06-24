// OpenAPI 3.1 description of the ingress surface. Served at GET /openapi.json so
// any client/IDE/agent framework can discover and call the gate over HTTP from a
// machine-readable contract. This documents the EXISTING endpoints in server.ts;
// keep the two in sync (the contract test asserts the documented paths exist).
//
// Hand-authored (not generated) to avoid a schema-gen dependency — the surface is
// small and stable. Returns a plain object; the server JSON-stringifies it.

export function buildOpenApiDocument(version: string): Record<string, unknown> {
  const intentResult = {
    type: "object",
    properties: {
      intentId: { type: "string" },
      outcome: { type: "string", enum: ["settled", "pending", "blocked", "failed"] },
      reasons: { type: "array", items: { type: "string" } },
      receiptId: { type: ["string", "null"] },
      verified: { type: ["boolean", "null"] },
    },
    required: ["intentId", "outcome", "reasons"],
  };

  return {
    openapi: "3.1.0",
    info: {
      title: "OpenSolvency ingress",
      version,
      description:
        "The operator-aligned governance plane for agentic spend. Every payment " +
        "intent submitted here runs through the same gate as the CLI: it can only " +
        "settle inside an operator-granted mandate, and every decision is signed.",
    },
    components: {
      securitySchemes: {
        bearerAuth: { type: "http", scheme: "bearer" },
      },
      schemas: {
        PaymentIntentDraft: {
          type: "object",
          properties: {
            payee: { type: "string" },
            payeeClass: { type: "string" },
            amount: { type: "integer", description: "minor units (e.g. pence)" },
            currency: { type: "string" },
            rail: { type: "string" },
            rationale: { type: "string" },
          },
          required: ["payee", "payeeClass", "amount", "currency", "rail", "rationale"],
        },
        IntentResult: intentResult,
      },
    },
    // Token-gated when an ingress token is configured; open on loopback otherwise.
    security: [{ bearerAuth: [] }],
    paths: {
      "/health": {
        get: {
          summary: "Liveness probe (never requires auth)",
          security: [],
          responses: { "200": { description: "ok" } },
        },
      },
      "/ready": {
        get: {
          summary: "Readiness probe — the gate responds (never requires auth)",
          security: [],
          responses: { "200": { description: "ready, with kill-switch / breaker state" } },
        },
      },
      "/.well-known/agent-disclosure": {
        get: {
          summary: "Verifiable Agency: this agent's signed disclosure (public, no auth)",
          security: [],
          responses: { "200": { description: "an ed25519-signed AgentDisclosure" }, "404": { description: "disclosure surface not enabled" } },
        },
      },
      "/agent-disclosure/respond": {
        post: {
          summary: "Verifiable Agency: answer a live verification challenge (public)",
          security: [],
          requestBody: {
            required: true,
            content: { "application/json": { schema: { type: "object", properties: { nonce: { type: "string" }, issuedAt: { type: "string" }, verifierId: { type: "string" } }, required: ["nonce"] } } },
          },
          responses: { "200": { description: "a signed ChallengeResponse bound to the current audit head" }, "400": { description: "invalid challenge" } },
        },
      },
      "/status": {
        get: {
          summary: "Kill-switch / circuit-breaker state",
          responses: {
            "200": {
              description: "current halt state",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: {
                      killSwitch: { type: "boolean" },
                      circuitBreaker: { type: "boolean" },
                      consecutiveFailures: { type: "integer" },
                    },
                  },
                },
              },
            },
          },
        },
      },
      "/payment-intent": {
        post: {
          summary: "Submit a payment intent to the gate",
          parameters: [
            {
              name: "Idempotency-Key",
              in: "header",
              required: false,
              schema: { type: "string" },
              description:
                "Replays the first submission's result on retry; the gate runs once per key.",
            },
          ],
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/PaymentIntentDraft" },
              },
            },
          },
          responses: {
            "200": {
              description: "settled (auto-approved under a mandate)",
              content: { "application/json": { schema: { $ref: "#/components/schemas/IntentResult" } } },
            },
            "202": {
              description: "pending operator confirmation",
              content: { "application/json": { schema: { $ref: "#/components/schemas/IntentResult" } } },
            },
            "400": { description: "invalid payment-intent" },
            "401": { description: "missing/invalid bearer token" },
            "403": { description: "blocked by the gate (deny-list / over-cap / halted)" },
            "413": { description: "request body too large" },
            "429": { description: "rate limit exceeded" },
            "502": { description: "rail settlement failed" },
          },
        },
      },
    },
  };
}
