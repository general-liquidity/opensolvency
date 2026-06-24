# opensolvency (Python client)

A thin REST client for the [OpenSolvency](https://github.com/general-liquidity/opensolvency)
governance gate. Point it at a running `opensolvency serve`; every payment it submits
runs through the same gate (auto-execute inside a mandate, park for operator approval,
or block). A `blocked` outcome is a normal result, not an error. Standard library
only - no dependencies.

```python
from opensolvency import OpenSolvencyClient

os = OpenSolvencyClient("http://127.0.0.1:8787", token="...")
res = os.pay(payee="tesco", payee_class="groceries", amount=8000,  # minor-units
             rationale="the weekly grocery shop")
print(res["outcome"])   # settled | pending | blocked | failed
print(os.status(), os.ready())
```

Idempotency keys are generated per `pay()` (override with `idempotency_key=`). The
full-feature surface is the TypeScript SDK (`@general-liquidity/opensolvency`); this
is for Python hosts that talk to a running ingress.

License: MIT.
