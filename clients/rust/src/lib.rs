//! AgentWorth Rust client - a thin REST client over the HTTP ingress.
//!
//! The ingress runs the SAME gate as everything else, so this client adds no
//! authority: a payment it submits is auto-executed inside a mandate, parked for
//! operator approval, or blocked. A `blocked` outcome is a normal result, not an
//! error.
//!
//! ```no_run
//! use agentworth::{Client, PaymentIntent};
//!
//! let c = Client::new("http://127.0.0.1:8787", Some("token".into()));
//! let res = c.pay(&PaymentIntent {
//!     payee: "tesco", payee_class: "groceries", amount: 8000,
//!     currency: "GBP", rail: "card", rationale: "the weekly grocery shop",
//! }, None).unwrap();
//! println!("{:?}", res.outcome); // settled | pending | blocked | failed
//! ```

// `ureq::Error` is a large enum; boxing it in this thin client isn't worth the
// ergonomic cost, so we accept the lint rather than wrap every Result.
#![allow(clippy::result_large_err)]

use serde::{Deserialize, Serialize};
use std::time::{SystemTime, UNIX_EPOCH};

/// A client for an AgentWorth ingress.
pub struct Client {
    base_url: String,
    token: Option<String>,
}

/// A payment to submit. `amount` is integer minor-units.
#[derive(Serialize)]
pub struct PaymentIntent<'a> {
    pub payee: &'a str,
    #[serde(rename = "payeeClass")]
    pub payee_class: &'a str,
    pub amount: i64,
    pub currency: &'a str,
    pub rail: &'a str,
    pub rationale: &'a str,
}

/// The gate's verdict on a payment intent.
#[derive(Debug, Deserialize)]
pub struct PayResult {
    #[serde(rename = "intentId")]
    pub intent_id: Option<String>,
    /// "settled" | "pending" | "blocked" | "failed"
    pub outcome: Option<String>,
    #[serde(default)]
    pub reasons: Vec<String>,
    #[serde(rename = "receiptId")]
    pub receipt_id: Option<String>,
    pub verified: Option<bool>,
}

/// The verifier-as-a-service verdict for a submitted disclosure.
#[derive(Debug, Deserialize)]
pub struct Verdict {
    /// "transact" | "refuse"
    pub decision: Option<String>,
    /// "cached" | "fresh"
    pub tier: Option<String>,
    #[serde(default)]
    pub reasons: Vec<String>,
}

impl Client {
    pub fn new(base_url: impl Into<String>, token: Option<String>) -> Self {
        let mut b = base_url.into();
        while b.ends_with('/') {
            b.pop();
        }
        Client { base_url: b, token }
    }

    fn request(&self, method: &str, path: &str) -> ureq::Request {
        let url = format!("{}{}", self.base_url, path);
        let mut r = ureq::request(method, &url).set("content-type", "application/json");
        if let Some(t) = &self.token {
            r = r.set("authorization", &format!("Bearer {t}"));
        }
        r
    }

    /// Submit a payment intent. `idempotency_key` may be `None` (one is generated).
    /// A `blocked` outcome is a normal result; `Err` is returned only on a
    /// transport/decoding failure.
    pub fn pay(
        &self,
        intent: &PaymentIntent,
        idempotency_key: Option<&str>,
    ) -> Result<PayResult, ureq::Error> {
        let generated;
        let key = match idempotency_key {
            Some(k) => k,
            None => {
                generated = gen_key();
                &generated
            }
        };
        let body = serde_json::to_value(intent).expect("serialize intent");
        let result = self
            .request("POST", "/payment-intent")
            .set("idempotency-key", key)
            .send_json(body);
        // A gate "blocked" (403), 202, 413, 429, 502 carry a JSON body too — treat
        // them as normal results rather than transport errors.
        let resp = match result {
            Ok(r) => r,
            Err(ureq::Error::Status(_code, r)) => r,
            Err(e) => return Err(e),
        };
        Ok(resp.into_json()?)
    }

    /// Kill-switch / circuit-breaker state.
    pub fn status(&self) -> Result<serde_json::Value, ureq::Error> {
        Ok(self.request("GET", "/status").call()?.into_json()?)
    }

    /// Readiness probe.
    pub fn ready(&self) -> Result<serde_json::Value, ureq::Error> {
        Ok(self.request("GET", "/ready").call()?.into_json()?)
    }

    /// Fetch this node's signed Verifiable Agency disclosure (public, no auth).
    pub fn get_disclosure(&self) -> Result<serde_json::Value, ureq::Error> {
        Ok(self
            .request("GET", "/.well-known/agent-disclosure")
            .call()?
            .into_json()?)
    }

    /// Verifier-as-a-service: submit a signed disclosure, get a verdict. Lets a
    /// heterogeneous counterparty verify a peer without implementing ed25519. A
    /// `refuse` verdict is a normal result; `Err` only on transport/decoding failure.
    pub fn verify_disclosure(
        &self,
        disclosure: &serde_json::Value,
    ) -> Result<Verdict, ureq::Error> {
        let result = self
            .request("POST", "/verify-disclosure")
            .send_json(disclosure);
        let resp = match result {
            Ok(r) => r,
            Err(ureq::Error::Status(_code, r)) => r,
            Err(e) => return Err(e),
        };
        Ok(resp.into_json()?)
    }
}

fn gen_key() -> String {
    let n = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    format!("{n:032x}")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn trims_trailing_slash_and_builds() {
        let c = Client::new("http://localhost:8787/", Some("t".into()));
        assert_eq!(c.base_url, "http://localhost:8787");
        assert!(c.token.is_some());
    }

    #[test]
    fn intent_serializes_with_payee_class_key() {
        let v = serde_json::to_value(PaymentIntent {
            payee: "tesco",
            payee_class: "groceries",
            amount: 8000,
            currency: "GBP",
            rail: "card",
            rationale: "weekly shop",
        })
        .unwrap();
        assert_eq!(v["payeeClass"], "groceries");
        assert_eq!(v["amount"], 8000);
    }

    #[test]
    fn gen_key_is_hex() {
        assert!(gen_key().chars().all(|c| c.is_ascii_hexdigit()));
    }

    #[test]
    fn verdict_deserializes() {
        let v: Verdict =
            serde_json::from_str(r#"{"decision":"transact","tier":"fresh","reasons":[]}"#).unwrap();
        assert_eq!(v.decision.as_deref(), Some("transact"));
        assert_eq!(v.tier.as_deref(), Some("fresh"));
    }
}
