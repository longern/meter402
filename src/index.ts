import { createApiKey, keyStatus, normalizeApiKeyExpiresAt, normalizeApiKeyName, randomApiKeyName } from "./api-keys";
import { normalizeAutopayUrl } from "./autopay";
import { BASE_MAINNET, BASE_USDC, CORS_HEADERS, JSON_HEADERS } from "./constants";
import { makeId, sha256Hex } from "./crypto";
import { asHttpError, cloneHeaders, copyResponse, errorResponse, HttpError, jsonResponse, paymentRequiredResponse, readJsonObject, readOptionalJsonObject, requireString } from "./http";
import { formatMoney, numberFromUnknown, parseMoney, parseMoneyLikeNumber, parsePositiveInt } from "./money";
import { signDepositAutopayState, signDepositQuote, signLoginState, signSessionState, verifyDepositAutopayState, verifyDepositQuote, verifyLoginState, verifySessionState } from "./signed-state";
import type { Account, AuthenticatedAccount, AutopayRequestRow, AutopayWalletBalanceEligibility, ChatBody, DepositAutopayState, DepositQuoteState, Env, PaymentRequirement, SessionState, Usage } from "./types";

const SESSION_COOKIE_NAME = "meteria402_session";
const SESSION_TTL_SECONDS = 7 * 24 * 60 * 60;

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    try {
      if (request.method === "OPTIONS") {
        return new Response(null, { status: 204, headers: CORS_HEADERS });
      }

      const url = new URL(request.url);
      if (request.method === "GET" && url.pathname === "/health") {
        return jsonResponse({ ok: true, service: "meteria402" });
      }
      if (request.method === "GET" && url.pathname === "/api/config") {
        return handleGetConfig(env);
      }
      if (request.method === "GET" && url.pathname === "/api/autopay-wallet/balance") {
        return await handleAutopayWalletBalance(request, env);
      }
      if (request.method === "GET" && url.pathname === "/api/session") {
        return await handleGetSession(request, env);
      }
      if (request.method === "POST" && url.pathname === "/api/login/autopay/start") {
        return await handleLoginAutopayStart(request, env);
      }
      if (request.method === "POST" && url.pathname === "/api/login/autopay/complete") {
        return await handleLoginAutopayComplete(request, env);
      }
      if (request.method === "POST" && url.pathname === "/api/logout") {
        return handleLogout(request);
      }

      if (request.method === "POST" && url.pathname === "/api/deposits/quote") {
        return await handleDepositQuote(request, env);
      }
      if (request.method === "POST" && url.pathname === "/api/deposits/settle") {
        return await handleDepositSettle(request, env);
      }
      if (request.method === "POST" && /^\/api\/deposits\/[^/]+\/autopay\/start$/.test(url.pathname)) {
        return await handleDepositAutopayStart(request, env, url.pathname.split("/")[3]);
      }
      if (request.method === "POST" && /^\/api\/deposits\/[^/]+\/autopay\/complete$/.test(url.pathname)) {
        return await handleDepositAutopayComplete(request, env, url.pathname.split("/")[3]);
      }
      if (request.method === "GET" && url.pathname === "/api/account") {
        return await handleGetAccount(request, env);
      }
      if (request.method === "GET" && url.pathname === "/api/api-keys") {
        return await handleListApiKeys(request, env);
      }
      if (request.method === "POST" && url.pathname === "/api/api-keys") {
        return await handleCreateApiKey(request, env);
      }
      if (request.method === "DELETE" && /^\/api\/api-keys\/[^/]+$/.test(url.pathname)) {
        return await handleRevokeApiKey(request, env, url.pathname.split("/")[3]);
      }
      if (request.method === "GET" && url.pathname === "/api/invoices") {
        return await handleListInvoices(request, env);
      }
      if (request.method === "GET" && url.pathname === "/api/requests") {
        return await handleListRequests(request, env);
      }
      if (request.method === "POST" && /^\/api\/invoices\/[^/]+\/pay\/quote$/.test(url.pathname)) {
        return await handleInvoicePayQuote(request, env, url.pathname.split("/")[3]);
      }
      if (request.method === "POST" && /^\/api\/invoices\/[^/]+\/pay\/settle$/.test(url.pathname)) {
        return await handleInvoicePaySettle(request, env, url.pathname.split("/")[3]);
      }
      if (request.method === "POST" && /^\/api\/invoices\/[^/]+\/pay\/autopay\/start$/.test(url.pathname)) {
        return await handleInvoiceAutopayStart(request, env, url.pathname.split("/")[3]);
      }
      if (request.method === "POST" && /^\/api\/invoices\/[^/]+\/pay\/autopay\/complete$/.test(url.pathname)) {
        return await handleInvoiceAutopayComplete(request, env, url.pathname.split("/")[3]);
      }
      if (request.method === "POST" && url.pathname === "/api/refund") {
        return await handleRefundRequest(request, env);
      }
      if (request.method === "POST" && url.pathname.startsWith("/v1/")) {
        const endpoint = url.pathname.slice(4);
        return await handleV1Request(request, env, ctx, endpoint);
      }

      return errorResponse(404, "not_found", "No route matches this request.");
    } catch (error) {
      const httpError = asHttpError(error);
      if (httpError) {
        if (httpError.status >= 500) {
          console.error("Request failed", {
            status: httpError.status,
            code: httpError.code,
            message: httpError.message,
            extra: httpError.extra,
          });
        }
        return errorResponse(httpError.status, httpError.code, httpError.message, httpError.extra);
      }
      console.error("Unhandled request error", error);
      return errorResponse(500, "internal_error", "An internal error occurred.");
    }
  },
};

function handleGetConfig(env: Env): Response {
  return jsonResponse({
    x402_network: env.X402_NETWORK || BASE_MAINNET,
  });
}

async function handleAutopayWalletBalance(request: Request, env: Env): Promise<Response> {
  const eligibility = await requireAutopayWalletBalanceEligibility(request, env);
  const address = await fetchAutopayPayerAddress(requireAccountAutopayUrl(eligibility.account), eligibility.owner);
  if (!address) {
    return errorResponse(404, "autopay_payer_not_found", "No autopay payer wallet is available for this owner.");
  }
  const asset = normalizeEvmAddress(env.X402_ASSET || BASE_USDC);
  const decimals = parsePositiveInt(env.X402_ASSET_DECIMALS ?? "6", 6);
  const rpcUrl = getRpcUrl(env);
  const balance = await readErc20Balance(rpcUrl, asset, address);

  return jsonResponse({
    address,
    owner: eligibility.owner,
    account_id: eligibility.account.id,
    network: env.X402_NETWORK || BASE_MAINNET,
    asset,
    symbol: asset.toLowerCase() === BASE_USDC.toLowerCase() ? "USDC" : "TOKEN",
    decimals,
    balance_raw: balance.toString(),
    balance: formatTokenAmount(balance, decimals),
  });
}

async function handleGetSession(request: Request, env: Env): Promise<Response> {
  const session = await requireSession(request, env);
  return jsonResponse({
    owner: session.owner,
    autopay_url: session.autopay_url,
    expires_at: new Date(session.expires_at).toISOString(),
  });
}

async function handleLoginAutopayStart(request: Request, env: Env): Promise<Response> {
  const body = await readJsonObject(request);
  const autopayUrl = normalizeAutopayUrl(body.autopay_url ?? body.autopayUrl);
  const response = await fetch(`${autopayUrl}/api/auth/requests`, {
    method: "POST",
    headers: JSON_HEADERS,
    body: JSON.stringify({
      kind: "login",
      returnOrigin: new URL(request.url).origin,
      ttlSeconds: 300,
      network: env.X402_NETWORK || BASE_MAINNET,
    }),
  });

  const bodyJson = await response.json().catch(() => null) as Record<string, unknown> | null;
  if (!response.ok || !bodyJson) {
    return errorResponse(response.status || 502, "autopay_login_request_failed", "Autopay login request could not be created.", {
      autopay_response: bodyJson,
    });
  }

  const autopayRequestId = requireString(bodyJson.request_id, "request_id");
  const pollToken = requireString(bodyJson.poll_token, "poll_token");
  const verificationUriComplete = requireString(bodyJson.verification_uri_complete, "verification_uri_complete");
  const expiresIn = typeof bodyJson.expires_in === "number" ? bodyJson.expires_in : 300;
  const loginRequestId = await signLoginState(env, {
    autopay_url: autopayUrl,
    autopay_request_id: autopayRequestId,
    poll_token: pollToken,
    verification_uri_complete: verificationUriComplete,
    expires_at: Date.now() + expiresIn * 1000,
  });

  return jsonResponse({
    login_request_id: loginRequestId,
    status: "pending",
    verification_uri_complete: verificationUriComplete,
    websocket_uri_complete: typeof bodyJson.websocket_uri_complete === "string" ? bodyJson.websocket_uri_complete : undefined,
    expires_in: bodyJson.expires_in,
    interval: bodyJson.interval,
  }, { status: 201 });
}

