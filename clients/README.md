# Language clients

Thin REST clients for the AgentWorth HTTP ingress, for the half of the agent
ecosystem that isn't TypeScript. They add **no authority** - every payment they
submit runs through the same gate (auto-execute inside a mandate, park for approval,
or block). Point them at a running `agentworth serve` (set an ingress token for
anything non-loopback). A `blocked` outcome is a normal result, not an error.

| Client | Path | Deps | Registry |
|:--|:--|:--|:--|
| **TypeScript** | (the main package) | - | npm `@general-liquidity/agentworth` |
| **Python** | `clients/python/` | stdlib only | PyPI `agentworth` |
| **Go** | `clients/go/` | stdlib only | `go get github.com/general-liquidity/agentworth/clients/go` |
| **Rust** | `clients/rust/` | `ureq`, `serde` | crates.io `agentworth` |
| **C / C++** | `clients/c/` | libcurl | source / vcpkg / Conan |

> The TypeScript SDK (`@general-liquidity/agentworth`) is the in-process,
> full-feature surface; these REST clients are for cross-language hosts that talk to a
> running ingress.

## Python

```python
from agentworth import AgentWorthClient

os = AgentWorthClient("http://127.0.0.1:8787", token="...")
res = os.pay(payee="tesco", payee_class="groceries", amount=8000,
             rationale="the weekly grocery shop")
print(res["outcome"])   # settled | pending | blocked | failed
```

## Go

```go
import agentworth "github.com/general-liquidity/agentworth/clients/go"

c := agentworth.New("http://127.0.0.1:8787", "token")
res, err := c.Pay(agentworth.PaymentIntent{
    Payee: "tesco", PayeeClass: "groceries", Amount: 8000,
    Currency: "GBP", Rail: "card", Rationale: "the weekly grocery shop",
}, "")
// res.Outcome is settled | pending | blocked | failed
```

## Rust

```rust
use agentworth::{Client, PaymentIntent};

let c = Client::new("http://127.0.0.1:8787", Some("token".into()));
let res = c.pay(&PaymentIntent {
    payee: "tesco", payee_class: "groceries", amount: 8000,
    currency: "GBP", rail: "card", rationale: "the weekly grocery shop",
}, None)?;
println!("{:?}", res.outcome); // settled | pending | blocked | failed
```

## C / C++

```c
#include "agentworth.h"

os_global_init();
os_client_t *c = os_client_new("http://127.0.0.1:8787", "token");
os_payment_intent_t intent = { "tesco", "groceries", 8000, "GBP", "card", "weekly shop" };
os_response_t resp;
if (os_pay(c, &intent, NULL, &resp) == 0)
    printf("HTTP %ld: %s\n", resp.status, resp.body);   // body is raw JSON
os_response_free(&resp);
os_client_free(c);
```

Build with `make` (needs libcurl). The API is `extern "C"`, usable from C and C++.
