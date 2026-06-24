// Ingress authentication. The HTTP surface adds no AUTHORITY (the gate still
// decides every payment), but an internet-reachable endpoint must not let just
// anyone submit intents or read status — an unauthenticated caller could spam the
// pending queue or probe the operator's state. So a bearer token gates the
// transport, separately from and on top of the gate.
//
// The token lives in the store's operator-only meta (never an agent-writable
// field), set by the operator. When NO token is configured, the server stays
// loopback-only and open (the existing local-dev posture) — auth is required only
// once a token exists, so binding to a public interface without setting one fails
// closed at the bind site (see createIngressServer).

const INGRESS_TOKEN_KEY = "ingress_token";

/** Read the configured ingress token (operator meta), if any. */
export function getIngressToken(getMeta: (k: string) => string | undefined): string | undefined {
  const t = getMeta(INGRESS_TOKEN_KEY);
  return t && t.length > 0 ? t : undefined;
}

/** Set/rotate the ingress token (operator op). */
export function setIngressToken(setMeta: (k: string, v: string) => void, token: string): void {
  setMeta(INGRESS_TOKEN_KEY, token);
}

export interface AuthResult {
  ok: boolean;
  /** populated when !ok — the {status,body} to return */
  status?: number;
  body?: unknown;
}

/** Constant-time-ish string compare to avoid leaking token length/prefix via
 *  early-exit timing. Not a hardware guarantee, but removes the trivial oracle. */
function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** Is this a loopback bind host? Used to fail closed: binding a NON-loopback
 *  interface without an ingress token would expose the endpoint unauthenticated. */
export function isLoopbackHost(host: string): boolean {
  return host === "127.0.0.1" || host === "localhost" || host === "::1";
}

/** Extract a bearer token from an Authorization header value. */
export function bearerFrom(authHeader: string | undefined): string | undefined {
  if (!authHeader) return undefined;
  const m = /^Bearer\s+(.+)$/i.exec(authHeader.trim());
  return m ? m[1] : undefined;
}

/**
 * Authorize one ingress request. When no token is configured, requests pass
 * (loopback dev posture). When a token IS configured, the request must carry a
 * matching `Authorization: Bearer <token>`; otherwise 401. Pure + deterministic.
 *
 * `/health` and `/ready` are always allowed (probes shouldn't need a secret).
 */
export function authorizeIngress(
  path: string,
  authHeader: string | undefined,
  configuredToken: string | undefined,
): AuthResult {
  // Probes + the public Verifiable Agency disclosure surface need no secret.
  if (
    path === "/health" ||
    path === "/ready" ||
    path === "/.well-known/agent-disclosure" ||
    path === "/agent-disclosure/respond"
  ) {
    return { ok: true };
  }
  if (!configuredToken) return { ok: true }; // open dev mode (loopback only)
  const presented = bearerFrom(authHeader);
  if (!presented || !safeEqual(presented, configuredToken)) {
    return {
      ok: false,
      status: 401,
      body: { error: "unauthorized" },
    };
  }
  return { ok: true };
}