async function handleLoginAutopayComplete(request: Request, env: Env): Promise<Response> {
  const body = await readJsonObject(request);
  const loginRequestId = requireString(body.login_request_id ?? body.id, "login_request_id");
  const state = await verifyLoginState(env, loginRequestId);

  const pollResponse = await fetch(`${state.autopay_url}/api/auth/requests/${encodeURIComponent(state.autopay_request_id)}/poll`, {
    headers: { "x-autopay-poll-token": state.poll_token },
  });
  const pollBody = await pollResponse.json().catch(() => null) as Record<string, unknown> | null;
  if (!pollResponse.ok || !pollBody) {
    throw new HttpError(pollResponse.status || 502, "autopay_login_poll_failed", "Autopay login status could not be checked.");
  }

  const status = requireString(pollBody.status, "status");
  if (status !== "approved") {
    return jsonResponse({
      status,
      login_request_id: loginRequestId,
      verification_uri_complete: state.verification_uri_complete,
      expires_at: pollBody.expires_at,
    });
  }

  const authorization = pollBody.authorization as Record<string, unknown> | undefined;
  const owner = typeof authorization?.owner === "string" ? authorization.owner : "";
  if (!owner) {
    throw new HttpError(502, "invalid_autopay_login_authorization", "Autopay login approval did not include owner wallet.");
  }
  const payerAddress = await fetchAutopayPayerAddress(state.autopay_url, owner);
  const normalizedOwner = normalizeEvmAddress(owner);
  const expiresAt = Date.now() + SESSION_TTL_SECONDS * 1000;
  const sessionToken = await signSessionState(env, {
    owner: normalizedOwner,
    autopay_url: state.autopay_url,
    expires_at: expiresAt,
  });

  return jsonResponse({
    status: "approved",
    login_request_id: loginRequestId,
    owner: normalizedOwner,
    payer_address: payerAddress,
    autopay_url: state.autopay_url,
    expires_at: new Date(expiresAt).toISOString(),
  }, {
    headers: {
      "set-cookie": serializeSessionCookie(request, sessionToken, expiresAt),
    },
  });
}

function handleLogout(request: Request): Response {
  return jsonResponse({ status: "logged_out" }, {
    headers: {
      "set-cookie": serializeExpiredSessionCookie(request),
    },
  });
}

async function handleDepositQuote(request: Request, env: Env): Promise<Response> {
  const body = await readJsonObject(request);
  const amount = parseMoney(String(body.amount ?? env.DEFAULT_MIN_DEPOSIT ?? "5.00"));
  if (amount <= 0) {
    return errorResponse(400, "invalid_amount", "Deposit amount must be greater than zero.");
  }

  const paymentId = makeId("pay");
  const requirement = createPaymentRequirement(request, env, {
    kind: "deposit",
    id: paymentId,
    amount,
    description: "Refundable Meteria402 API deposit",
  });

  const expiresAt = Date.now() + 10 * 60 * 1000;
  const quoteToken = await signDepositQuote(env, {
    payment_id: paymentId,
    kind: "deposit",
    amount,
    currency: "USD",
    payment_requirement: requirement,
    expires_at: expiresAt,
  });

  return jsonResponse({
    payment_id: paymentId,
    amount: formatMoney(amount),
    currency: "USD",
    payment_requirement: requirement,
    quote_token: quoteToken,
    expires_at: new Date(expiresAt).toISOString(),
  });
}

