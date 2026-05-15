# Meteria402 Autopay Worker

Self-hosted x402 buyer worker with cross-device SIWE authorization.

The payment requester creates a short-lived authorization request, shows the returned URL as a QR code, and polls the worker. The user opens the QR URL in an owner wallet browser, signs a SIWE message, and the requester receives that signed authorization through the polling endpoint. The requester then calls `/api/pay` with the x402 payment requirement and the signed SIWE authorization.

## Security model

- Account-specific x402 payer hot wallet private keys are stored in D1 encrypted with `AUTOPAY_SECRET`.
- `AUTOPAY_ADMIN_PRIVATE_KEY` is only the admin fallback payer key when an owner has no account-specific wallet configured.
- The owner wallet signs SIWE authorization messages. The owner wallet does not pay x402 requests directly.
- Owners are allowed when they are the configured admin owner or have an `autopay_accounts` record.
- Each authorization request is short-lived and stored in a Durable Object session.
- Polling uses a private `poll_token` that is returned only to the requester, not embedded in the QR URL.
- SIWE `Resources` bind the authorization to the capability, auth request ID, and optionally a payment requirement hash.
- The capability limits requester wallet, origin, recipient, network, asset, max single payment, and policy expiration.
- `/api/pay` requires an EIP-712 requester wallet proof bound to the request body and capability hash.
- The worker creates the x402 payment payload, but final settlement truth comes from the requester/merchant after it verifies and commits settlement. `POST /api/settlement-reports` records that reported result on the worker audit row.
- Only fund the hot wallet with a small amount of USDC.

## Configure

Install dependencies:

```bash
npm install
```

Create the D1 audit database:

```bash
wrangler d1 create meteria402_autopay_audit
```

Copy the returned database ID into `wrangler.toml`, then apply migrations:

```bash
wrangler d1 migrations apply meteria402_autopay_audit --local
wrangler d1 migrations apply meteria402_autopay_audit --remote
```

Set the worker secret used for dashboard session cookies and encrypted account wallets:

```bash
wrangler secret put AUTOPAY_SECRET
```

You can set user payer hot wallet private keys from the dashboard after login. For the admin account fallback payer key, set:

```bash
wrangler secret put AUTOPAY_ADMIN_PRIVATE_KEY
```

Configure the administrator wallet:

```toml
AUTOPAY_ADMIN_OWNER = "0xAdminOwner"
```

For EVM wallets this is normally an address, not a raw public key. The worker verifies SIWE signatures by recovering the signer address. `AUTOPAY_ADMIN_OWNER` can sign in to the dashboard and add account wallet mappings for other owners.

## Dashboard

- `/` serves the dashboard for wallet login, payer-wallet setup, and audit views.
- `/authorize?request_id=...` serves the mobile-first SIWE approval page for a single authorization request.
- Admin owners can add account-specific payer wallets from the dashboard.
- Audit views show authorization requests and payment payload records. A payment is marked `confirmed` only after a trusted requester posts a settlement report.

Run locally:

```bash
npm run dev -- --port 8788
```

Build the React authorization page and type-check the Worker:

```bash
npm run build
```

Open:

```text
http://localhost:8788/
```

Run a local payment requester demo against a deployed autopay worker:

```bash
AUTOPAY_URL=https://autopay.longern.com npm run requester-demo
```

For a local autopay worker, use:

```bash
AUTOPAY_URL=http://localhost:8788 npm run requester-demo
```

Open:

```text
http://localhost:8790/
```

The demo simulates a paid API returning 402, creates an authorization request on the autopay worker, renders the returned authorization URL as a QR code, and polls for the SIWE signature.

## Requester flow

Create an authorization request after receiving a 402 response. The `accepts`
array below is abbreviated; a real request must include an `exact` x402 payment
option so the worker can infer or validate the policy.

```http
POST /api/auth/requests
Content-Type: application/json

{
  "paymentRequired": {
    "x402Version": 2,
    "resource": { "url": "https://api.example.com/protected" },
    "accepts": []
  },
  "requester": {
    "name": "Example App",
    "origin": "https://app.example.com",
    "account": "eip155:8453:0xRequesterWallet"
  },
  "returnOrigin": "https://app.example.com",
  "ttlSeconds": 300,
  "policyValidBefore": "2026-05-05T12:00:00.000Z"
}
```

