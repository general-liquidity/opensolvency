// Agent-identity layer. Both AIP (Agent Identity Protocol) and Visa Trusted Agent
// Protocol reduce to one shape: verify a presented identity artifact and return
// who the agent is, the accountable principal, and HOW STRONGLY the identity is
// attested. AgentWorth doesn't try to be the identity issuer — it consumes
// identity as an INPUT to the gate's risk/trust (an unverified agent is higher
// risk; a registry-attested agent bound to a principal is lower). Identity never
// relaxes the floor (caps/deny-list), only informs risk.
//
// The strong verifiers do REAL cryptography: AIP is an Ed25519-signed token; Visa
// TAP is an RFC 9421 (HTTP Message Signatures) signed request — `visaTapVerifier`
// below reconstructs the signature base from the covered components, resolves the
// `keyid` to an Ed25519 public key, checks the `created`/`expires` window, and
// verifies the signature. The static map is a DEV-ONLY convenience that performs
// NO cryptography and therefore can never report a cryptographic attestation.

import { verify as edVerify } from "node:crypto";
import type { KeyObject } from "node:crypto";

import type { Attestation } from "../core/types.ts";

export interface AgentIdentity {
  agentId: string;
  /** The accountable human/organization the agent acts for. */
  principal?: string;
  attestation: Attestation;
  capabilities?: string[];
}

export interface IdentityResult {
  verified: boolean;
  identity: AgentIdentity;
  reasons: string[];
}

export interface IdentityVerifier {
  /** Verify a presented identity artifact (an AIP token, a Visa-TAP signed request,
   * an agent id, …). Implementations differ only in which JWKS/registry they hit. */
  verify(presented: unknown): Promise<IdentityResult> | IdentityResult;
}

/** Safe verifier-result adapter for transport `resolveAttestation` hooks. */
export function attestationFromIdentityResult(result: IdentityResult): Attestation {
  return result.verified ? result.identity.attestation : "none";
}

/** No verifier configured → nothing is attested. */
export const noopVerifier: IdentityVerifier = {
  verify: () => ({
    verified: false,
    identity: { agentId: "unknown", attestation: "none" },
    reasons: ["no identity verifier configured"],
  }),
};

/** A known-agents registry for development/testing. It performs NO signature
 * verification — it only matches a self-asserted agent id against a table — so it
 * MUST NOT surface a cryptographic attestation. The match is reported with
 * `verified: false` and `attestation: "none"`, i.e. an asserted-but-unverified
 * identity the gate treats as untrusted (higher-risk). A real deployment injects
 * `visaTapVerifier` (Visa JWKS + RFC-9421) or an AIP Ed25519 verifier instead. */
export function staticIdentityVerifier(
  records: Record<string, AgentIdentity>,
): IdentityVerifier {
  return {
    verify(presented) {
      const agentId =
        typeof presented === "string"
          ? presented
          : (presented as { agentId?: string } | null)?.agentId;
      const record = agentId ? records[agentId] : undefined;
      if (record) {
        return {
          verified: false,
          identity: { ...record, attestation: "none" },
          reasons: [
            "matched a registered agent by ASSERTED id only — no signature " +
              "verification performed (dev verifier); treated as unverified",
          ],
        };
      }
      return {
        verified: false,
        identity: { agentId: agentId ?? "unknown", attestation: "none" },
        reasons: ["no matching registered agent"],
      };
    },
  };
}

// --- Visa Trusted Agent Protocol — real RFC 9421 verification ----------------

/** A Visa-TAP signed request, in the structured shape this verifier covers. The
 * operator parses the inbound HTTP request into this; the signer must have built
 * the signature over exactly these covered components. */
// Exported for reuse by sibling verifiers (e.g. ERC-8128) whose signature base is
// byte-identical to RFC 9421 — they reconstruct the base with these helpers.
export interface SignedRequest {
  method: string;
  authority: string; // the :authority / Host (e.g. "api.example.com")
  path: string; // the request target (`@path`), e.g. "/agent/pay"
  /** Lowercased header name → value. Covered components reference these by name. */
  headers: Record<string, string>;
  /** RFC 9421 `Signature-Input` header value (a Structured-Field dictionary). */
  signatureInput: string;
  /** RFC 9421 `Signature` header value (a Structured-Field dictionary). */
  signature: string;
}

/** Resolves a `keyid` to an Ed25519 public key (the Visa JWKS / key registry). */
export type KeyResolver = (
  keyid: string,
) => KeyObject | undefined | Promise<KeyObject | undefined>;