async function handleDepositSettle(request: Request, env: Env): Promise<Response> {
  const body = await readJsonObject(request);
  const quote = await verifyDepositQuote(env, requireString(body.quote_token ?? body.quoteToken, "quote_token"));
  const paymentId = requireString(body.payment_id ?? quote.payment_id, "payment_id");
  if (paymentId !== quote.payment_id) {
    return errorResponse(400, "payment_quote_mismatch", "Payment ID does not match the deposit quote.");
  }
  const paymentPayload = body.payment_payload ?? body.paymentPayload ?? null;
  const devProof = typeof body.dev_proof === "string" ? body.dev_proof : undefined;
  const session = await readOptionalSession(request, env);
  const ownerAddress = body.owner_address == null && body.ownerAddress == null
    ? session?.owner ?? null
    : normalizeEvmAddress(body.owner_address ?? body.ownerAddress);
  const autopayUrl = body.autopay_url == null && body.autopayUrl == null
    ? session?.autopay_url ?? null
    : normalizeAutopayUrl(body.autopay_url ?? body.autopayUrl);

  const paymentRequirementJson = JSON.stringify(quote.payment_requirement);
  const settlement = await verifyPayment(env, paymentRequirementJson, paymentPayload, devProof);
  if (!settlement.ok) {
    return errorResponse(402, "payment_required", settlement.message, settlementErrorExtra(settlement));
  }

  const existingPayment = await env.DB.prepare(
    `SELECT status FROM meteria402_payments WHERE id = ? AND kind = 'deposit'`
  )
    .bind(paymentId)
    .first<{ status: string }>();
  if (existingPayment?.status === "settled") {
    return errorResponse(409, "payment_already_settled", "This deposit payment has already been settled.");
  }

  const accountId = makeId("acct");
  const apiKey = await createApiKey();
  const apiKeyHash = await sha256Hex(apiKey.secret);
  const now = new Date().toISOString();
  const payloadHash = await sha256Hex(JSON.stringify(paymentPayload ?? { dev_proof: devProof, payment_id: paymentId }));
  const minDeposit = parseMoney(env.DEFAULT_MIN_DEPOSIT ?? "5.00");
  const concurrencyLimit = parsePositiveInt(env.DEFAULT_CONCURRENCY_LIMIT ?? "1", 1);
  const existingPayload = await env.DB.prepare(
    `SELECT id FROM meteria402_payments WHERE x402_payload_hash = ?`
  )
    .bind(payloadHash)
    .first<{ id: string }>();
  if (existingPayload) {
    return errorResponse(409, "payment_already_used", "This payment payload has already been settled.");
  }
  if (ownerAddress) {
    const existingOwnerAccount = await getAccountByOwner(env, ownerAddress);
    if (existingOwnerAccount) {
      return errorResponse(409, "owner_account_exists", "This owner wallet already has an account.");
    }
  }

  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO meteria402_accounts
       (id, status, owner_address, autopay_url, deposit_balance, unpaid_invoice_total, active_request_count, concurrency_limit, min_deposit_required, refund_address, created_at, updated_at)
       VALUES (?, 'active', ?, ?, ?, 0, 0, ?, ?, ?, ?, ?)`
    ).bind(accountId, ownerAddress, autopayUrl, quote.amount, concurrencyLimit, minDeposit, settlement.payerAddress ?? null, now, now),
    env.DB.prepare(
      `INSERT INTO meteria402_payments
       (id, account_id, kind, amount, currency, status, x402_payload_hash, tx_hash, payment_requirement_json, response_json, created_at, settled_at)
       VALUES (?, ?, 'deposit', ?, 'USD', 'settled', ?, ?, ?, ?, ?, ?)`
    ).bind(paymentId, accountId, quote.amount, payloadHash, settlement.txHash ?? null, paymentRequirementJson, JSON.stringify(settlement.raw ?? {}), now, now),
    env.DB.prepare(
      `INSERT INTO meteria402_api_keys (id, account_id, key_hash, key_prefix, key_suffix, name, expires_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, NULL, ?)`
    ).bind(apiKey.id, accountId, apiKeyHash, apiKey.prefix, apiKey.keySuffix, randomApiKeyName(), now),
    env.DB.prepare(
      `INSERT INTO meteria402_ledger_entries (id, account_id, type, amount, currency, related_payment_id, created_at)
       VALUES (?, ?, 'deposit_paid', ?, 'USD', ?, ?)`
    ).bind(makeId("led"), accountId, quote.amount, paymentId, now),
  ]);

  return jsonResponse({
    account_id: accountId,
    api_key: apiKey.secret,
    api_key_suffix: apiKey.keySuffix,
    deposit_balance: formatMoney(quote.amount),
    tx_hash: settlement.txHash,
    payer_address: settlement.payerAddress,
    message: "Store this API key now. It cannot be shown again.",
  });
}

async function handleDepositAutopayStart(request: Request, env: Env, paymentId: string): Promise<Response> {
  const body = await readJsonObject(request);
  const quoteToken = requireString(body.quote_token ?? body.quoteToken, "quote_token");
  const autopayUrl = normalizeAutopayUrl(body.autopay_url ?? body.autopayUrl);
  const quote = await verifyDepositQuote(env, quoteToken);
  if (paymentId !== quote.payment_id) {
    return errorResponse(400, "payment_quote_mismatch", "Payment ID does not match the deposit quote.");
  }

  return startAutopayForDepositQuote(request, env, quote, quoteToken, autopayUrl);
}

async function handleDepositAutopayComplete(request: Request, env: Env, paymentId: string): Promise<Response> {
  const body = await readJsonObject(request);
  const autopayState = await verifyDepositAutopayState(env, requireString(body.autopay_state ?? body.autopayState, "autopay_state"));
  if (paymentId !== autopayState.payment_id) {
    return errorResponse(400, "payment_autopay_mismatch", "Payment ID does not match the autopay state.");
  }
  const result = await completeAutopayForDepositQuote(env, autopayState);
  if (result.status !== "approved") return jsonResponse(result);

  const settleRequest = new Request(new URL("/api/deposits/settle", request.url), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      payment_id: paymentId,
      quote_token: autopayState.quote_token,
      payment_payload: result.payment_payload,
      owner_address: result.owner,
      autopay_url: autopayState.autopay_url,
    }),
  });
  const settleResponse = await handleDepositSettle(settleRequest, env);
  const settlement = await settleResponse.json().catch(() => null);
  return jsonResponse({
    status: settleResponse.ok ? "settled" : "settle_failed",
    autopay_status: result.status,
    settlement,
  }, { status: settleResponse.status });
}

async function handleGetAccount(request: Request, env: Env): Promise<Response> {
  const account = await authenticate(request, env);
  if (account instanceof Response) return account;

  return jsonResponse({
    account_id: account.id,
    current_api_key_id: account.api_key_id,
    status: account.status,
    deposit_balance: formatMoney(account.deposit_balance),
    unpaid_invoice_total: formatMoney(account.unpaid_invoice_total),
    active_request_count: account.active_request_count,
    concurrency_limit: account.concurrency_limit,
    min_deposit_required: formatMoney(account.min_deposit_required),
  });
}

async function handleListApiKeys(request: Request, env: Env): Promise<Response> {
  const account = await authenticate(request, env);
  if (account instanceof Response) return account;

  const rows = await env.DB.prepare(
    `SELECT id, key_prefix, key_suffix, name, expires_at, created_at, revoked_at
     FROM meteria402_api_keys
     WHERE account_id = ?
     ORDER BY created_at DESC`
  )
    .bind(account.id)
    .all<{
      id: string;
      key_prefix: string;
      key_suffix: string;
      name: string | null;
      expires_at: string | null;
      created_at: string;
      revoked_at: string | null;
    }>();

  return jsonResponse({
    current_api_key_id: account.api_key_id,
    api_keys: rows.results.map((row) => ({
      id: row.id,
      name: row.name || "Unnamed key",
      prefix: row.key_prefix,
      key_suffix: row.key_suffix,
      status: keyStatus(row.revoked_at, row.expires_at),
      expires_at: row.expires_at,
      created_at: row.created_at,
      revoked_at: row.revoked_at,
    })),
  });
}

async function handleCreateApiKey(request: Request, env: Env): Promise<Response> {
  const account = await authenticate(request, env);
  if (account instanceof Response) return account;

  const body = await readOptionalJsonObject(request);
  const name = normalizeApiKeyName(body.name);
  const expiresAt = normalizeApiKeyExpiresAt(body.expires_at ?? body.expiresAt);
  const apiKey = await createApiKey();
  const apiKeyHash = await sha256Hex(apiKey.secret);
  const now = new Date().toISOString();

  await env.DB.prepare(
    `INSERT INTO meteria402_api_keys (id, account_id, key_hash, key_prefix, key_suffix, name, expires_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(apiKey.id, account.id, apiKeyHash, apiKey.prefix, apiKey.keySuffix, name, expiresAt, now)
    .run();

  return jsonResponse({
    api_key_id: apiKey.id,
    api_key: apiKey.secret,
    name,
    prefix: apiKey.prefix,
    key_suffix: apiKey.keySuffix,
    expires_at: expiresAt,
    created_at: now,
    message: "Store this API key now. It cannot be shown again.",
  }, { status: 201 });
}

async function handleRevokeApiKey(request: Request, env: Env, apiKeyId: string): Promise<Response> {
  const account = await authenticate(request, env);
  if (account instanceof Response) return account;
  if (apiKeyId === account.api_key_id) {
    return errorResponse(409, "cannot_revoke_current_key", "Switch to another API key before revoking the current key.");
  }

  const now = new Date().toISOString();
  const result = await env.DB.prepare(
    `UPDATE meteria402_api_keys
     SET revoked_at = COALESCE(revoked_at, ?)
     WHERE id = ? AND account_id = ?`
  )
    .bind(now, apiKeyId, account.id)
    .run();

  if (result.meta.changes === 0) {
    return errorResponse(404, "api_key_not_found", "API key was not found.");
  }

  return jsonResponse({
    api_key_id: apiKeyId,
    status: "revoked",
    revoked_at: now,
  });
}

async function handleListInvoices(request: Request, env: Env): Promise<Response> {
  const account = await authenticate(request, env);
  if (account instanceof Response) return account;

  const rows = await env.DB.prepare(
    `SELECT id, request_id, status, amount_due, currency, created_at, paid_at
     FROM meteria402_invoices
     WHERE account_id = ?
     ORDER BY created_at DESC
     LIMIT 100`
  )
    .bind(account.id)
    .all<{
      id: string;
      request_id: string | null;
      status: string;
      amount_due: number;
      currency: string;
      created_at: string;
      paid_at: string | null;
    }>();

  return jsonResponse({
    invoices: rows.results.map((row) => ({
      ...row,
      amount_due: formatMoney(row.amount_due),
    })),
  });
}

async function handleListRequests(request: Request, env: Env): Promise<Response> {
  const account = await authenticate(request, env);
  if (account instanceof Response) return account;

  const rows = await env.DB.prepare(
    `SELECT r.id, r.status, r.model, r.stream, r.ai_gateway_log_id,
            r.input_tokens, r.output_tokens, r.total_tokens, r.final_cost,
            r.error_code, r.started_at, r.completed_at,
            i.id AS invoice_id, i.status AS invoice_status, i.amount_due AS invoice_amount_due
     FROM meteria402_requests r
     LEFT JOIN meteria402_invoices i ON i.request_id = r.id
     WHERE r.account_id = ?
     ORDER BY r.started_at DESC
     LIMIT 100`
  )
    .bind(account.id)
    .all<{
      id: string;
      status: string;
      model: string | null;
      stream: number;
      ai_gateway_log_id: string | null;
      input_tokens: number | null;
      output_tokens: number | null;
      total_tokens: number | null;
      final_cost: number | null;
      error_code: string | null;
      started_at: string;
      completed_at: string | null;
      invoice_id: string | null;
      invoice_status: string | null;
      invoice_amount_due: number | null;
    }>();

  return jsonResponse({
    requests: rows.results.map((row) => ({
      id: row.id,
      status: row.status,
      model: row.model,
      stream: Boolean(row.stream),
      ai_gateway_log_id: row.ai_gateway_log_id,
      input_tokens: row.input_tokens,
      output_tokens: row.output_tokens,
      total_tokens: row.total_tokens,
      final_cost: row.final_cost == null ? null : formatMoney(row.final_cost),
      error_code: row.error_code,
      started_at: row.started_at,
      completed_at: row.completed_at,
      invoice: row.invoice_id
        ? {
            id: row.invoice_id,
            status: row.invoice_status,
            amount_due: row.invoice_amount_due == null ? null : formatMoney(row.invoice_amount_due),
          }
        : null,
    })),
  });
}

async function handleInvoicePayQuote(request: Request, env: Env, invoiceId: string): Promise<Response> {
  const account = await authenticate(request, env);
  if (account instanceof Response) return account;

  const invoice = await env.DB.prepare(
    `SELECT id, amount_due, status
     FROM meteria402_invoices
     WHERE id = ? AND account_id = ?`
  )
    .bind(invoiceId, account.id)
    .first<{ id: string; amount_due: number; status: string }>();

  if (!invoice) {
    return errorResponse(404, "invoice_not_found", "Invoice was not found.");
  }
  if (invoice.status !== "unpaid") {
    return errorResponse(409, "invoice_not_payable", "Only unpaid invoices can be paid.");
  }

  const paymentId = makeId("pay");
  const requirement = createPaymentRequirement(request, env, {
    kind: "invoice",
    id: invoice.id,
    amount: invoice.amount_due,
    description: `Meteria402 invoice ${invoice.id}`,
  });

  await env.DB.prepare(
    `INSERT INTO meteria402_payments
     (id, account_id, invoice_id, kind, amount, currency, status, payment_requirement_json)
     VALUES (?, ?, ?, 'invoice', ?, 'USD', 'pending', ?)`
  )
    .bind(paymentId, account.id, invoice.id, invoice.amount_due, JSON.stringify(requirement))
    .run();

  return jsonResponse({
    payment_id: paymentId,
    invoice_id: invoice.id,
    amount: formatMoney(invoice.amount_due),
    currency: "USD",
    payment_requirement: requirement,
  });
}

async function handleInvoicePaySettle(request: Request, env: Env, invoiceId: string): Promise<Response> {
  const account = await authenticate(request, env);
  if (account instanceof Response) return account;

  const body = await readJsonObject(request);
  const paymentId = requireString(body.payment_id, "payment_id");
  const paymentPayload = body.payment_payload ?? body.paymentPayload ?? null;
  const devProof = typeof body.dev_proof === "string" ? body.dev_proof : undefined;

  const payment = await env.DB.prepare(
    `SELECT p.id, p.amount, p.status, p.payment_requirement_json, i.status AS invoice_status
     FROM meteria402_payments p
     JOIN meteria402_invoices i ON i.id = p.invoice_id
     WHERE p.id = ? AND p.invoice_id = ? AND p.account_id = ? AND p.kind = 'invoice'`
  )
    .bind(paymentId, invoiceId, account.id)
    .first<{
      id: string;
      amount: number;
      status: string;
      payment_requirement_json: string;
      invoice_status: string;
    }>();

  if (!payment) {
    return errorResponse(404, "payment_not_found", "Payment quote was not found.");
  }
  if (payment.status === "settled") {
    return errorResponse(409, "payment_already_settled", "This invoice payment has already been settled.");
  }
  if (payment.invoice_status !== "unpaid") {
    return errorResponse(409, "invoice_not_payable", "Only unpaid invoices can be paid.");
  }

  const settlement = await verifyPayment(env, payment.payment_requirement_json, paymentPayload, devProof);
  if (!settlement.ok) {
    return errorResponse(402, "payment_required", settlement.message, settlementErrorExtra(settlement));
  }

  const now = new Date().toISOString();
  const payloadHash = await sha256Hex(JSON.stringify(paymentPayload ?? { dev_proof: devProof, payment_id: paymentId }));

  await env.DB.batch([
    env.DB.prepare(
      `UPDATE meteria402_payments
       SET status = 'settled', x402_payload_hash = ?, tx_hash = ?, response_json = ?, settled_at = ?
       WHERE id = ? AND status = 'pending'`
    ).bind(payloadHash, settlement.txHash ?? null, JSON.stringify(settlement.raw ?? {}), now, paymentId),
    env.DB.prepare(
      `UPDATE meteria402_invoices
       SET status = 'paid', paid_at = ?
       WHERE id = ? AND account_id = ? AND status = 'unpaid'`
    ).bind(now, invoiceId, account.id),
    env.DB.prepare(
      `UPDATE meteria402_accounts
       SET unpaid_invoice_total = MAX(0, unpaid_invoice_total - ?), updated_at = ?
       WHERE id = ?`
    ).bind(payment.amount, now, account.id),
    env.DB.prepare(
      `INSERT INTO meteria402_ledger_entries (id, account_id, type, amount, currency, related_invoice_id, related_payment_id, created_at)
       VALUES (?, ?, 'invoice_paid', ?, 'USD', ?, ?, ?)`
    ).bind(makeId("led"), account.id, payment.amount, invoiceId, paymentId, now),
  ]);

  return jsonResponse({
    invoice_id: invoiceId,
    payment_id: paymentId,
    status: "paid",
    amount: formatMoney(payment.amount),
  });
}

async function handleInvoiceAutopayStart(request: Request, env: Env, invoiceId: string): Promise<Response> {
  const account = await authenticate(request, env);
  if (account instanceof Response) return account;

  const invoice = await env.DB.prepare(
    `SELECT id, amount_due, status
     FROM meteria402_invoices
     WHERE id = ? AND account_id = ?`
  )
    .bind(invoiceId, account.id)
    .first<{ id: string; amount_due: number; status: string }>();

  if (!invoice) {
    return errorResponse(404, "invoice_not_found", "Invoice was not found.");
  }
  if (invoice.status !== "unpaid") {
    return errorResponse(409, "invoice_not_payable", "Only unpaid invoices can be paid.");
  }

  const paymentId = makeId("pay");
  const requirement = createPaymentRequirement(request, env, {
    kind: "invoice",
    id: invoice.id,
    amount: invoice.amount_due,
    description: `Meteria402 invoice ${invoice.id}`,
  });

  await env.DB.prepare(
    `INSERT INTO meteria402_payments
     (id, account_id, invoice_id, kind, amount, currency, status, payment_requirement_json)
     VALUES (?, ?, ?, 'invoice', ?, 'USD', 'pending', ?)`
  )
    .bind(paymentId, account.id, invoice.id, invoice.amount_due, JSON.stringify(requirement))
    .run();

  return startAutopayForPayment(request, env, {
    id: paymentId,
    account_id: account.id,
    invoice_id: invoice.id,
    kind: "invoice",
    amount: invoice.amount_due,
    status: "pending",
    payment_requirement_json: JSON.stringify(requirement),
  });
}

async function handleInvoiceAutopayComplete(request: Request, env: Env, invoiceId: string): Promise<Response> {
  const account = await authenticate(request, env);
  if (account instanceof Response) return account;

  const body = await readJsonObject(request);
  const paymentId = requireString(body.payment_id, "payment_id");
  const payment = await env.DB.prepare(
    `SELECT id
     FROM meteria402_payments
     WHERE id = ? AND invoice_id = ? AND account_id = ? AND kind = 'invoice'`
  )
    .bind(paymentId, invoiceId, account.id)
    .first<{ id: string }>();
  if (!payment) {
    return errorResponse(404, "payment_not_found", "Payment quote was not found.");
  }

  const result = await completeAutopayForPayment(env, paymentId);
  if (result.status !== "approved") return jsonResponse(result);

  const settleRequest = new Request(new URL(`/api/invoices/${invoiceId}/pay/settle`, request.url), {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: request.headers.get("authorization") || "",
    },
    body: JSON.stringify({
      payment_id: paymentId,
      payment_payload: result.payment_payload,
    }),
  });
  const settleResponse = await handleInvoicePaySettle(settleRequest, env, invoiceId);
  if (settleResponse.ok) {
    await markAutopaySettled(env, result.autopay_request_id);
  }
  const settlement = await settleResponse.json().catch(() => null);
  return jsonResponse({
    status: settleResponse.ok ? "settled" : "settle_failed",
    autopay_status: result.status,
    settlement,
  }, { status: settleResponse.status });
}

