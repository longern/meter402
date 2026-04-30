# Meteria402

`Meteria402` is a Cloudflare Workers starter for anonymous, deposit-backed, OpenAI-compatible AI API billing with x402 payments.

The intended flow is:

```text
Client / OpenAI SDK
  -> /v1/chat/completions
  -> Meteria402 account and invoice checks
  -> Cloudflare AI Gateway Unified API
  -> usage-based invoice creation
  -> x402 invoice payment before the next request
```

## Current scope

This implementation includes:

- Anonymous deposit quote and settlement endpoints.
- API key generation after a settled deposit.
- D1-backed accounts, API keys, requests, invoices, payments, and append-only ledger entries.
- OpenAI-compatible `/v1/chat/completions` proxying through Cloudflare AI Gateway.
- Usage-based invoice creation after successful requests.
- Blocking of new model requests when an unpaid invoice exists.
- Optional payment-worker integration for deposit and invoice settlement.
- A minimal same-origin `/console` page for deposit setup and account inspection.

This version intentionally keeps Durable Objects out of the MVP. D1 is the source of truth, with conditional updates used for request gating.

## Facilitator default

The default `wrangler.toml` uses Coinbase CDP's hosted x402 facilitator:

```toml
X402_FACILITATOR_URL = "https://api.cdp.coinbase.com/platform/v2/x402"
X402_NETWORK = "eip155:8453"
X402_ASSET = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913"
```

That network is Base mainnet, and the asset is native USDC on Base.

Set your recipient wallet before using real payments:

```bash
wrangler secret put X402_RECIPIENT_ADDRESS
```

If your facilitator requires authentication, set:

```bash
wrangler secret put X402_FACILITATOR_AUTH_TOKEN
```

## Setup

Install dependencies:

```bash
npm install
```

Create a D1 database:

```bash
wrangler d1 create meteria402
```

Copy the returned database ID into `wrangler.toml`, then apply migrations:

```bash
npm run db:migrate:local
```

Set required secrets:

```bash
wrangler secret put CLOUDFLARE_ACCOUNT_ID
wrangler secret put AI_GATEWAY_API_KEY
wrangler secret put X402_RECIPIENT_ADDRESS
wrangler secret put APP_SIGNING_SECRET
```

For a gateway that requires Cloudflare AI Gateway authentication, also set:

```bash
wrangler secret put AI_GATEWAY_AUTH_TOKEN
```

To prefill `/console` with a default payment worker URL at frontend build time, set:

```bash
export VITE_DEFAULT_AUTOPAY_URL="https://autopay.example.com"
```

Run locally:

```bash
npm run dev
```

`npm run dev` and `npm run deploy` build the React console into `dist/client` before starting or deploying the Worker. API routes still run through the Worker, while `/console` is served as a single-page app.

Open:

```text
http://localhost:8787/console
```

## Development payments

Local development can bypass facilitator settlement by setting:

```toml
ALLOW_DEV_PAYMENTS = "true"
```

Then `/console` can settle a quote using:

```json
{ "dev_proof": "dev-paid" }
```

Do not enable development payments in production.

## API

Create a deposit quote:

```http
POST /api/deposits/quote
Content-Type: application/json

{ "amount": "5.00" }
```

The response includes a signed `quote_token`; the Worker does not write the quote
to D1 until settlement succeeds.

Settle a deposit:

```http
POST /api/deposits/settle
Content-Type: application/json

{
  "payment_id": "pay_xxx",
  "quote_token": "eyJ...",
  "payment_payload": {}
}
```

Use the generated API key with any OpenAI-compatible client:

```ts
import OpenAI from "openai";

const client = new OpenAI({
  apiKey: "meteria402_xxx",
  baseURL: "https://your-worker.example.com/v1",
});

const response = await client.chat.completions.create({
  model: "openai/gpt-5-mini",
  messages: [{ role: "user", content: "Hello" }],
});
```

If the previous request created an unpaid invoice, the next model request returns:

```json
{
  "error": {
    "type": "payment_required",
    "code": "unpaid_invoice",
    "message": "An unpaid invoice must be paid before making another request."
  }
}
```

## Notes

- API keys are shown only once.
- Account recovery is not implemented. If the API key is lost, the anonymous account cannot be recovered yet.
- Streaming requests ask the upstream for `stream_options.include_usage = true`. If usage is still missing, the request is marked `pending_reconcile`.
- AI Gateway log reconciliation is planned but not implemented in this MVP.
