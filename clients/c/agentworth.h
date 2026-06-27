/* AgentWorth C/C++ client - a thin REST client over the HTTP ingress.
 *
 * The ingress runs the SAME gate as everything else, so this client adds no
 * authority: a payment it submits is auto-executed inside a mandate, parked for
 * operator approval, or blocked. A "blocked" outcome is a normal result (HTTP 403
 * with a JSON body), not a transport error.
 *
 * Depends on libcurl. Usable from C and C++ (the API is `extern "C"`). The client
 * returns the raw JSON response body + HTTP status; parse it with the JSON library
 * of your choice.
 */
#ifndef AGENTWORTH_H
#define AGENTWORTH_H

#ifdef __cplusplus
extern "C" {
#endif

typedef struct os_client os_client_t;

/* A payment to submit. `amount` is integer minor-units. */
typedef struct {
  const char *payee;
  const char *payee_class;
  long long amount;
  const char *currency;
  const char *rail;
  const char *rationale;
} os_payment_intent_t;

/* An HTTP response. `body` is heap-allocated JSON; free it with os_response_free. */
typedef struct {
  long status; /* HTTP status code */
  char *body;  /* NUL-terminated response body (may be NULL) */
} os_response_t;

/* Create a client. `token` may be NULL for a loopback dev ingress. Returns NULL on
 * allocation failure. Call os_global_init() once before first use if your program
 * isn't already initialising libcurl. */
os_client_t *os_client_new(const char *base_url, const char *token);
void os_client_free(os_client_t *client);

/* Submit a payment intent. `idempotency_key` may be NULL (one is generated).
 * Returns 0 when the HTTP request completed (inspect out->status / out->body),
 * or -1 on a transport failure. The caller must os_response_free(out). */
int os_pay(os_client_t *client, const os_payment_intent_t *intent,
           const char *idempotency_key, os_response_t *out);

/* GET a path (e.g. "/status", "/ready"). Same return contract as os_pay. */
int os_get(os_client_t *client, const char *path, os_response_t *out);

/* Fetch this node's signed Verifiable Agency disclosure
 * (GET /.well-known/agent-disclosure). Same return contract as os_pay. */
int os_get_disclosure(os_client_t *client, os_response_t *out);

/* Verifier-as-a-service: POST a signed disclosure to /verify-disclosure and read
 * back the verdict JSON. `disclosure_json` is a NUL-terminated JSON string. Lets a
 * heterogeneous counterparty verify a peer without implementing ed25519. Same
 * return contract as os_pay (a "refuse" verdict is a normal HTTP 200 result). */
int os_verify_disclosure(os_client_t *client, const char *disclosure_json,
                         os_response_t *out);

void os_response_free(os_response_t *resp);

/* Optional one-time libcurl init/cleanup helpers (thin wrappers over
 * curl_global_init / curl_global_cleanup). */
void os_global_init(void);
void os_global_cleanup(void);

#ifdef __cplusplus
}
#endif

#endif /* AGENTWORTH_H */