async function startAutopayForPayment(
  request: Request,
  env: Env,
  payment: {
    id: string;
    account_id: string | null;
    invoice_id: string | null;
    kind: string;
    amount: number;
    status: string;
    payment_requirement_json: string;
  },
): Promise<Response> {
  const autopayUrl = await requirePaymentAccountAutopayUrl(env, payment.account_id);
  const paymentRequired = JSON.parse(payment.payment_requirement_json) as PaymentRequirement;
  const policyValidBefore = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
  const response = await fetch(`${autopayUrl}/api/auth/requests`, {
    method: "POST",
    headers: JSON_HEADERS,
    body: JSON.stringify({
      paymentRequired,
      returnOrigin: new URL(request.url).origin,
      ttlSeconds: 300,
      policyValidBefore,
    }),
  });

  const body = await response.json().catch(() => null) as Record<string, unknown> | null;
  if (!response.ok || !body) {
    return errorResponse(response.status || 502, "autopay_request_failed", "Autopay authorization request could not be created.", {
      autopay_response: body,
    });
  }

  const autopayRequestId = requireString(body.request_id, "request_id");
  const pollToken = requireString(body.poll_token, "poll_token");
  const verificationUriComplete = requireString(body.verification_uri_complete, "verification_uri_complete");
  const autopayRecordId = makeId("ap");
  const now = new Date().toISOString();

  await env.DB.prepare(
    `INSERT INTO meteria402_autopay_requests
     (id, payment_id, account_id, invoice_id, autopay_url, autopay_request_id, poll_token, status, verification_uri_complete, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`
  )
    .bind(autopayRecordId, payment.id, payment.account_id, payment.invoice_id, autopayUrl, autopayRequestId, pollToken, verificationUriComplete, now)
    .run();

  return jsonResponse({
    id: autopayRecordId,
    payment_id: payment.id,
    invoice_id: payment.invoice_id,
    status: "pending",
    verification_uri_complete: verificationUriComplete,
    websocket_uri_complete: typeof body.websocket_uri_complete === "string" ? body.websocket_uri_complete : undefined,
    expires_in: body.expires_in,
    interval: body.interval,
  }, { status: 201 });
}

async function startAutopayForDepositQuote(
  request: Request,
  env: Env,
  quote: DepositQuoteState,
  quoteToken: string,
  autopayUrl: string,
): Promise<Response> {
  const policyValidBefore = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
  const response = await fetch(`${autopayUrl}/api/auth/requests`, {
    method: "POST",
    headers: JSON_HEADERS,
    body: JSON.stringify({
      paymentRequired: quote.payment_requirement,
      returnOrigin: new URL(request.url).origin,
      ttlSeconds: 300,
      policyValidBefore,
    }),
  });

  const body = await response.json().catch(() => null) as Record<string, unknown> | null;
  if (!response.ok || !body) {
    return errorResponse(response.status || 502, "autopay_request_failed", "Autopay authorization request could not be created.", {
      autopay_response: body,
    });
  }

  const autopayRequestId = requireString(body.request_id, "request_id");
  const pollToken = requireString(body.poll_token, "poll_token");
  const verificationUriComplete = requireString(body.verification_uri_complete, "verification_uri_complete");
  const expiresAt = Date.now() + 10 * 60 * 1000;
  const autopayState = await signDepositAutopayState(env, {
    payment_id: quote.payment_id,
    quote_token: quoteToken,
    autopay_url: autopayUrl,
    autopay_request_id: autopayRequestId,
    poll_token: pollToken,
    verification_uri_complete: verificationUriComplete,
    expires_at: expiresAt,
  });

  return jsonResponse({
    payment_id: quote.payment_id,
    status: "pending",
    verification_uri_complete: verificationUriComplete,
    websocket_uri_complete: typeof body.websocket_uri_complete === "string" ? body.websocket_uri_complete : undefined,
    expires_in: body.expires_in,
    interval: body.interval,
    autopay_state: autopayState,
  }, { status: 201 });
}

