// A small fixed-window rate limiter for the HTTP ingress. A money endpoint that
// accepts payment intents must not let a caller (or a runaway agent) flood the
// pending queue or hammer the gate — this caps requests per key (per-IP by
// default) per window. In-process and pure given an injected clock, so it's
// deterministic to test; the gate is still the authority, this just protects the
// transport from abuse.

export interface RateLimitResult {
  ok: boolean;
  /** ms until the window resets, when !ok */
  retryAfterMs?: number;
  /** remaining requests in the current window */
  remaining: number;
}

export interface RateLimiterOptions {
  /** window length in ms (default 60_000) */
  windowMs?: number;
  /** max requests per key per window (default 120) */
  max?: number;
  /** epoch-ms clock; injectable for tests (default Date.now) */
  now?: () => number;
}

export interface RateLimiter {
  check(key: string): RateLimitResult;
}

export function createRateLimiter(opts: RateLimiterOptions = {}): RateLimiter {
  const windowMs = opts.windowMs ?? 60_000;
  const max = opts.max ?? 120;
  const now = opts.now ?? Date.now;
  const buckets = new Map<string, { windowStart: number; count: number }>();

  return {
    check(key) {
      const t = now();
      const b = buckets.get(key);
      if (!b || t - b.windowStart >= windowMs) {
        buckets.set(key, { windowStart: t, count: 1 });
        return { ok: true, remaining: max - 1 };
      }
      if (b.count >= max) {
        return { ok: false, retryAfterMs: b.windowStart + windowMs - t, remaining: 0 };
      }
      b.count += 1;
      return { ok: true, remaining: max - b.count };
    },
  };
}