export interface VisaTapOptions {
  resolveKey: KeyResolver;
  /** Which signature label in the dictionary to verify. Default: the first. */
  label?: string;
  /** Clock (ms epoch). Injected for deterministic tests. Default: Date.now. */
  now?: () => number;
  /** Max age (seconds) tolerated when no `expires` is asserted. Default: 300. */
  maxAgeSeconds?: number;
  /** Clock skew (seconds) tolerated on `created`/`expires`. Default: 30. */
  toleranceSeconds?: number;
  /** Maps a verified `keyid`/agent to its identity (principal binding). */
  identityOf?: (keyid: string) => AgentIdentity | undefined;
}

export interface ParsedSignatureParams {
  components: string[]; // ordered covered-component identifiers, e.g. `"@method"`
  created?: number;
  expires?: number;
  keyid?: string;
  alg?: string;
  raw: string; // the serialized Inner List + params, verbatim from Signature-Input
}

/** Parse one entry of an RFC 9421 `Signature-Input` dictionary value:
 *   label=("@method" "@authority" "content-digest");created=...;keyid="...";alg="..."
 * Returns the chosen entry's covered components + parameters, verbatim where it
 * matters for the signature base. */
export function parseSignatureInput(
  value: string,
  label?: string,
): { label: string; params: ParsedSignatureParams } | undefined {
  // Split the dictionary on top-level commas (none of our values contain commas
  // outside the quoted strings, which have no commas either).
  const entries = splitTopLevel(value, ",");
  for (const entry of entries) {
    const eq = entry.indexOf("=");
    if (eq < 0) continue;
    const name = entry.slice(0, eq).trim();
    if (label && name !== label) continue;
    const rest = entry.slice(eq + 1).trim();
    const close = rest.indexOf(")");
    if (!rest.startsWith("(") || close < 0) continue;
    const inner = rest.slice(1, close).trim();
    const components = inner.length === 0 ? [] : splitTopLevel(inner, " ").filter(Boolean);
    const paramStr = rest.slice(close + 1);
    const params: ParsedSignatureParams = { components, raw: rest };
    for (const p of splitTopLevel(paramStr, ";")) {
      const t = p.trim();
      if (t.length === 0) continue;
      const pe = t.indexOf("=");
      if (pe < 0) continue;
      const k = t.slice(0, pe).trim();
      let v = t.slice(pe + 1).trim();
      if (v.startsWith('"') && v.endsWith('"')) v = v.slice(1, -1);
      if (k === "created") params.created = Number(v);
      else if (k === "expires") params.expires = Number(v);
      else if (k === "keyid") params.keyid = v;
      else if (k === "alg") params.alg = v;
    }
    return { label: name, params };
  }
  return undefined;
}

/** Split on a separator at the top level only (ignore separators inside quotes
 * or parentheses). Sufficient for the Structured-Field subset RFC 9421 uses for
 * Signature-Input / Signature. */
export function splitTopLevel(input: string, sep: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let inQuotes = false;
  let cur = "";
  for (const ch of input) {
    if (ch === '"') inQuotes = !inQuotes;
    else if (!inQuotes && ch === "(") depth++;
    else if (!inQuotes && ch === ")") depth--;
    if (!inQuotes && depth === 0 && ch === sep) {
      out.push(cur);
      cur = "";
      continue;
    }
    cur += ch;
  }
  out.push(cur);
  return out;
}

/** Parse the `Signature` dictionary and return the byte-string for a label. */
export function parseSignatureBytes(value: string, label: string): Buffer | undefined {
  for (const entry of splitTopLevel(value, ",")) {
    const eq = entry.indexOf("=");
    if (eq < 0) continue;
    const name = entry.slice(0, eq).trim();
    if (name !== label) continue;
    let v = entry.slice(eq + 1).trim();
    // Byte-sequence Structured-Field: colon-delimited base64.
    if (v.startsWith(":") && v.endsWith(":")) v = v.slice(1, -1);
    return Buffer.from(v, "base64");
  }
  return undefined;
}

/** Resolve one covered component's value from the request (RFC 9421 §2). */
export function componentValue(id: string, req: SignedRequest): string | undefined {
  const name = id.replace(/^"|"$/g, "");
  switch (name) {
    case "@method":
      return req.method.toUpperCase();
    case "@authority":
      return req.authority.toLowerCase();
    case "@path":
      return req.path;
    default:
      if (name.startsWith("@")) return undefined; // unsupported derived component
      return req.headers[name.toLowerCase()];
  }
}

/** Reconstruct the RFC 9421 signature base from the covered components + the
 * verbatim `@signature-params` value. Returns undefined if any covered component
 * cannot be resolved (a signature over a component we can't reproduce can't be
 * trusted). */
export function buildSignatureBase(
  req: SignedRequest,
  params: ParsedSignatureParams,
): string | undefined {
  const lines: string[] = [];
  for (const id of params.components) {
    const v = componentValue(id, req);
    if (v === undefined) return undefined;
    lines.push(`${id}: ${v}`);
  }
  lines.push(`"@signature-params": ${params.raw}`);
  return lines.join("\n");
}

