// A real Tracer implementation: ships executor lifecycle events to an
// OpenTelemetry collector over OTLP/HTTP (JSON) — WITHOUT taking a hard
// @opentelemetry/* dependency. Each `event(name, attrs)` becomes an OTLP LogRecord
// POSTed to `${endpoint}/v1/logs` via an injected fetch.
//
// LogRecords (not spans) because the Tracer surface is event-shaped (no span
// context to thread); this gives operators live visibility in any OTLP backend
// (Grafana/Honeycomb/Datadog/collector) while the signed audit log stays the
// record of truth. Best-effort and non-blocking: a failing collector never affects
// the executor — `event()` returns immediately and export errors are swallowed.

import type { Tracer } from "./tracer.ts";

export type OtlpFetch = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: string },
) => Promise<{ ok: boolean; status: number }>;

export interface OtlpTracerOptions {
  /** collector base URL, e.g. "http://localhost:4318" (no trailing /v1/logs) */
  endpoint: string;
  /** injected fetch (Node 18+ global, or a stub in tests) */
  fetch: OtlpFetch;
  /** service.name resource attribute (default "agentworth") */
  serviceName?: string;
  /** optional headers (e.g. an API key for a hosted backend) */
  headers?: Record<string, string>;
  /** epoch-millis clock; injectable for deterministic tests (default Date.now) */
  now?: () => number;
}

/** OTLP attribute value (string-only is sufficient for our event payloads;
 *  non-strings are JSON-stringified). */
function toAttr(key: string, value: unknown): Record<string, unknown> {
  const stringValue = typeof value === "string" ? value : JSON.stringify(value);
  return { key, value: { stringValue } };
}

/** Build the OTLP/HTTP JSON body for a single event — exported so the shape is
 *  unit-tested without a network round-trip. */
export function buildLogPayload(
  name: string,
  attributes: Record<string, unknown> | undefined,
  serviceName: string,
  epochMillis: number,
): Record<string, unknown> {
  const timeUnixNano = String(epochMillis * 1_000_000);
  return {
    resourceLogs: [
      {
        resource: { attributes: [toAttr("service.name", serviceName)] },
        scopeLogs: [
          {
            scope: { name: "agentworth" },
            logRecords: [
              {
                timeUnixNano,
                severityText: "INFO",
                body: { stringValue: name },
                attributes: Object.entries(attributes ?? {}).map(([k, v]) => toAttr(k, v)),
              },
            ],
          },
        ],
      },
    ],
  };
}

export function otlpTracer(opts: OtlpTracerOptions): Tracer {
  const serviceName = opts.serviceName ?? "agentworth";
  const now = opts.now ?? Date.now;
  const url = `${opts.endpoint.replace(/\/$/, "")}/v1/logs`;
  return {
    event(name, attributes) {
      const body = JSON.stringify(buildLogPayload(name, attributes, serviceName, now()));
      // Fire-and-forget: do not await, swallow any failure.
      void opts
        .fetch(url, {
          method: "POST",
          headers: { "content-type": "application/json", ...(opts.headers ?? {}) },
          body,
        })
        .then((res) => {
          if (!res.ok) console.error(`[otlp] collector returned ${res.status}`);
        })
        .catch((e) => console.error(`[otlp] export failed: ${e instanceof Error ? e.message : e}`));
    },
  };
}