async function completeAutopayForPayment(env: Env, paymentId: string): Promise<Record<string, unknown> & { status: string; autopay_request_id?: string; payment_payload?: unknown }> {
  const record = await env.DB.prepare(
    `SELECT id, payment_id, account_id, invoice_id, autopay_url, autopay_request_id, poll_token, status, verification_uri_complete
     FROM meteria402_autopay_requests
     WHERE payment_id = ?
     ORDER BY created_at DESC
     LIMIT 1`
  )
    .bind(paymentId)
    .first<AutopayRequestRow>();

  if (!record) {
    throw new HttpError(404, "autopay_request_not_found", "Autopay request was not found for this payment.");
  }
  if (record.status === "settled") {
    return { status: "settled", payment_id: paymentId, autopay_request_id: record.id };
  }

  const pollResponse = await fetch(`${record.autopay_url}/api/auth/requests/${encodeURIComponent(record.autopay_request_id)}/poll`, {
    headers: { "x-autopay-poll-token": record.poll_token },
  });
  const pollBody = await pollResponse.json().catch(() => null) as Record<string, unknown> | null;
  if (!pollResponse.ok || !pollBody) {
    throw new HttpError(pollResponse.status || 502, "autopay_poll_failed", "Autopay authorization status could not be checked.");
  }

  const status = requireString(pollBody.status, "status");
  if (status !== "approved") {
    await updateAutopayStatus(env, record.id, status);
    return {
      status,
      payment_id: paymentId,
      autopay_request_id: record.id,
      verification_uri_complete: record.verification_uri_complete,
      expires_at: pollBody.expires_at,
    };
  }

  const authorization = pollBody.authorization as Record<string, unknown> | undefined;
  if (!authorization) {
    throw new HttpError(502, "invalid_autopay_authorization", "Autopay approval did not include authorization details.");
  }

  const payment = await env.DB.prepare(
    `SELECT payment_requirement_json
     FROM meteria402_payments
     WHERE id = ? AND status = 'pending'`
  )
    .bind(paymentId)
    .first<{ payment_requirement_json: string }>();
  if (!payment) {
    throw new HttpError(404, "payment_not_found", "Pending payment was not found.");
  }

  const paymentRequired = JSON.parse(payment.payment_requirement_json) as PaymentRequirement;
  const payResponse = await fetch(`${record.autopay_url}/api/pay`, {
    method: "POST",
    headers: JSON_HEADERS,
    body: JSON.stringify({
      siwe_message: authorization.siwe_message,
      siwe_signature: authorization.siwe_signature,
      paymentRequired,
    }),
  });
  const payBody = await payResponse.json().catch(() => null) as Record<string, unknown> | null;
  if (!payResponse.ok || !payBody) {
    throw new HttpError(payResponse.status || 502, "autopay_payment_failed", "Autopay payment payload could not be created.");
  }

  await updateAutopayStatus(env, record.id, "approved");
  return {
    status: "approved",
    payment_id: paymentId,
    autopay_request_id: record.id,
    payment_payload: payBody.payment_payload,
    selected_requirement: payBody.selected_requirement,
  };
}

async function completeAutopayForDepositQuote(
  env: Env,
  state: DepositAutopayState,
): Promise<Record<string, unknown> & { status: string; autopay_request_id?: string; payment_payload?: unknown; owner?: string }> {
  const quote = await verifyDepositQuote(env, state.quote_token);
  if (quote.payment_id !== state.payment_id) {
    throw new HttpError(400, "payment_quote_mismatch", "Payment ID does not match the deposit quote.");
  }

  const pollResponse = await fetch(`${state.autopay_url}/api/auth/requests/${encodeURIComponent(state.autopay_request_id)}/poll`, {
    headers: { "x-autopay-poll-token": state.poll_token },
  });
  const pollBody = await pollResponse.json().catch(() => null) as Record<string, unknown> | null;
  if (!pollResponse.ok || !pollBody) {
    throw new HttpError(pollResponse.status || 502, "autopay_poll_failed", "Autopay authorization status could not be checked.");
  }

  const status = requireString(pollBody.status, "status");
  if (status !== "approved") {
    return {
      status,
      payment_id: state.payment_id,
      autopay_request_id: state.autopay_request_id,
      verification_uri_complete: state.verification_uri_complete,
      expires_at: pollBody.expires_at,
    };
  }

  const authorization = pollBody.authorization as Record<string, unknown> | undefined;
  if (!authorization) {
    throw new HttpError(502, "invalid_autopay_authorization", "Autopay approval did not include authorization details.");
  }
  const owner = normalizeEvmAddress(authorization.owner);

  const payResponse = await fetch(`${state.autopay_url}/api/pay`, {
    method: "POST",
    headers: JSON_HEADERS,
    body: JSON.stringify({
      siwe_message: authorization.siwe_message,
      siwe_signature: authorization.siwe_signature,
      paymentRequired: quote.payment_requirement,
    }),
  });
  const payBody = await payResponse.json().catch(() => null) as Record<string, unknown> | null;
  if (!payResponse.ok || !payBody) {
    throw new HttpError(payResponse.status || 502, "autopay_payment_failed", "Autopay payment payload could not be created.");
  }

  return {
    status: "approved",
    payment_id: state.payment_id,
    autopay_request_id: state.autopay_request_id,
    owner,
    payment_payload: payBody.payment_payload,
    selected_requirement: payBody.selected_requirement,
  };
}

async function updateAutopayStatus(env: Env, id: string, status: string): Promise<void> {
  const approvedAt = status === "approved" ? new Date().toISOString() : null;
  await env.DB.prepare(
    `UPDATE meteria402_autopay_requests
     SET status = ?, approved_at = COALESCE(approved_at, ?)
     WHERE id = ?`
  )
    .bind(status, approvedAt, id)
    .run();
}

async function markAutopaySettled(env: Env, id: string | undefined): Promise<void> {
  if (!id) return;
  await env.DB.prepare(
    `UPDATE meteria402_autopay_requests
     SET status = 'settled', settled_at = ?
     WHERE id = ?`
  )
    .bind(new Date().toISOString(), id)
    .run();
}

async function fetchAutopayPayerAddress(autopayUrl: string, owner?: string): Promise<string | null> {
  const url = new URL("/api/capabilities", autopayUrl);
  if (owner) url.searchParams.set("owner", owner);
  const response = await fetch(url.toString());
  const body = await response.json().catch(() => null) as Record<string, unknown> | null;
  if (!response.ok || !body) return null;
  return typeof body.payer_address === "string" ? body.payer_address : null;
}

async function requireAutopayWalletBalanceEligibility(request: Request, env: Env): Promise<AutopayWalletBalanceEligibility> {
  const session = await requireSession(request, env);
  const owner = normalizeEvmAddress(session.owner);
  const account = await getAccountByOwner(env, owner);
  if (!account) {
    throw new HttpError(402, "deposit_required", "Deposit is required before loading the autopay wallet balance.", {
      owner,
    });
  }
  return { account, owner };
}

async function requireSession(request: Request, env: Env): Promise<SessionState> {
  const token = readCookie(request, SESSION_COOKIE_NAME);
  if (!token) {
    throw new HttpError(401, "missing_session", "Login is required.");
  }
  const session = await verifySessionState(env, token);
  return {
    ...session,
    owner: normalizeEvmAddress(session.owner),
  };
}

async function readOptionalSession(request: Request, env: Env): Promise<SessionState | null> {
  const token = readCookie(request, SESSION_COOKIE_NAME);
  if (!token) return null;
  try {
    const session = await verifySessionState(env, token);
    return {
      ...session,
      owner: normalizeEvmAddress(session.owner),
    };
  } catch {
    return null;
  }
}

function readCookie(request: Request, name: string): string | null {
  const header = request.headers.get("cookie");
  if (!header) return null;
  for (const part of header.split(";")) {
    const index = part.indexOf("=");
    if (index < 0) continue;
    const key = part.slice(0, index).trim();
    if (key !== name) continue;
    return decodeURIComponent(part.slice(index + 1).trim());
  }
  return null;
}

function serializeSessionCookie(request: Request, token: string, expiresAt: number): string {
  const attributes = [
    `${SESSION_COOKIE_NAME}=${encodeURIComponent(token)}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${SESSION_TTL_SECONDS}`,
    `Expires=${new Date(expiresAt).toUTCString()}`,
  ];
  if (new URL(request.url).protocol === "https:") attributes.push("Secure");
  return attributes.join("; ");
}

function serializeExpiredSessionCookie(request: Request): string {
  const attributes = [
    `${SESSION_COOKIE_NAME}=`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    "Max-Age=0",
    "Expires=Thu, 01 Jan 1970 00:00:00 GMT",
  ];
  if (new URL(request.url).protocol === "https:") attributes.push("Secure");
  return attributes.join("; ");
}

function requireAccountAutopayUrl(account: Account): string {
  if (!account.autopay_url) {
    throw new HttpError(409, "autopay_not_configured", "Autopay worker is not configured for this account.");
  }
  return normalizeAutopayUrl(account.autopay_url);
}

async function requirePaymentAccountAutopayUrl(env: Env, accountId: string | null): Promise<string> {
  if (!accountId) {
    throw new HttpError(409, "autopay_not_configured", "Autopay worker is not configured for this payment.");
  }
  const account = await getAccount(env, accountId);
  if (!account) {
    throw new HttpError(404, "account_not_found", "The account was not found.");
  }
  return requireAccountAutopayUrl(account);
}

async function handleRefundRequest(request: Request, env: Env): Promise<Response> {
  const account = await authenticate(request, env);
  if (account instanceof Response) return account;

  if (account.unpaid_invoice_total > 0) {
    return paymentRequiredResponse("unpaid_invoice", "All unpaid invoices must be paid before a refund can be requested.", {
      unpaid_invoice_total: formatMoney(account.unpaid_invoice_total),
    });
  }
  if (account.active_request_count > 0) {
    return errorResponse(409, "requests_running", "Refund cannot be requested while requests are running.");
  }

  const now = new Date().toISOString();
  await env.DB.prepare(
    `UPDATE meteria402_accounts
     SET status = 'refund_requested', updated_at = ?
     WHERE id = ? AND status = 'active'`
  )
    .bind(now, account.id)
    .run();

  return jsonResponse({
    account_id: account.id,
    status: "refund_requested",
    refundable_amount: formatMoney(account.deposit_balance),
  });
}

