/* AgentWorth C/C++ client - libcurl implementation. See agentworth.h. */
#include "agentworth.h"

#include <curl/curl.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>

struct os_client {
  char *base_url; /* trailing slash trimmed */
  char *token;    /* may be NULL */
};

/* ---- a tiny growable string buffer ---- */
typedef struct {
  char *data;
  size_t len;
  size_t cap;
} sb_t;

static int sb_reserve(sb_t *b, size_t extra) {
  if (b->len + extra + 1 <= b->cap) return 0;
  size_t cap = b->cap ? b->cap : 64;
  while (b->len + extra + 1 > cap) cap *= 2;
  char *p = (char *)realloc(b->data, cap);
  if (!p) return -1;
  b->data = p;
  b->cap = cap;
  return 0;
}

static int sb_append(sb_t *b, const char *s, size_t n) {
  if (sb_reserve(b, n)) return -1;
  memcpy(b->data + b->len, s, n);
  b->len += n;
  b->data[b->len] = '\0';
  return 0;
}

static int sb_puts(sb_t *b, const char *s) { return sb_append(b, s, strlen(s)); }

/* Append a JSON string literal (with surrounding quotes), escaping as needed. */
static int sb_json_string(sb_t *b, const char *s) {
  if (sb_puts(b, "\"")) return -1;
  for (const char *p = s ? s : ""; *p; p++) {
    unsigned char c = (unsigned char)*p;
    char buf[8];
    switch (c) {
      case '"': sb_puts(b, "\\\""); break;
      case '\\': sb_puts(b, "\\\\"); break;
      case '\n': sb_puts(b, "\\n"); break;
      case '\r': sb_puts(b, "\\r"); break;
      case '\t': sb_puts(b, "\\t"); break;
      default:
        if (c < 0x20) {
          snprintf(buf, sizeof buf, "\\u%04x", c);
          sb_puts(b, buf);
        } else {
          sb_append(b, (const char *)&c, 1);
        }
    }
  }
  return sb_puts(b, "\"");
}

static size_t write_cb(char *ptr, size_t size, size_t nmemb, void *userdata) {
  sb_t *b = (sb_t *)userdata;
  size_t n = size * nmemb;
  if (sb_append(b, ptr, n)) return 0; /* signal error to libcurl */
  return n;
}

static char *dup_trim_slash(const char *url) {
  size_t n = strlen(url);
  while (n > 0 && url[n - 1] == '/') n--;
  char *out = (char *)malloc(n + 1);
  if (!out) return NULL;
  memcpy(out, url, n);
  out[n] = '\0';
  return out;
}

void os_global_init(void) { curl_global_init(CURL_GLOBAL_DEFAULT); }
void os_global_cleanup(void) { curl_global_cleanup(); }

os_client_t *os_client_new(const char *base_url, const char *token) {
  if (!base_url) return NULL;
  os_client_t *c = (os_client_t *)calloc(1, sizeof *c);
  if (!c) return NULL;
  c->base_url = dup_trim_slash(base_url);
  c->token = token ? strdup(token) : NULL;
  if (!c->base_url) {
    os_client_free(c);
    return NULL;
  }
  return c;
}

void os_client_free(os_client_t *c) {
  if (!c) return;
  free(c->base_url);
  free(c->token);
  free(c);
}

void os_response_free(os_response_t *r) {
  if (!r) return;
  free(r->body);
  r->body = NULL;
  r->status = 0;
}

/* Perform a request. method/body/idem may be NULL as appropriate. */
static int perform(os_client_t *c, const char *method, const char *path,
                   const char *body, const char *idem, os_response_t *out) {
  out->status = 0;
  out->body = NULL;

  CURL *curl = curl_easy_init();
  if (!curl) return -1;

  sb_t url = {0};
  sb_puts(&url, c->base_url);
  sb_puts(&url, path);

  sb_t resp = {0};
  struct curl_slist *headers = NULL;
  headers = curl_slist_append(headers, "content-type: application/json");
  if (c->token) {
    sb_t auth = {0};
    sb_puts(&auth, "authorization: Bearer ");
    sb_puts(&auth, c->token);
    headers = curl_slist_append(headers, auth.data ? auth.data : "");
    free(auth.data);
  }
  if (idem) {
    sb_t ih = {0};
    sb_puts(&ih, "idempotency-key: ");
    sb_puts(&ih, idem);
    headers = curl_slist_append(headers, ih.data ? ih.data : "");
    free(ih.data);
  }

  curl_easy_setopt(curl, CURLOPT_URL, url.data);
  curl_easy_setopt(curl, CURLOPT_HTTPHEADER, headers);
  curl_easy_setopt(curl, CURLOPT_WRITEFUNCTION, write_cb);
  curl_easy_setopt(curl, CURLOPT_WRITEDATA, &resp);
  curl_easy_setopt(curl, CURLOPT_CUSTOMREQUEST, method);
  if (body) {
    curl_easy_setopt(curl, CURLOPT_POSTFIELDS, body);
  }

  CURLcode rc = curl_easy_perform(curl);
  int ret = -1;
  if (rc == CURLE_OK) {
    long code = 0;
    curl_easy_getinfo(curl, CURLINFO_RESPONSE_CODE, &code);
    out->status = code;
    out->body = resp.data; /* hand ownership to the caller */
    resp.data = NULL;
    ret = 0;
  }

  free(resp.data);
  free(url.data);
  curl_slist_free_all(headers);
  curl_easy_cleanup(curl);
  return ret;
}

static void gen_key(char *buf, size_t n) {
  static unsigned long counter = 0;
  snprintf(buf, n, "%lx%lx", (unsigned long)time(NULL), counter++);
}

int os_pay(os_client_t *c, const os_payment_intent_t *intent,
           const char *idempotency_key, os_response_t *out) {
  if (!c || !intent || !out) return -1;

  sb_t body = {0};
  sb_puts(&body, "{");
  sb_puts(&body, "\"payee\":");
  sb_json_string(&body, intent->payee);
  sb_puts(&body, ",\"payeeClass\":");
  sb_json_string(&body, intent->payee_class);
  char amt[32];
  snprintf(amt, sizeof amt, ",\"amount\":%lld,", intent->amount);
  sb_puts(&body, amt);
  sb_puts(&body, "\"currency\":");
  sb_json_string(&body, intent->currency);
  sb_puts(&body, ",\"rail\":");
  sb_json_string(&body, intent->rail);
  sb_puts(&body, ",\"rationale\":");
  sb_json_string(&body, intent->rationale);
  sb_puts(&body, "}");

  char keybuf[48];
  const char *key = idempotency_key;
  if (!key) {
    gen_key(keybuf, sizeof keybuf);
    key = keybuf;
  }

  int rc = perform(c, "POST", "/payment-intent", body.data, key, out);
  free(body.data);
  return rc;
}

int os_get(os_client_t *c, const char *path, os_response_t *out) {
  if (!c || !path || !out) return -1;
  return perform(c, "GET", path, NULL, NULL, out);
}

int os_get_disclosure(os_client_t *c, os_response_t *out) {
  if (!c || !out) return -1;
  return perform(c, "GET", "/.well-known/agent-disclosure", NULL, NULL, out);
}

int os_verify_disclosure(os_client_t *c, const char *disclosure_json,
                         os_response_t *out) {
  if (!c || !disclosure_json || !out) return -1;
  return perform(c, "POST", "/verify-disclosure", disclosure_json, NULL, out);
}