/**
 * Visa Trusted Agent Protocol verifier — REAL RFC 9421 verification. It:
 *  1. parses `Signature-Input` (covered components + created/expires/keyid/alg),
 *  2. enforces `alg="ed25519"` and the created/expires freshness window,
 *  3. reconstructs the signature base over exactly the covered components,
 *  4. resolves `keyid` to an Ed25519 public key and verifies the signature.
 * Only a cryptographically valid signature yields `verified: true`; the
 * attestation it reports is `signed` (or `registry_attested` when the key
 * resolver binds the agent to a principal via `identityOf`).
 */
export function visaTapVerifier(opts: VisaTapOptions): IdentityVerifier {
  const now = opts.now ?? Date.now;
  const maxAge = opts.maxAgeSeconds ?? 300;
  const tolerance = opts.toleranceSeconds ?? 30;

  return {
    async verify(presented: unknown): Promise<IdentityResult> {
      const unverified = (reasons: string[]): IdentityResult => ({
        verified: false,
        identity: { agentId: "unknown", attestation: "none" },
        reasons,
      });

      const req = presented as Partial<SignedRequest> | null;
      if (
        !req ||
        typeof req.signatureInput !== "string" ||
        typeof req.signature !== "string" ||
        typeof req.method !== "string"
      ) {
        return unverified(["not a Visa-TAP signed request"]);
      }
      const signed = req as SignedRequest;

      const parsed = parseSignatureInput(signed.signatureInput, opts.label);
      if (!parsed) return unverified(["malformed or missing Signature-Input"]);
      const { label, params } = parsed;

      if (params.alg !== "ed25519") {
        return unverified([`unsupported alg "${params.alg ?? "none"}" (require ed25519)`]);
      }
      if (!params.keyid) return unverified(["Signature-Input missing keyid"]);

      const nowSec = Math.floor(now() / 1000);
      if (params.created !== undefined) {
        if (nowSec + tolerance < params.created) {
          return unverified(["signature created in the future"]);
        }
        if (params.expires === undefined && nowSec - params.created > maxAge + tolerance) {
          return unverified(["signature too old (created beyond max-age)"]);
        }
      }
      if (params.expires !== undefined && nowSec - tolerance > params.expires) {
        return unverified(["signature expired"]);
      }

      const sigBytes = parseSignatureBytes(signed.signature, label);
      if (!sigBytes) return unverified([`no signature value for label "${label}"`]);

      const base = buildSignatureBase(signed, params);
      if (base === undefined) {
        return unverified(["a covered component could not be reconstructed"]);
      }

      const key = await opts.resolveKey(params.keyid);
      if (!key) return unverified([`unknown keyid "${params.keyid}"`]);

      let ok = false;
      try {
        ok = edVerify(null, Buffer.from(base, "utf8"), key, sigBytes);
      } catch {
        ok = false;
      }
      if (!ok) return unverified(["RFC 9421 signature did not verify"]);

      const bound = opts.identityOf?.(params.keyid);
      const identity: AgentIdentity = bound ?? {
        agentId: params.keyid,
        attestation: "signed",
      };
      return {
        verified: true,
        identity,
        reasons: ["RFC 9421 ed25519 signature verified"],
      };
    },
  };
}

// --- Optional library-backed RFC 9421 path -----------------------------------
// The bespoke `visaTapVerifier` above is the default (zero dependencies, audited in
// this repo). For operators who'd rather delegate signature-base construction to a
// maintained RFC 9421 implementation, `httpMessageSignaturesVerifier` uses the
// optional `http-message-signatures` package via dynamic import. It verifies the
// SAME vector as the bespoke verifier (same covered components, same ed25519 key
// resolution, same created/expires window) and reports the same attestation. When
// the optional dependency is absent — or doesn't expose the expected API — it
// transparently delegates to `visaTapVerifier`, so the default behaviour and surface
// are unchanged.

/** The subset of the `http-message-signatures` httpbis surface we use. Declared
 *  structurally so we don't take a type-level dependency on the optional package. */
interface HttpMessageSignaturesHttpbis {
  verifyMessage: (
    config: {
      keyLookup: (params: { keyid?: string; alg?: string }) => Promise<
        { id?: string; algs?: string[]; verify: (data: Buffer, signature: Buffer) => Promise<boolean | null> } | null
      >;
      tolerance?: number;
    },
    request: { method: string; url: string; headers: Record<string, string | string[]> },
  ) => Promise<boolean | null>;
}

/** RFC 9421 verifier backed by the optional `http-message-signatures` library, with
 *  a transparent fallback to the bespoke `visaTapVerifier` when the package isn't
 *  installed or doesn't expose the expected API. Same inputs/outputs as
 *  `visaTapVerifier`. The library reconstructs the signature base from the request
 *  headers and runs the ed25519 check via the `keyLookup` we supply (resolving
 *  `keyid` to the same Ed25519 key the bespoke path uses). */