async function handleChatCompletions(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const account = await authenticate(request, env);
  if (account instanceof Response) return account;

  if (!env.CLOUDFLARE_ACCOUNT_ID) {
    return errorResponse(500, "missing_ai_gateway_config", "Cloudflare account ID is not configured.");
  }

  const body = await readJsonObject(request) as ChatBody;
  const stream = body.stream === true;
  if (stream) {
    body.stream_options = {
      ...(typeof body.stream_options === "object" && body.stream_options ? body.stream_options : {}),
      include_usage: true,
    };
  }

  const requestId = makeId("req");
  const started = await startMeteredRequest(env, account.id, requestId, String(body.model ?? ""), stream);
  if (started instanceof Response) return started;

  const upstreamRequest = buildAiGatewayRequest(env, JSON.stringify(body), "chat/completions", "application/json");
  let upstreamResponse: Response;
  try {
    upstreamResponse = await fetch(upstreamRequest);
  } catch (error) {
    await failMeteredRequest(env, account.id, requestId, "upstream_fetch_failed");
    console.error("AI Gateway request failed", error);
    return errorResponse(502, "upstream_fetch_failed", "The upstream AI Gateway request failed.");
  }

  if (!upstreamResponse.ok) {
    await failMeteredRequest(env, account.id, requestId, `upstream_${upstreamResponse.status}`);
    return copyResponse(upstreamResponse, {
      "meteria402-request-id": requestId,
    });
  }

  if (stream) {
    return proxyStreamingResponse(upstreamResponse, env, ctx, account.id, requestId, body);
  }

  const responseText = await upstreamResponse.text();
  const headers = cloneHeaders(upstreamResponse.headers);
  headers.set("meteria402-request-id", requestId);

  const usage = extractUsageFromText(responseText);
  if (!usage) {
    await markPendingReconcile(env, account.id, requestId);
    headers.set("meteria402-reconcile", "pending");
    return new Response(responseText, {
      status: upstreamResponse.status,
      statusText: upstreamResponse.statusText,
      headers,
    });
  }

  const cost = calculateCost(body.model, usage, env);
  const invoice = await settleMeteredRequest(env, account.id, requestId, body.model, usage, cost, upstreamResponse.headers);
  headers.set("meteria402-invoice-id", invoice.invoiceId);
  headers.set("meteria402-amount-due", formatMoney(cost));

  return new Response(responseText, {
    status: upstreamResponse.status,
    statusText: upstreamResponse.statusText,
    headers,
  });
}

async function handleV1Request(request: Request, env: Env, ctx: ExecutionContext, endpoint: string): Promise<Response> {
  if (endpoint === "chat/completions") {
    return handleChatCompletions(request, env, ctx);
  }
  return handleGenericV1Endpoint(request, env, endpoint);
}

async function handleGenericV1Endpoint(request: Request, env: Env, endpoint: string): Promise<Response> {
  const account = await authenticate(request, env);
  if (account instanceof Response) return account;

  if (!env.CLOUDFLARE_ACCOUNT_ID) {
    return errorResponse(500, "missing_ai_gateway_config", "Cloudflare account ID is not configured.");
  }

  const contentType = request.headers.get("content-type") || "";
  const isJsonBody = contentType.includes("application/json");

  let bodyJson: Record<string, unknown> | null = null;
  let upstreamBody: BodyInit;

  if (isJsonBody) {
    try {
      const bodyClone = request.clone();
      bodyJson = await readJsonObject(bodyClone);
      upstreamBody = JSON.stringify(bodyJson);
    } catch {
      upstreamBody = await request.arrayBuffer();
    }
  } else {
    upstreamBody = await request.arrayBuffer();
  }

  const model = typeof bodyJson?.model === "string" ? bodyJson.model : endpoint;
  const requestId = makeId("req");
  const started = await startMeteredRequest(env, account.id, requestId, model, false);
  if (started instanceof Response) return started;

  const upstreamRequest = buildAiGatewayRequest(env, upstreamBody, endpoint, contentType);
  let upstreamResponse: Response;
  try {
    upstreamResponse = await fetch(upstreamRequest);
  } catch (error) {
    await failMeteredRequest(env, account.id, requestId, "upstream_fetch_failed");
    console.error("AI Gateway request failed", error);
    return errorResponse(502, "upstream_fetch_failed", "The upstream AI Gateway request failed.");
  }

  if (!upstreamResponse.ok) {
    await failMeteredRequest(env, account.id, requestId, `upstream_${upstreamResponse.status}`);
    return copyResponse(upstreamResponse, { "meteria402-request-id": requestId });
  }

  const responseContentType = upstreamResponse.headers.get("content-type") || "";
  const responseIsJson = responseContentType.includes("application/json");

  let usage: Usage | null = null;
  let responseBody: ArrayBuffer | string;

  if (responseIsJson) {
    const responseText = await upstreamResponse.text();
    responseBody = responseText;
    usage = extractUsageFromText(responseText);
  } else {
    responseBody = await upstreamResponse.arrayBuffer();
  }

  const headers = cloneHeaders(upstreamResponse.headers);
  headers.set("meteria402-request-id", requestId);

  if (!usage) {
    await markPendingReconcile(env, account.id, requestId);
    headers.set("meteria402-reconcile", "pending");
    return new Response(responseBody, {
      status: upstreamResponse.status,
      statusText: upstreamResponse.statusText,
      headers,
    });
  }

  const cost = calculateCost(model, usage, env);
  const invoice = await settleMeteredRequest(env, account.id, requestId, model, usage, cost, upstreamResponse.headers);
  headers.set("meteria402-invoice-id", invoice.invoiceId);
  headers.set("meteria402-amount-due", formatMoney(cost));

  return new Response(responseBody, {
    status: upstreamResponse.status,
    statusText: upstreamResponse.statusText,
    headers,
  });
}

async function startMeteredRequest(
  env: Env,
  accountId: string,
  requestId: string,
  model: string,
  stream: boolean,
): Promise<true | Response> {
  const now = new Date().toISOString();
  const gate = await env.DB.prepare(
    `UPDATE meteria402_accounts
     SET active_request_count = active_request_count + 1, updated_at = ?
     WHERE id = ?
       AND status = 'active'
       AND unpaid_invoice_total = 0
       AND deposit_balance >= min_deposit_required
       AND active_request_count < concurrency_limit
     RETURNING id`
  )
    .bind(now, accountId)
    .first<{ id: string }>();

  if (!gate) {
    const account = await getAccount(env, accountId);
    if (!account) {
      return errorResponse(401, "invalid_api_key", "The API key is invalid.");
    }
    if (account.status !== "active") {
      return errorResponse(403, "account_not_active", "The account is not active.");
    }
    if (account.unpaid_invoice_total > 0) {
      return paymentRequiredResponse("unpaid_invoice", "An unpaid invoice must be paid before making another request.", {
        unpaid_invoice_total: formatMoney(account.unpaid_invoice_total),
      });
    }
    if (account.deposit_balance < account.min_deposit_required) {
      return paymentRequiredResponse("deposit_required", "A refundable deposit is required before making this request.", {
        required_deposit: formatMoney(account.min_deposit_required),
        current_deposit: formatMoney(account.deposit_balance),
      });
    }
    return errorResponse(429, "concurrency_limit_exceeded", "The account concurrency limit has been reached.");
  }

  try {
    await env.DB.prepare(
      `INSERT INTO meteria402_requests (id, account_id, status, model, stream, started_at)
       VALUES (?, ?, 'running', ?, ?, ?)`
    )
      .bind(requestId, accountId, model || null, stream ? 1 : 0, now)
      .run();
  } catch (error) {
    await decrementActiveRequest(env, accountId);
    throw error;
  }

  return true;
}

async function failMeteredRequest(env: Env, accountId: string, requestId: string, errorCode: string): Promise<void> {
  const now = new Date().toISOString();
  await env.DB.batch([
    env.DB.prepare(
      `UPDATE meteria402_requests
       SET status = 'failed', error_code = ?, completed_at = ?
       WHERE id = ? AND account_id = ?`
    ).bind(errorCode, now, requestId, accountId),
    env.DB.prepare(
      `UPDATE meteria402_accounts
       SET active_request_count = MAX(0, active_request_count - 1), updated_at = ?
       WHERE id = ?`
    ).bind(now, accountId),
  ]);
}

async function markPendingReconcile(env: Env, accountId: string, requestId: string): Promise<void> {
  const now = new Date().toISOString();
  await env.DB.batch([
    env.DB.prepare(
      `UPDATE meteria402_requests
       SET status = 'pending_reconcile', completed_at = ?
       WHERE id = ? AND account_id = ?`
    ).bind(now, requestId, accountId),
    env.DB.prepare(
      `UPDATE meteria402_accounts
       SET active_request_count = MAX(0, active_request_count - 1), updated_at = ?
       WHERE id = ?`
    ).bind(now, accountId),
  ]);
}

