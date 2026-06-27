// OpenAPI 3.1 description of the ingress surface. Served at GET /openapi.json so
// any client/IDE/agent framework can discover and call the gate over HTTP from a
// machine-readable contract. This documents the EXISTING endpoints in server.ts;
// keep the two in sync (the contract test asserts the documented paths exist).
//
// The request/response component SCHEMAS are DERIVED from the same Zod schemas the
// gate validates against (`@asteasolutions/zod-to-openapi`), so the published
// contract can't drift from the runtime validation: change the Zod schema and the
// OpenAPI body shape follows. The paths + descriptions are still hand-authored
// (small, stable surface); only the schema bodies are generated. Returns a plain
// object; the server JSON-stringifies it.

import { extendZodWithOpenApi, OpenAPIRegistry, OpenApiGeneratorV31 } from "@asteasolutions/zod-to-openapi";
import { z } from "zod";
import { PaymentIntentDraftSchema } from "../agent/schema.ts";

// Teach this zod instance the `.openapi()` metadata helper the generator relies on.
extendZodWithOpenApi(z);

// The `.openapi()` helper the generator stamps refIds with. We call it explicitly
// (rather than relying on it being present on every schema instance) because under
// the ts loader a schema imported from another module can carry a prototype the
// extension didn't reach; invoking the patched method directly is realm-independent.
const withRefId = (
  (z as unknown as { ZodType: { prototype: { openapi: (refId: string) => unknown } } }).ZodType
    .prototype.openapi
);

/** The IntentResult response body, as a Zod schema, so it too is derived (and the
 *  outcome enum stays in lockstep with the executor's statuses). */
const IntentResultSchema = z.object({
  intentId: z.string(),
  outcome: z.enum(["settled", "pending", "blocked", "failed"]),
  reasons: z.array(z.string()),
  receiptId: z.string().nullable(),
  verified: z.boolean().nullable(),
});

/** Generate the `components.schemas` block from the live Zod schemas. Named
 *  components (`PaymentIntentDraft`, `IntentResult`) are referenced by `$ref` in the
 *  paths, exactly as the hand-authored doc did — so the contract test stays green. */
function generateSchemas(): Record<string, unknown> {
  const registry = new OpenAPIRegistry();
  registry.register("PaymentIntentDraft", withRefId.call(PaymentIntentDraftSchema, "PaymentIntentDraft") as typeof PaymentIntentDraftSchema);
  registry.register("IntentResult", withRefId.call(IntentResultSchema, "IntentResult") as typeof IntentResultSchema);
  const generated = new OpenApiGeneratorV31(registry.definitions).generateComponents();
  return (generated.components?.schemas ?? {}) as Record<string, unknown>;
}

export function buildOpenApiDocument(version: string): Record<string, unknown> {
  const schemas = generateSchemas();

  return {
    openapi: "3.1.0",
    info: {
      title: "AgentWorth ingress",
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
      // Derived from the live Zod schemas — see generateSchemas() above.
      schemas,
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
      "/verify-disclosure": {
        post: {
          summary: "Verifiable Agency: verifier-as-a-service - evaluate a posted disclosure against this node's policy",
          requestBody: {
            required: true,
            content: { "application/json": { schema: { type: "object", description: "a SignedDisclosure envelope" } } },
          },
          responses: {
            "200": { description: "a verdict { decision, tier, checks, reasons, cost }" },
            "400": { description: "malformed disclosure envelope" },
          },
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
