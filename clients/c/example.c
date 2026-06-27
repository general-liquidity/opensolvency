/* Minimal usage of the AgentWorth C client. Build: `make` (needs libcurl). */
#include "agentworth.h"
#include <stdio.h>

int main(void) {
  os_global_init();

  /* token may be NULL for a loopback dev ingress; pass your bearer token here. */
  os_client_t *client = os_client_new("http://127.0.0.1:8787", NULL);
  if (!client) {
    fprintf(stderr, "failed to create client\n");
    return 1;
  }

  os_payment_intent_t intent = {
      /* payee       */ "tesco",
      /* payee_class */ "groceries",
      /* amount      */ 8000, /* minor-units */
      /* currency    */ "GBP",
      /* rail        */ "card",
      /* rationale   */ "the weekly grocery shop",
  };

  os_response_t resp;
  if (os_pay(client, &intent, NULL, &resp) == 0) {
    printf("HTTP %ld: %s\n", resp.status, resp.body ? resp.body : "(no body)");
    os_response_free(&resp);
  } else {
    fprintf(stderr, "transport error reaching the ingress\n");
  }

  if (os_get(client, "/ready", &resp) == 0) {
    printf("ready: %s\n", resp.body ? resp.body : "(no body)");
    os_response_free(&resp);
  }

  os_client_free(client);
  os_global_cleanup();
  return 0;
}
