// Package agentworth is a thin REST client over the AgentWorth HTTP ingress.
// The ingress runs the SAME gate as everything else, so this client adds no
// authority: a submitted payment is auto-executed inside a mandate, parked for
// operator approval, or blocked. Standard library only.
//
//	c := agentworth.New("http://127.0.0.1:8787", "token")
//	res, err := c.Pay(agentworth.PaymentIntent{
//	    Payee: "tesco", PayeeClass: "groceries", Amount: 8000,
//	    Currency: "GBP", Rail: "card", Rationale: "the weekly grocery shop",
//	}, "")
//	// res.Outcome is "settled" | "pending" | "blocked" | "failed"
package agentworth

import (
	"bytes"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
)

// Client talks to an AgentWorth ingress.
type Client struct {
	BaseURL string
	Token   string
	HTTP    *http.Client
}

// New builds a client. token may be empty for a loopback dev ingress.
func New(baseURL, token string) *Client {
	return &Client{
		BaseURL: strings.TrimRight(baseURL, "/"),
		Token:   token,
		HTTP:    http.DefaultClient,
	}
}

// PaymentIntent is a payment to submit. Amount is integer minor-units.
type PaymentIntent struct {
	Payee      string `json:"payee"`
	PayeeClass string `json:"payeeClass"`
	Amount     int64  `json:"amount"`
	Currency   string `json:"currency"`
	Rail       string `json:"rail"`
	Rationale  string `json:"rationale"`
}

// Result is the gate's verdict on a payment intent.
type Result struct {
	IntentID  string   `json:"intentId"`
	Outcome   string   `json:"outcome"` // settled | pending | blocked | failed
	Reasons   []string `json:"reasons"`
	ReceiptID *string  `json:"receiptId"`
	Verified  *bool    `json:"verified"`
}

func (c *Client) do(method, path string, body any, headers map[string]string) (int, []byte, error) {
	var rdr io.Reader
	if body != nil {
		b, err := json.Marshal(body)
		if err != nil {
			return 0, nil, err
		}
		rdr = bytes.NewReader(b)
	}
	req, err := http.NewRequest(method, c.BaseURL+path, rdr)
	if err != nil {
		return 0, nil, err
	}
	req.Header.Set("content-type", "application/json")
	if c.Token != "" {
		req.Header.Set("authorization", "Bearer "+c.Token)
	}
	for k, v := range headers {
		req.Header.Set(k, v)
	}
	resp, err := c.HTTP.Do(req)
	if err != nil {
		return 0, nil, err
	}
	defer resp.Body.Close()
	data, err := io.ReadAll(resp.Body)
	return resp.StatusCode, data, err
}

// Pay submits a payment intent. idempotencyKey may be empty (one is generated).
// A "blocked" outcome is a normal result, not an error; err is non-nil only on a
// transport/decoding failure.
func (c *Client) Pay(intent PaymentIntent, idempotencyKey string) (*Result, error) {
	if idempotencyKey == "" {
		idempotencyKey = randomKey()
	}
	_, data, err := c.do("POST", "/payment-intent", intent, map[string]string{
		"idempotency-key": idempotencyKey,
	})
	if err != nil {
		return nil, err
	}
	var r Result
	if err := json.Unmarshal(data, &r); err != nil {
		return nil, fmt.Errorf("decode result: %w", err)
	}
	return &r, nil
}

// Verdict is the verifier-as-a-service result for a submitted disclosure.
type Verdict struct {
	Decision string          `json:"decision"` // transact | refuse
	Tier     string          `json:"tier"`     // cached | fresh
	Checks   map[string]bool `json:"checks"`
	Reasons  []string        `json:"reasons"`
}

// GetDisclosure fetches this node's signed Verifiable Agency disclosure (public).
func (c *Client) GetDisclosure() (json.RawMessage, error) {
	_, data, err := c.do("GET", "/.well-known/agent-disclosure", nil, nil)
	if err != nil {
		return nil, err
	}
	return json.RawMessage(data), nil
}

// VerifyDisclosure submits a signed disclosure to the verifier-as-a-service
// endpoint and returns the verdict. A "refuse" verdict is a normal result; err is
// non-nil only on a transport/decoding failure.
func (c *Client) VerifyDisclosure(disclosure json.RawMessage) (*Verdict, error) {
	_, data, err := c.do("POST", "/verify-disclosure", disclosure, nil)
	if err != nil {
		return nil, err
	}
	var v Verdict
	if err := json.Unmarshal(data, &v); err != nil {
		return nil, fmt.Errorf("decode verdict: %w", err)
	}
	return &v, nil
}

// Status returns the kill-switch / circuit-breaker state.
func (c *Client) Status() (map[string]any, error) {
	return c.getJSON("/status")
}

// Ready returns the readiness probe.
func (c *Client) Ready() (map[string]any, error) {
	return c.getJSON("/ready")
}

func (c *Client) getJSON(path string) (map[string]any, error) {
	_, data, err := c.do("GET", path, nil, nil)
	if err != nil {
		return nil, err
	}
	var m map[string]any
	if err := json.Unmarshal(data, &m); err != nil {
		return nil, err
	}
	return m, nil
}

func randomKey() string {
	b := make([]byte, 16)
	_, _ = rand.Read(b)
	return hex.EncodeToString(b)
}