The worker can infer a strict policy from `paymentRequired` by selecting the cheapest `exact` option. You can also pass an explicit `policy`:

```json
{
  "policy": {
    "allowedOrigins": ["https://api.example.com"],
    "allowedPayTo": ["0xMerchantReceiver"],
    "network": "eip155:8453",
    "asset": "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
    "maxSingleAmount": "100000",
    "validBefore": "2026-05-05T12:00:00.000Z"
  },
  "paymentRequirementHash": "0x..."
}
```

When `policyValidBefore` is provided with an inferred policy, the worker writes it into the signed policy as `validBefore`. If neither `policy.validBefore` nor `policyValidBefore` is provided, `validBefore` defaults to the short authorization request expiration.

Response:

```json
{
  "request_id": "...",
  "poll_token": "...",
  "verification_uri": "https://autopay.example.com/authorize",
  "verification_uri_complete": "https://autopay.example.com/authorize?request_id=...",
  "expires_in": 300,
  "interval": 2,
  "payment_requirement_hash": "0x..."
}
```

Show `verification_uri_complete` as a QR code. Poll for completion:

```http
GET /api/auth/requests/{request_id}/poll
X-Autopay-Poll-Token: poll_token
```

Pending response:

```json
{
  "status": "pending",
  "expires_at": "2026-04-28T12:00:00.000Z"
}
```

Approved response:

```json
{
  "status": "approved",
  "authorization": {
    "siwe_message": "...",
    "siwe_signature": "0x...",
    "owner": "0xOwner",
    "capability": {}
  }
}
```

Then request payment headers:

```http
POST /api/pay
Content-Type: application/json
X-Requester-Account: eip155:8453:0xRequesterWallet
X-Requester-Nonce: random-nonce
X-Requester-Issued-At: 1770000000
X-Requester-Expires-At: 1770000060
X-Requester-Signature: 0x...

{
  "siwe_message": "...",
  "siwe_signature": "0x...",
  "paymentRequired": {
    "x402Version": 2,
    "resource": { "url": "https://api.example.com/protected" },
    "accepts": []
  }
}
```

The requester signature is EIP-712 typed data over `worker`, `path`,
`bodyHash`, `capabilityHash`, `nonce`, `issuedAt`, and `expiresAt`. The worker
recovers the requester wallet and requires it to match the wallet bound into the
owner-signed capability.

Use the returned `headers` to retry the original paid request.

After the requester verifies settlement and commits its own billing state, it
can report the final result back to the worker:

```http
POST /api/settlement-reports
Content-Type: application/json
X-Requester-Account: eip155:8453:0xRequesterWallet
X-Requester-Nonce: random-nonce
X-Requester-Issued-At: 1770000000
X-Requester-Expires-At: 1770000060
X-Requester-Signature: 0x...

{
  "payment_id": "...",
  "autopay_request_id": "...",
  "status": "settled",
  "tx_hash": "0x...",
  "settled_at": "2026-05-14T00:00:00.000Z"
}
```

The settlement report uses the same requester EIP-712 proof shape and updates
the existing `autopay_payments` audit row to `confirmed`.

## Endpoints

```http
GET /api/health
GET /api/capabilities
GET /api/account
PUT /api/account/autopay-wallet
GET /api/admin/accounts
POST /api/admin/accounts
GET /api/auth/challenge
POST /api/auth/login
POST /api/auth/logout
GET /api/auth/me
POST /api/auth/requests
GET /api/auth/requests/{request_id}
GET /api/auth/requests/{request_id}/details
GET /api/auth/requests/{request_id}/poll
GET /api/auth/requests/{request_id}/events
POST /api/auth/requests/{request_id}/approve
POST /api/auth/requests/{request_id}/deny
POST /api/pay
POST /api/settlement-reports
POST /api/proxy
GET /api/audit/authorizations
GET /api/audit/payments
```

`/api/proxy` accepts the same SIWE authorization as `/api/pay`, performs the target request, pays after a 402 response, and retries once.
