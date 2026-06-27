"""AgentWorth Python client — a thin REST client over the HTTP ingress.

The ingress runs the SAME gate as everything else, so this client adds no
authority: a payment it submits is auto-executed inside a mandate, parked for
operator approval, or blocked. Standard-library only (no dependencies).

    from agentworth import AgentWorthClient

    os = AgentWorthClient("http://127.0.0.1:8787", token="...")
    result = os.pay(payee="tesco", payee_class="groceries", amount=8000,
                    rationale="the weekly grocery shop")
    print(result["outcome"])   # "settled" | "pending" | "blocked" | "failed"
"""

from __future__ import annotations

import json
import uuid
import urllib.error
import urllib.request
from typing import Any, Optional

__all__ = ["AgentWorthClient", "AgentWorthError"]


class AgentWorthError(Exception):
    """Raised on a transport error (not on a gate 'blocked' — that's a normal result)."""


class AgentWorthClient:
    def __init__(self, base_url: str = "http://127.0.0.1:8787", token: Optional[str] = None):
        self.base_url = base_url.rstrip("/")
        self.token = token

    def _request(self, method: str, path: str, body: Any = None, headers: Optional[dict] = None):
        data = json.dumps(body).encode() if body is not None else None
        h = {"content-type": "application/json"}
        if self.token:
            h["authorization"] = f"Bearer {self.token}"
        if headers:
            h.update(headers)
        req = urllib.request.Request(self.base_url + path, data=data, method=method, headers=h)
        try:
            with urllib.request.urlopen(req) as resp:
                payload = resp.read()
                return resp.status, (json.loads(payload) if payload else None)
        except urllib.error.HTTPError as e:
            payload = e.read()
            # 403/401/413/429 carry a JSON body too — return it, don't raise.
            return e.code, (json.loads(payload) if payload else None)
        except urllib.error.URLError as e:
            raise AgentWorthError(f"transport error: {e}") from e

    def pay(
        self,
        payee: str,
        payee_class: str,
        amount: int,
        currency: str = "GBP",
        rail: str = "card",
        rationale: str = "",
        idempotency_key: Optional[str] = None,
    ) -> dict:
        """Submit a payment intent. Returns the gate result
        {intentId, outcome, reasons, receiptId, verified}. `amount` is minor-units."""
        headers = {"idempotency-key": idempotency_key or str(uuid.uuid4())}
        _, body = self._request(
            "POST",
            "/payment-intent",
            {
                "payee": payee,
                "payeeClass": payee_class,
                "amount": amount,
                "currency": currency,
                "rail": rail,
                "rationale": rationale,
            },
            headers,
        )
        return body or {}

    def status(self) -> dict:
        """Kill-switch / circuit-breaker state."""
        return self._request("GET", "/status")[1] or {}

    def ready(self) -> dict:
        """Readiness probe."""
        return self._request("GET", "/ready")[1] or {}

    def openapi(self) -> dict:
        """The served OpenAPI 3.1 document."""
        return self._request("GET", "/openapi.json")[1] or {}

    def get_disclosure(self) -> dict:
        """Fetch this node's signed Verifiable Agency disclosure (public, no auth)."""
        return self._request("GET", "/.well-known/agent-disclosure")[1] or {}

    def verify_disclosure(self, disclosure: dict) -> dict:
        """Verifier-as-a-service: submit a signed disclosure, get a verdict
        {decision, tier, checks, reasons, cost}. Lets a heterogeneous counterparty
        verify a peer without implementing ed25519 itself. A "refuse" decision is a
        normal result, not an error."""
        return self._request("POST", "/verify-disclosure", disclosure)[1] or {}