async function settleMeteredRequest(
  env: Env,
  accountId: string,
  requestId: string,
  model: unknown,
  usage: Usage,
  cost: number,
  upstreamHeaders: Headers,
): Promise<{ invoiceId: string }> {
  const now = new Date().toISOString();
  const invoiceId = makeId("inv");
  const aigLogId = upstreamHeaders.get("cf-aig-log-id") ?? upstreamHeaders.get("cf-ai-gateway-log-id");
  const requirement = createPaymentRequirementFromValues(env, {
    resource: `/api/invoices/${invoiceId}/pay`,
    kind: "invoice",
    id: invoiceId,
    amount: cost,
    description: `Meteria402 invoice ${invoiceId}`,
  });

  await env.DB.batch([
    env.DB.prepare(
      `UPDATE meteria402_requests
       SET status = 'completed',
           model = COALESCE(?, model),
           ai_gateway_log_id = ?,
           input_tokens = ?,
           output_tokens = ?,
           total_tokens = ?,
           final_cost = ?,
           completed_at = ?
       WHERE id = ? AND account_id = ?`
    ).bind(String(model ?? "") || null, aigLogId, usage.inputTokens, usage.outputTokens, usage.totalTokens, cost, now, requestId, accountId),
    env.DB.prepare(
      `INSERT INTO meteria402_invoices
       (id, account_id, request_id, status, amount_due, currency, payment_requirement_json, created_at)
       VALUES (?, ?, ?, 'unpaid', ?, 'USD', ?, ?)`
    ).bind(invoiceId, accountId, requestId, cost, JSON.stringify(requirement), now),
    env.DB.prepare(
      `UPDATE meteria402_accounts
       SET active_request_count = MAX(0, active_request_count - 1),
           unpaid_invoice_total = unpaid_invoice_total + ?,
           updated_at = ?
       WHERE id = ?`
    ).bind(cost, now, accountId),
    env.DB.prepare(
      `INSERT INTO meteria402_ledger_entries
       (id, account_id, type, amount, currency, related_request_id, related_invoice_id, created_at)
       VALUES (?, ?, 'invoice_created', ?, 'USD', ?, ?, ?)`
    ).bind(makeId("led"), accountId, cost, requestId, invoiceId, now),
  ]);

  return { invoiceId };
}

async function decrementActiveRequest(env: Env, accountId: string): Promise<void> {
  await env.DB.prepare(
    `UPDATE meteria402_accounts
     SET active_request_count = MAX(0, active_request_count - 1), updated_at = ?
     WHERE id = ?`
  )
    .bind(new Date().toISOString(), accountId)
    .run();
}

function proxyStreamingResponse(
  upstreamResponse: Response,
  env: Env,
  ctx: ExecutionContext,
  accountId: string,
  requestId: string,
  body: ChatBody,
): Response {
  if (!upstreamResponse.body) {
    ctx.waitUntil(markPendingReconcile(env, accountId, requestId));
    return copyResponse(upstreamResponse, {
      "meteria402-request-id": requestId,
      "meteria402-reconcile": "pending",
    });
  }

  const headers = cloneHeaders(upstreamResponse.headers);
  headers.set("meteria402-request-id", requestId);
  const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
  const reader = upstreamResponse.body.getReader();
  const writer = writable.getWriter();
  const decoder = new TextDecoder();
  let buffer = "";
  let usage: Usage | null = null;

  ctx.waitUntil((async () => {
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value) {
          buffer += decoder.decode(value, { stream: true });
          usage = extractUsageFromSseBuffer(buffer) ?? usage;
          const lastDoubleBreak = Math.max(buffer.lastIndexOf("\n\n"), buffer.lastIndexOf("\r\n\r\n"));
          if (lastDoubleBreak >= 0) {
            buffer = buffer.slice(lastDoubleBreak + 2);
          }
          await writer.write(value);
        }
      }
      buffer += decoder.decode();
      usage = extractUsageFromSseBuffer(buffer) ?? usage;
      if (usage) {
        const cost = calculateCost(body.model, usage, env);
        await settleMeteredRequest(env, accountId, requestId, body.model, usage, cost, upstreamResponse.headers);
      } else {
        await markPendingReconcile(env, accountId, requestId);
      }
      await writer.close();
    } catch (error) {
      console.error("Streaming proxy failed", error);
      await failMeteredRequest(env, accountId, requestId, "stream_proxy_failed");
      await writer.abort(error);
    } finally {
      reader.releaseLock();
    }
  })());

  return new Response(readable, {
    status: upstreamResponse.status,
    statusText: upstreamResponse.statusText,
    headers,
  });
}

function buildAiGatewayRequest(env: Env, body: BodyInit, endpoint: string, contentType: string | null): Request {
  const gatewayId = env.AI_GATEWAY_ID || "default";
  const url = `https://gateway.ai.cloudflare.com/v1/${encodeURIComponent(env.CLOUDFLARE_ACCOUNT_ID || "")}/${encodeURIComponent(gatewayId)}/compat/${endpoint}`;
  const headers = new Headers();
  if (contentType) {
    headers.set("content-type", contentType);
  }
  if (env.AI_GATEWAY_API_KEY) {
    headers.set("authorization", `Bearer ${env.AI_GATEWAY_API_KEY}`);
  }
  if (env.AI_GATEWAY_AUTH_TOKEN) {
    headers.set("cf-aig-authorization", `Bearer ${env.AI_GATEWAY_AUTH_TOKEN}`);
  }
  return new Request(url, {
    method: "POST",
    headers,
    body,
  });
}

function calculateCost(model: unknown, usage: Usage, env: Env): number {
  const priceTable = parsePriceTable(env);
  const modelKey = typeof model === "string" ? model : "";
  const modelPrice = modelKey ? priceTable[modelKey] : undefined;
  const inputPrice = modelPrice?.input_micro_usd_per_token ?? parseMoneyLikeNumber(env.DEFAULT_INPUT_MICRO_USD_PER_TOKEN ?? "1");
  const outputPrice = modelPrice?.output_micro_usd_per_token ?? parseMoneyLikeNumber(env.DEFAULT_OUTPUT_MICRO_USD_PER_TOKEN ?? "4");
  const cost = Math.ceil(usage.inputTokens * inputPrice + usage.outputTokens * outputPrice);
  return Math.max(cost, 1);
}

function parsePriceTable(env: Env): Record<string, { input_micro_usd_per_token: number; output_micro_usd_per_token: number }> {
  const raw = (env as { PRICE_TABLE_JSON?: string }).PRICE_TABLE_JSON;
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as Record<string, { input_micro_usd_per_token?: unknown; output_micro_usd_per_token?: unknown }>;
    const table: Record<string, { input_micro_usd_per_token: number; output_micro_usd_per_token: number }> = {};
    for (const [key, value] of Object.entries(parsed)) {
      table[key] = {
        input_micro_usd_per_token: parseMoneyLikeNumber(String(value.input_micro_usd_per_token ?? "0")),
        output_micro_usd_per_token: parseMoneyLikeNumber(String(value.output_micro_usd_per_token ?? "0")),
      };
    }
    return table;
  } catch {
    return {};
  }
}

function extractUsageFromText(text: string): Usage | null {
  try {
    const json = JSON.parse(text) as { usage?: unknown };
    return normalizeUsage(json.usage);
  } catch {
    return null;
  }
}

function extractUsageFromSseBuffer(buffer: string): Usage | null {
  let latest: Usage | null = null;
  const lines = buffer.split(/\r?\n/);
  for (const line of lines) {
    if (!line.startsWith("data:")) continue;
    const data = line.slice(5).trim();
    if (!data || data === "[DONE]") continue;
    try {
      const parsed = JSON.parse(data) as { usage?: unknown };
      latest = normalizeUsage(parsed.usage) ?? latest;
    } catch {
      // Ignore partial or non-JSON server-sent events.
    }
  }
  return latest;
}

function normalizeUsage(value: unknown): Usage | null {
  if (!value || typeof value !== "object") return null;
  const usage = value as Record<string, unknown>;
  const input = numberFromUnknown(usage.prompt_tokens ?? usage.input_tokens);
  const output = numberFromUnknown(usage.completion_tokens ?? usage.output_tokens);
  const total = numberFromUnknown(usage.total_tokens) ?? ((input ?? 0) + (output ?? 0));
  if (input == null && output == null && total === 0) return null;
  return {
    inputTokens: input ?? Math.max(0, total - (output ?? 0)),
    outputTokens: output ?? Math.max(0, total - (input ?? 0)),
    totalTokens: total,
  };
}

async function authenticate(request: Request, env: Env): Promise<AuthenticatedAccount | Response> {
  const auth = request.headers.get("authorization") || "";
  const match = auth.match(/^Bearer\s+(.+)$/i);
  if (!match) {
    return errorResponse(401, "missing_api_key", "Missing bearer API key.");
  }

  const keyHash = await sha256Hex(match[1]);
  const account = await env.DB.prepare(
    `SELECT a.id, a.status, a.owner_address, a.autopay_url, a.deposit_balance, a.unpaid_invoice_total, a.active_request_count,
            a.concurrency_limit, a.min_deposit_required, a.refund_address, k.id AS api_key_id
     FROM meteria402_api_keys k
     JOIN meteria402_accounts a ON a.id = k.account_id
     WHERE k.key_hash = ?
       AND k.revoked_at IS NULL
       AND (k.expires_at IS NULL OR k.expires_at > ?)`
  )
    .bind(keyHash, new Date().toISOString())
    .first<AuthenticatedAccount>();

  if (!account) {
    return errorResponse(401, "invalid_api_key", "The API key is invalid.");
  }
  return account;
}

