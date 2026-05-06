# Meteria402

`Meteria402` is a Cloudflare Workers starter for anonymous, deposit-backed, OpenAI-compatible AI API billing with x402 payments.

The intended flow is:

```text
Client / provider SDK
  -> /v1/chat/completions
  -> Meteria402 account and invoice checks
  -> Cloudflare AI Gateway provider endpoint
  -> usage-based invoice creation
  -> x402 invoice payment before the next request
```

## Current scope

This implementation includes:

- Anonymous deposit quote and settlement endpoints.
- API key generation after a settled deposit.
- D1-backed accounts, API keys, requests, invoices, payments, and append-only ledger entries.
- Provider SDK endpoint proxying through Cloudflare AI Gateway.
- Usage-based invoice creation after successful requests.
- Blocking of new model requests when an unpaid invoice exists.
- Optional payment-worker integration for deposit and invoice settlement.
- A minimal same-origin `/console` page for deposit setup and account inspection.

This version intentionally keeps Durable Objects out of the MVP. D1 is the source of truth, with conditional updates used for request gating.

## Pages

- `/` — Home page with gateway overview.
- `/console` — Account dashboard for deposits, API keys, usage, invoices, and autopay.
- `/login` — Owner-wallet login via an autopay endpoint.
- `/pay-deposit` — Standalone deposit payment page for wallets that do not expose `window.ethereum` (mobile / non-ETH browsers). Deep-link or QR-code based.

## x402 defaults

When unset, the Worker defaults to Coinbase CDP's hosted x402 facilitator and Base mainnet:

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

If your facilitator requires authentication, set one of:

```bash
# For CDP JWT authentication (preferred)
wrangler secret put CDP_API_KEY_ID
wrangler secret put CDP_API_KEY_SECRET

# Or for legacy token auth
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
wrangler secret put CLOUDFLARE_API_TOKEN
wrangler secret put AI_GATEWAY_API_KEY
wrangler secret put X402_RECIPIENT_ADDRESS
wrangler secret put APP_SIGNING_SECRET
```

`CLOUDFLARE_API_TOKEN` is used only for AI Gateway log reconciliation and needs
Cloudflare AI Gateway read access for the configured account/gateway.

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

### Authentication

- `GET /api/session` — Returns the current session identity (owner address, autopay URL, expiry) or `null`.
- `POST /api/login/autopay/start` — Initiates an owner-wallet login via an autopay endpoint.
- `POST /api/login/autopay/complete` — Completes a login after wallet approval.
- `POST /api/logout` — Clears the session cookie.
- `POST /api/session/autopay` — Updates the autopay endpoint stored in the session.

### Deposits

- `POST /api/deposits/quote` — Create a refundable deposit quote.
- `POST /api/deposits/settle` — Settle a deposit via x402 (browser wallet, mobile deep-link, or dev bypass).
- `GET /api/deposits` — List your deposit history.

### Account

- `GET /api/account` — Get deposit balance, unpaid invoice total, and status.
- `GET /api/api-keys` — List API keys.
- `POST /api/api-keys` — Create a new API key.
- `DELETE /api/api-keys/:id` — Revoke an API key.
- `GET /api/invoices` — List invoices.
- `GET /api/requests` — List model calls / usage records.

### Invoice Payment

- `POST /api/invoices/:id/pay/quote` — Create a payment quote for an unpaid invoice.
- `POST /api/invoices/:id/pay/settle` — Settle an invoice payment.
- `POST /api/invoices/:id/pay/autopay/start` — Start autopay invoice settlement.
- `POST /api/invoices/:id/pay/autopay/complete` — Complete autopay invoice settlement.

### Autopay

- `GET /api/autopay/capabilities` — List scoped autopay authorizations (limits, remaining budget, expiry).
- `POST /api/autopay/capabilities` — Create a new scoped autopay limit.
- `DELETE /api/autopay/capabilities/:id` — Revoke an autopay authorization.
- `POST /api/autopay/capabilities/:id/complete` — Complete the approval after wallet signature.
- `GET /api/autopay-wallet/balance` — Query the autopay wallet address and USDC balance.

### Gateway

- `POST /v1/*` — OpenAI native endpoints. Proxied to Cloudflare AI Gateway `/openai/*`.
- `POST /compat/*` — Cloudflare unified OpenAI-compatible endpoints. Proxied to AI Gateway `/compat/*`.
- `POST /anthropic/*`, `/google-ai-studio/*`, `/openrouter/*`, `/mistral/*`, `/groq/*`, `/deepseek/*`, `/perplexity/*`, `/grok/*`, `/workers-ai/*`, `/azure-openai/*`, `/cohere/*`, `/replicate/*`, and `/huggingface/*` — provider-native Gateway endpoints.
- `GET` requests under these provider paths are proxied without creating usage invoices.
- `GET /health` — Service health check.
- `GET /api/config` — Public frontend configuration (min deposit, asset decimals, etc.).

Use the generated API key with any OpenAI-compatible client:

```ts
import OpenAI from "openai";

const client = new OpenAI({
  apiKey: "meteria402_xxx",
  baseURL: "https://your-worker.example.com/v1",
});

const response = await client.chat.completions.create({
  model: "gpt-5-mini",
  messages: [{ role: "user", content: "Hello" }],
});
```

For the Cloudflare unified OpenAI-compatible endpoint, use:

```ts
const client = new OpenAI({
  apiKey: "meteria402_xxx",
  baseURL: "https://your-worker.example.com/compat",
});

await client.chat.completions.create({
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
- Streaming requests ask the upstream for `stream_options.include_usage = true`.
- Successful metered requests are marked `pending_reconcile` first. Billing is delayed until the Worker can read the Cloudflare AI Gateway log cost, then the request is settled and an invoice is created.
- AI Gateway log reconciliation runs shortly after the response with `waitUntil` retries and is swept again by the scheduled Worker trigger.
