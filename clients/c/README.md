# AgentWorth C / C++ client

A thin REST client for the [AgentWorth](https://github.com/general-liquidity/agentworth)
governance gate, over libcurl. The API is `extern "C"`, usable from C and C++.
Every payment runs through the same gate; a `blocked` outcome is a normal result
(HTTP 403 with a JSON body), not a transport error.

## Build

Requires libcurl (`libcurl4-openssl-dev` / `curl-devel` / `brew install curl` /
vcpkg `curl`).

```bash
make            # builds the example (links -lcurl)
make check      # syntax-only check of the library
```

Or vendor `agentworth.c` + `agentworth.h` into your build and link `-lcurl`.

## Use

```c
#include "agentworth.h"

os_global_init();
os_client_t *c = os_client_new("http://127.0.0.1:8787", "token"); /* token may be NULL */
os_payment_intent_t intent = {
    "tesco", "groceries", 8000 /* minor-units */, "GBP", "card", "weekly shop"
};
os_response_t resp;
if (os_pay(c, &intent, NULL, &resp) == 0) {
    printf("HTTP %ld: %s\n", resp.status, resp.body); /* body is raw JSON */
    os_response_free(&resp);
}
os_client_free(c);
os_global_cleanup();
```

The client returns the raw JSON response + HTTP status; parse the body with the
JSON library of your choice.