async function getAccount(env: Env, accountId: string): Promise<Account | null> {
  return env.DB.prepare(
    `SELECT id, status, owner_address, autopay_url, deposit_balance, unpaid_invoice_total, active_request_count,
            concurrency_limit, min_deposit_required, refund_address
     FROM meteria402_accounts
     WHERE id = ?`
  )
    .bind(accountId)
    .first<Account>();
}

async function getAccountByOwner(env: Env, owner: string): Promise<Account | null> {
  return env.DB.prepare(
    `SELECT id, status, owner_address, autopay_url, deposit_balance, unpaid_invoice_total, active_request_count,
            concurrency_limit, min_deposit_required, refund_address
     FROM meteria402_accounts
     WHERE lower(owner_address) = lower(?)
     LIMIT 1`
  )
    .bind(owner)
    .first<Account>();
}

async function verifyPayment(
  env: Env,
  paymentRequirementJson: string,
  paymentPayload: unknown,
  devProof?: string,
): Promise<{ ok: true; txHash?: string; payerAddress?: string; raw?: unknown } | { ok: false; message: string; facilitatorStatus?: number; raw?: unknown }> {
  if (env.ALLOW_DEV_PAYMENTS === "true" && devProof === "dev-paid") {
    return { ok: true, txHash: `dev:${makeId("tx")}`, raw: { dev: true } };
  }

  if (!env.X402_FACILITATOR_URL) {
    return {
      ok: false,
      message: "Payment facilitator is not configured.",
    };
  }
  if (!paymentPayload) {
    return {
      ok: false,
      message: "Payment payload is required.",
    };
  }

  const facilitatorHeaders = new Headers({
    "content-type": "application/json",
  });
  if (env.X402_FACILITATOR_AUTH_TOKEN) {
    facilitatorHeaders.set("authorization", `Bearer ${env.X402_FACILITATOR_AUTH_TOKEN}`);
  }

  const response = await fetch(facilitatorEndpoint(env.X402_FACILITATOR_URL, "settle"), {
    method: "POST",
    headers: facilitatorHeaders,
    body: JSON.stringify(facilitatorSettleBody(paymentRequirementJson, paymentPayload)),
  });

  const text = await response.text();
  let json: Record<string, unknown> = {};
  try {
    json = text ? JSON.parse(text) as Record<string, unknown> : {};
  } catch {
    json = { raw: text };
  }

  if (!response.ok || json.success === false || json.ok === false) {
    return {
      ok: false,
      message: facilitatorErrorMessage(json),
      facilitatorStatus: response.status,
      raw: json,
    };
  }

  return {
    ok: true,
    txHash: typeof json.tx_hash === "string" ? json.tx_hash : typeof json.transaction === "string" ? json.transaction : undefined,
    payerAddress: typeof json.payer === "string" ? json.payer : typeof json.from === "string" ? json.from : undefined,
    raw: json,
  };
}

function facilitatorErrorMessage(json: Record<string, unknown>): string {
  if (typeof json.message === "string" && json.message) return json.message;
  if (typeof json.errorMessage === "string" && json.errorMessage) return json.errorMessage;
  if (typeof json.errorReason === "string" && json.errorReason) return json.errorReason;
  const error = json.error;
  if (error && typeof error === "object") {
    const record = error as Record<string, unknown>;
    if (typeof record.message === "string" && record.message) return record.message;
    if (typeof record.reason === "string" && record.reason) return record.reason;
  }
  return "Payment could not be verified.";
}

function settlementErrorExtra(settlement: { facilitatorStatus?: number; raw?: unknown }): Record<string, unknown> {
  return {
    facilitator_status: settlement.facilitatorStatus,
    facilitator_response: settlement.raw ?? null,
  };
}

function facilitatorEndpoint(baseUrl: string, action: "settle" | "verify"): string {
  const trimmed = baseUrl.replace(/\/+$/g, "");
  if (trimmed.endsWith("/settle") || trimmed.endsWith("/verify")) {
    return trimmed;
  }
  return `${trimmed}/${action}`;
}

function createPaymentRequirement(
  request: Request,
  env: Env,
  input: { kind: string; id: string; amount: number; description: string },
): PaymentRequirement {
  const url = new URL(request.url);
  return createPaymentRequirementFromValues(env, {
    resource: `${url.origin}/api/payments/${input.id}`,
    ...input,
  });
}

function createPaymentRequirementFromValues(
  env: Env,
  input: { resource: string; kind: string; id: string; amount: number; description: string },
): PaymentRequirement {
  return {
    x402Version: 2,
    resource: {
      url: input.resource,
    },
    accepts: [
      {
        scheme: "exact",
        network: env.X402_NETWORK || BASE_MAINNET,
        asset: env.X402_ASSET || BASE_USDC,
        amount: x402AmountFromMicroUsd(input.amount, env),
        payTo: requireRecipientAddress(env),
        maxTimeoutSeconds: 300,
        extra: {
          name: getX402AssetDomainName(env),
          version: getX402AssetDomainVersion(env),
          description: input.description,
          service: "meteria402",
          kind: input.kind,
          id: input.id,
          amount_decimal: formatMoney(input.amount),
          currency: "USDC",
        },
      },
    ],
  };
}

function getX402AssetDomainName(env: Env): string {
  const configured = (env as { X402_ASSET_DOMAIN_NAME?: string }).X402_ASSET_DOMAIN_NAME?.trim();
  if (configured) return configured;
  const network = env.X402_NETWORK || BASE_MAINNET;
  const asset = (env.X402_ASSET || BASE_USDC).toLowerCase();
  if (network === "eip155:84532" && asset === "0x036cbd53842c5426634e7929541ec2318f3dcf7e") return "USDC";
  if (network === BASE_MAINNET && asset === BASE_USDC.toLowerCase()) return "USD Coin";
  return "USD Coin";
}

function getX402AssetDomainVersion(env: Env): string {
  return (env as { X402_ASSET_DOMAIN_VERSION?: string }).X402_ASSET_DOMAIN_VERSION?.trim() || "2";
}

function requireRecipientAddress(env: Env): string {
  const address = env.X402_RECIPIENT_ADDRESS?.trim();
  if (!address) {
    throw new HttpError(500, "missing_recipient_address", "X402_RECIPIENT_ADDRESS must be configured before creating payment quotes.");
  }
  if (!/^0x[a-fA-F0-9]{40}$/.test(address)) {
    throw new HttpError(500, "invalid_recipient_address", "X402_RECIPIENT_ADDRESS must be a valid EVM address.");
  }
  return address;
}

function facilitatorSettleBody(paymentRequirementJson: string, paymentPayload: unknown): Record<string, unknown> {
  const paymentRequired = JSON.parse(paymentRequirementJson) as Record<string, unknown>;
  const payload = paymentPayload as Record<string, unknown> | null;
  if (paymentRequired && typeof paymentRequired === "object" && Array.isArray(paymentRequired.accepts)) {
    const accepted = payload && typeof payload === "object" && payload.accepted && typeof payload.accepted === "object"
      ? payload.accepted
      : paymentRequired.accepts[0];
    return {
      x402Version: typeof payload?.x402Version === "number" ? payload.x402Version : paymentRequired.x402Version,
      paymentPayload,
      paymentRequirements: accepted,
    };
  }
  return {
    payment_payload: paymentPayload,
    payment_requirement: paymentRequired,
  };
}

function x402AmountFromMicroUsd(amount: number, env: Env): string {
  const decimals = parsePositiveInt(env.X402_ASSET_DECIMALS ?? "6", 6);
  if (decimals < 6) return String(Math.ceil(amount / 10 ** (6 - decimals)));
  return (BigInt(amount) * (10n ** BigInt(decimals - 6))).toString();
}

function getRpcUrl(env: Env): string {
  if (env.X402_RPC_URL?.trim()) return env.X402_RPC_URL.trim();
  if ((env.X402_NETWORK || BASE_MAINNET) === BASE_MAINNET) return "https://mainnet.base.org";
  throw new HttpError(500, "missing_rpc_url", "X402_RPC_URL must be configured for this network.");
}

function normalizeEvmAddress(value: unknown): string {
  if (typeof value !== "string" || !/^0x[a-fA-F0-9]{40}$/.test(value)) {
    throw new HttpError(400, "invalid_address", "A valid EVM address is required.");
  }
  return value;
}

async function readErc20Balance(rpcUrl: string, asset: string, owner: string): Promise<bigint> {
  const ownerSlot = owner.slice(2).toLowerCase().padStart(64, "0");
  const data = `0x70a08231${ownerSlot}`;
  const response = await fetch(rpcUrl, {
    method: "POST",
    headers: JSON_HEADERS,
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "eth_call",
      params: [{ to: asset, data }, "latest"],
    }),
  });
  const body = await response.json().catch(() => null) as { result?: unknown; error?: unknown } | null;
  if (!response.ok || !body || typeof body.result !== "string") {
    throw new HttpError(502, "wallet_balance_lookup_failed", "Autopay wallet balance could not be loaded.", {
      rpc_status: response.status,
      rpc_error: body?.error ?? null,
    });
  }
  return BigInt(body.result);
}

function formatTokenAmount(raw: bigint, decimals: number): string {
  const scale = 10n ** BigInt(decimals);
  const whole = raw / scale;
  const fraction = raw % scale;
  if (fraction === 0n) return whole.toString();
  const fractionText = fraction.toString().padStart(decimals, "0").replace(/0+$/g, "");
  return `${whole}.${fractionText}`;
}
