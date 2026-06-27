# agentworth (Rust client)

A thin REST client for the [AgentWorth](https://github.com/general-liquidity/agentworth)
governance gate. Point it at a running `agentworth serve`; every payment it submits
runs through the same gate (auto-execute inside a mandate, park for approval, or
block). A `blocked` outcome is a normal result, not an error.

```rust
use agentworth::{Client, PaymentIntent};

let c = Client::new("http://127.0.0.1:8787", Some("token".into()));
let res = c.pay(&PaymentIntent {
    payee: "tesco", payee_class: "groceries", amount: 8000, // minor-units
    currency: "GBP", rail: "card", rationale: "the weekly grocery shop",
}, None)?;
println!("{:?}", res.outcome); // settled | pending | blocked | failed
```

Blocking HTTP via `ureq`; JSON via `serde`. The full-feature surface is the
TypeScript SDK — this is for Rust hosts that talk to an ingress.

License: MIT.