export function httpMessageSignaturesVerifier(opts: VisaTapOptions): IdentityVerifier {
  const fallback = visaTapVerifier(opts);
  const now = opts.now ?? Date.now;
  const tolerance = opts.toleranceSeconds ?? 30;
  const maxAge = opts.maxAgeSeconds ?? 300;

  return {
    async verify(presented: unknown): Promise<IdentityResult> {
      const unverified = (reasons: string[]): IdentityResult => ({
        verified: false,
        identity: { agentId: "unknown", attestation: "none" },
        reasons,
      });

      let httpbis: HttpMessageSignaturesHttpbis | undefined;
      try {
        // Computed specifier: `http-message-signatures` is an optionalDependency that
        // may be absent, so we keep the import out of static module resolution and
        // resolve it dynamically at runtime (transparent fallback to bespoke if absent).
        const spec = "http-message-signatures";
        const lib = (await import(spec)) as {
          httpbis?: Partial<HttpMessageSignaturesHttpbis>;
          default?: Partial<HttpMessageSignaturesHttpbis>;
        } & Partial<HttpMessageSignaturesHttpbis>;
        const candidate = (lib.httpbis ?? lib.default ?? lib) as Partial<HttpMessageSignaturesHttpbis>;
        if (typeof candidate.verifyMessage === "function") {
          httpbis = candidate as HttpMessageSignaturesHttpbis;
        }
      } catch {
        httpbis = undefined;
      }
      // Library absent or unexpected shape → preserve default behaviour exactly.
      if (!httpbis) return fallback.verify(presented);

      const req = presented as Partial<SignedRequest> | null;
      if (
        !req ||
        typeof req.signatureInput !== "string" ||
        typeof req.signature !== "string" ||
        typeof req.method !== "string"
      ) {
        return unverified(["not a Visa-TAP signed request"]);
      }
      const signed = req as SignedRequest;

      // We still parse Signature-Input to enforce alg=ed25519, to bind the verified
      // keyid to a principal, and to apply OUR injected-clock freshness window (the
      // library's age check uses the real wall clock, which isn't deterministic for
      // tests). The library owns signature-base reconstruction + the ed25519 check.
      const parsed = parseSignatureInput(signed.signatureInput, opts.label);
      if (!parsed) return unverified(["malformed or missing Signature-Input"]);
      const { params } = parsed;
      if (params.alg !== "ed25519") {
        return unverified([`unsupported alg "${params.alg ?? "none"}" (require ed25519)`]);
      }
      if (!params.keyid) return unverified(["Signature-Input missing keyid"]);

      const nowSec = Math.floor(now() / 1000);
      if (params.created !== undefined) {
        if (nowSec + tolerance < params.created) return unverified(["signature created in the future"]);
        if (params.expires === undefined && nowSec - params.created > maxAge + tolerance) {
          return unverified(["signature too old (created beyond max-age)"]);
        }
      }
      if (params.expires !== undefined && nowSec - tolerance > params.expires) {
        return unverified(["signature expired"]);
      }

      const key = await opts.resolveKey(params.keyid);
      if (!key) return unverified([`unknown keyid "${params.keyid}"`]);

      // Map our structured SignedRequest into the library's Request shape: the
      // derived components (@method/@authority/@path) come from method+url, the
      // covered headers + the Signature/Signature-Input headers go in `headers`.
      const url = `https://${signed.authority}${signed.path}`;
      const headers: Record<string, string | string[]> = {
        ...signed.headers,
        host: signed.authority,
        "signature-input": signed.signatureInput,
        signature: signed.signature,
      };

      let ok: boolean | null = false;
      try {
        ok = await httpbis.verifyMessage(
          {
            // Resolve keyid → an ed25519 verifier backed by the SAME KeyObject.
            keyLookup: async () => ({
              id: params.keyid,
              algs: ["ed25519"],
              verify: async (data: Buffer, signature: Buffer) => {
                try {
                  return edVerify(null, data, key, signature);
                } catch {
                  return false;
                }
              },
            }),
            // Freshness is enforced above with our injected clock; we don't pass
            // maxAge so the library doesn't re-apply a real-wall-clock age gate.
            tolerance,
          },
          { method: signed.method, url, headers },
        );
      } catch {
        ok = false;
      }
      if (!ok) return unverified(["RFC 9421 signature did not verify (http-message-signatures)"]);

      const bound = opts.identityOf?.(params.keyid);
      const identity: AgentIdentity = bound ?? { agentId: params.keyid, attestation: "signed" };
      return { verified: true, identity, reasons: ["RFC 9421 ed25519 signature verified (http-message-signatures)"] };
    },
  };
}
