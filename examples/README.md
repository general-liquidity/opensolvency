# Examples

Runnable demonstrations of the gate governing an agent's spend.

| Example | What it shows | Needs a key? |
|---|---|---|
| [`shopping-agent.ts`](./shopping-agent.ts) | The four gate verdicts end-to-end — auto-execute (covered), park-for-approval (new payee), block (over cap), and injection-resistance (a manipulated rationale changes nothing). Drives the SDK directly. | No |
| [`ai-sdk-agent.ts`](./ai-sdk-agent.ts) | Wiring `createGatedPayTool` into a real Vercel AI SDK agent so the model's spend is gated. | Yes (a model key) |

```bash
npm run example:shopping          # deterministic, no key, no network
node --import tsx examples/ai-sdk-agent.ts   # set OPENSOLVENCY_MODEL_API_KEY first
```

Both use the in-memory store, so they leave nothing behind.
