import {
  createApiKey,
  keyStatus,
  normalizeApiKeyExpiresAt,
  normalizeApiKeyName,
  randomApiKeyName,
} from "./api-keys";
import {
  authenticate,
  getAccount,
  getAccountByOwner,
  requireAccountAutopayUrl,
  requireAccountFromSession,
  requireAutopayWalletBalanceEligibility,
  requirePaymentAccountAutopayUrl,
} from "./accounts";
import { normalizeAutopayUrl } from "./autopay";
import {
  BASE_MAINNET,
  BASE_USDC,
  JSON_HEADERS,
} from "./constants";
import { makeId, sha256Hex } from "./crypto";
import { DEFAULT_GATEWAY_PROVIDER } from "./gateway-providers";
import {
  cloneHeaders,
  copyResponse,
  errorResponse,
  HttpError,
  jsonResponse,
  paymentRequiredResponse,
  readJsonObject,
  readOptionalJsonObject,
  requireString,
} from "./http";
import {
  formatMoney,
  numberFromUnknown,
  parseMoney,
  parseMoneyLikeNumber,
  parsePositiveInt,
} from "./money";
import {
  signDepositAutopayState,
  signDepositQuote,
  signLoginState,
  signSessionState,
  verifyDepositAutopayState,
  verifyDepositQuote,
  verifyLoginState,
} from "./signed-state";
import {
  readOptionalSession,
  requireSession,
  serializeExpiredSessionCookie,
  serializeSessionCookie,
  sessionExpiresAt,
} from "./session";
import type {
  AutopayRequestRow,
  ChatBody,
  DepositAutopayState,
  DepositQuoteState,
  Env,
  PaymentRequirement,
  Usage,
} from "./types";
import type { RouteHandlers } from "./routes";
import {
  createPaymentRequirement,
  createPaymentRequirementFromValues,
  formatTokenAmount,
  getRpcUrl,
  normalizeEvmAddress,
  readErc20Balance,
  requireRecipientAddress,
  settlementErrorExtra,
  verifyPayment,
  verifyTxHash,
  x402AmountFromMicroUsd,
} from "./x402";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export const routeHandlers: RouteHandlers = {
  handleGetConfig,
  handleAutopayWalletBalance,
  handleGetSession,
  handleLoginAutopayStart,
  handleLoginAutopayComplete,
  handleLogout,
  handleUpdateSessionAutopay,
  handleListDeposits,
  handleDepositQuote,
  handleDepositSettle,
  handleDepositAutopayStart,
  handleDepositAutopayComplete,
  handleGetAccount,
  handleListApiKeys,
  handleCreateApiKey,
  handleRevokeApiKey,
  handleListInvoices,
  handleListRequests,
  handleReconcileRequests,
  handleInvoicePayQuote,
  handleInvoicePaySettle,
  handleInvoiceAutopayStart,
  handleInvoiceAutopayComplete,
  handleRefundRequest,
  handleListAutopayCapabilities,
  handleCreateAutopayCapability,
  handleRevokeAutopayCapability,
  handleCompleteAutopayCapability,
  handleV1Request,
};

export function scheduledReconcile(env: Env, ctx: ExecutionContext): void {
  ctx.waitUntil(reconcilePendingGatewayLogs(env));
}

function handleGetConfig(env: Env): Response {
  return jsonResponse({
    x402_network: env.X402_NETWORK || BASE_MAINNET,
  });
}

async function handleAutopayWalletBalance(
  request: Request,
  env: Env,
): Promise<Response> {
  const eligibility = await requireAutopayWalletBalanceEligibility(
    request,
    env,
  );
  const address = await fetchAutopayPayerAddress(
    requireAccountAutopayUrl(eligibility.account),
    eligibility.owner,
  );
  if (!address) {
    return errorResponse(
      404,
      "autopay_payer_not_found",
      "No autopay payer wallet is available for this owner.",
    );
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

async function handleLoginAutopayStart(
  request: Request,
  env: Env,
): Promise<Response> {
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

  const bodyJson = (await response.json().catch(() => null)) as Record<
    string,
    unknown
  > | null;
  if (!response.ok || !bodyJson) {
    return errorResponse(
      response.status || 502,
      "autopay_login_request_failed",
      "Autopay login request could not be created.",
      {
        autopay_response: bodyJson,
      },
    );
  }

  const autopayRequestId = requireString(bodyJson.request_id, "request_id");
  const pollToken = requireString(bodyJson.poll_token, "poll_token");
  const verificationUriComplete = requireString(
    bodyJson.verification_uri_complete,
    "verification_uri_complete",
  );
  const expiresIn =
    typeof bodyJson.expires_in === "number" ? bodyJson.expires_in : 300;
  const loginRequestId = await signLoginState(env, {
    autopay_url: autopayUrl,
    autopay_request_id: autopayRequestId,
    poll_token: pollToken,
    verification_uri_complete: verificationUriComplete,
    expires_at: Date.now() + expiresIn * 1000,
  });

  return jsonResponse(
    {
      login_request_id: loginRequestId,
      status: "pending",
      verification_uri_complete: verificationUriComplete,
      websocket_uri_complete:
        typeof bodyJson.websocket_uri_complete === "string"
          ? bodyJson.websocket_uri_complete
          : undefined,
      expires_in: bodyJson.expires_in,
      interval: bodyJson.interval,
    },
    { status: 201 },
  );
}

async function handleLoginAutopayComplete(
  request: Request,
  env: Env,
): Promise<Response> {
  const body = await readJsonObject(request);
  const loginRequestId = requireString(
    body.login_request_id ?? body.id,
    "login_request_id",
  );
  const state = await verifyLoginState(env, loginRequestId);

  const pollResponse = await fetch(
    `${state.autopay_url}/api/auth/requests/${encodeURIComponent(state.autopay_request_id)}/poll`,
    {
      headers: { "x-autopay-poll-token": state.poll_token },
    },
  );
  const pollBody = (await pollResponse.json().catch(() => null)) as Record<
    string,
    unknown
  > | null;
  if (!pollResponse.ok || !pollBody) {
    throw new HttpError(
      pollResponse.status || 502,
      "autopay_login_poll_failed",
      "Autopay login status could not be checked.",
    );
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

  const authorization = pollBody.authorization as
    | Record<string, unknown>
    | undefined;
  const owner =
    typeof authorization?.owner === "string" ? authorization.owner : "";
  if (!owner) {
    throw new HttpError(
      502,
      "invalid_autopay_login_authorization",
      "Autopay login approval did not include owner wallet.",
    );
  }
  const payerAddress = await fetchAutopayPayerAddress(state.autopay_url, owner);
  const normalizedOwner = normalizeEvmAddress(owner);
  const expiresAt = sessionExpiresAt();
  const sessionToken = await signSessionState(env, {
    owner: normalizedOwner,
    autopay_url: state.autopay_url,
    expires_at: expiresAt,
  });

  return jsonResponse(
    {
      status: "approved",
      login_request_id: loginRequestId,
      owner: normalizedOwner,
      payer_address: payerAddress,
      autopay_url: state.autopay_url,
      expires_at: new Date(expiresAt).toISOString(),
    },
    {
      headers: {
        "set-cookie": serializeSessionCookie(request, sessionToken, expiresAt),
      },
    },
  );
}

function handleLogout(request: Request): Response {
  return jsonResponse(
    { status: "logged_out" },
    {
      headers: {
        "set-cookie": serializeExpiredSessionCookie(request),
      },
    },
  );
}

async function handleUpdateSessionAutopay(
  request: Request,
  env: Env,
): Promise<Response> {
  const session = await requireSession(request, env);
  const body = await readJsonObject(request);
  const newAutopayUrl = normalizeAutopayUrl(
    body.autopay_url ?? body.autopayUrl,
  );

  if (!newAutopayUrl) {
    return errorResponse(
      400,
      "invalid_autopay_url",
      "autopay_url is required.",
    );
  }

  const account = await getAccountByOwner(env, session.owner);
  const now = new Date().toISOString();
  const expiresAt = sessionExpiresAt();

  if (account) {
    await env.DB.prepare(
      `UPDATE meteria402_accounts SET autopay_url = ?, updated_at = ? WHERE id = ?`,
    )
      .bind(newAutopayUrl, now, account.id)
      .run();
  }

  const sessionToken = await signSessionState(env, {
    owner: session.owner,
    autopay_url: newAutopayUrl,
    expires_at: expiresAt,
  });

  return jsonResponse(
    {
      owner: session.owner,
      autopay_url: newAutopayUrl,
      expires_at: new Date(expiresAt).toISOString(),
    },
    {
      headers: {
        "set-cookie": serializeSessionCookie(request, sessionToken, expiresAt),
      },
    },
  );
}

async function handleDepositQuote(
  request: Request,
  env: Env,
): Promise<Response> {
  const body = await readJsonObject(request);
  const amount = parseMoney(
    String(body.amount ?? env.DEFAULT_MIN_DEPOSIT ?? "5.00"),
  );
  if (amount <= 0) {
    return errorResponse(
      400,
      "invalid_amount",
      "Deposit amount must be greater than zero.",
    );
  }

  const paymentId = makeId("pay");
  const requirement = createPaymentRequirement(request, env, {
    kind: "deposit",
    id: paymentId,
    amount,
    description: "Refundable Meteria402 API deposit",
  });

  const nowSeconds = Math.floor(Date.now() / 1000);
  const validAfter = nowSeconds - 60; // allow 1 min clock skew
  const validBefore = nowSeconds + 300; // 5 min expiry
  const nonceBytes = new Uint8Array(32);
  crypto.getRandomValues(nonceBytes);
  const nonce =
    "0x" + [...nonceBytes].map((b) => b.toString(16).padStart(2, "0")).join("");

  const expiresAt = Date.now() + 60 * 60 * 1000;
  const quoteToken = await signDepositQuote(env, {
    payment_id: paymentId,
    kind: "deposit",
    amount,
    currency: "USD",
    payment_requirement: requirement,
    expires_at: expiresAt,
  });

  // Create pending payment record with nonce
  const dbNow = new Date().toISOString();
  const authMeta = {
    nonce,
    valid_after: String(validAfter),
    valid_before: String(validBefore),
  };
  await env.DB.prepare(
    `INSERT INTO meteria402_payments (id, kind, amount, currency, status, payment_requirement_json, response_json, created_at)
     VALUES (?, 'deposit', ?, 'USD', 'pending', ?, ?, ?)`,
  )
    .bind(
      paymentId,
      amount,
      JSON.stringify(requirement),
      JSON.stringify(authMeta),
      dbNow,
    )
    .run();

  return jsonResponse({
    payment_id: paymentId,
    amount: formatMoney(amount),
    currency: "USD",
    payment_requirement: requirement,
    authorization: {
      to: requirement.accepts[0].payTo,
      value: requirement.accepts[0].amount,
      valid_after: String(validAfter),
      valid_before: String(validBefore),
      nonce,
    },
    quote_token: quoteToken,
    expires_at: new Date(expiresAt).toISOString(),
  });
}

async function handleDepositSettle(
  request: Request,
  env: Env,
): Promise<Response> {
  const body = await readJsonObject(request);
  const quote = await verifyDepositQuote(
    env,
    requireString(body.quote_token ?? body.quoteToken, "quote_token"),
  );
  const paymentId = requireString(
    body.payment_id ?? quote.payment_id,
    "payment_id",
  );
  if (paymentId !== quote.payment_id) {
    return errorResponse(
      400,
      "payment_quote_mismatch",
      "Payment ID does not match the deposit quote.",
    );
  }
  const paymentPayload = body.payment_payload ?? body.paymentPayload ?? null;
  const devProof =
    typeof body.dev_proof === "string" ? body.dev_proof : undefined;
  const txHash =
    typeof body.tx_hash === "string"
      ? body.tx_hash
      : typeof body.txHash === "string"
        ? body.txHash
        : undefined;
  const session = await readOptionalSession(request, env);
  let ownerAddress =
    body.owner_address == null && body.ownerAddress == null
      ? (session?.owner ?? null)
      : normalizeEvmAddress(body.owner_address ?? body.ownerAddress);
  const autopayUrl =
    body.autopay_url == null && body.autopayUrl == null
      ? (session?.autopay_url ?? null)
      : normalizeAutopayUrl(body.autopay_url ?? body.autopayUrl);

  const paymentRequirementJson = JSON.stringify(quote.payment_requirement);

  // ─── Check existing payment record early (before verification) ───
  const existingPayment = await env.DB.prepare(
    `SELECT status, account_id, response_json FROM meteria402_payments WHERE id = ? AND kind = 'deposit'`,
  )
    .bind(paymentId)
    .first<{
      status: string;
      account_id: string | null;
      response_json: string | null;
    }>();

  // Idempotent: already settled
  if (existingPayment?.status === "settled" && existingPayment.account_id) {
    const account = await env.DB.prepare(
      `SELECT id, deposit_balance, owner_address FROM meteria402_accounts WHERE id = ?`,
    )
      .bind(existingPayment.account_id)
      .first<{
        id: string;
        deposit_balance: number;
        owner_address: string | null;
      }>();

    if (account) {
      return jsonResponse({
        account_id: account.id,
        deposit_balance: formatMoney(account.deposit_balance),
        owner_address: account.owner_address,
        message: "This deposit was already settled.",
      });
    }
  }

  // ─── Verify payment ───
  let settlement:
    | { ok: true; txHash?: string; payerAddress?: string; raw?: unknown }
    | { ok: false; message: string; facilitatorStatus?: number; raw?: unknown };
  if (txHash) {
    const txResult = await verifyTxHash(env, txHash, quote.payment_requirement);
    if (!txResult.ok) {
      const now = new Date().toISOString();
      if (!existingPayment) {
        await env.DB.prepare(
          `INSERT INTO meteria402_payments (id, kind, amount, currency, status, tx_hash, payment_requirement_json, response_json, created_at)
           VALUES (?, 'deposit', ?, 'USD', 'verification_failed', ?, ?, ?, ?)`,
        )
          .bind(
            paymentId,
            quote.amount,
            txHash,
            paymentRequirementJson,
            JSON.stringify({ error: txResult.message }),
            now,
          )
          .run();
      } else if (existingPayment.status !== "settled") {
        await env.DB.prepare(
          `UPDATE meteria402_payments SET status = 'verification_failed', tx_hash = ?, payment_requirement_json = ?, response_json = ? WHERE id = ?`,
        )
          .bind(
            txHash,
            paymentRequirementJson,
            JSON.stringify({ error: txResult.message }),
            paymentId,
          )
          .run();
      }
      return errorResponse(402, "payment_required", txResult.message);
    }
    settlement = {
      ok: true,
      txHash: txResult.txHash,
      payerAddress: txResult.payerAddress,
      raw: txResult.raw,
    };
    if (!ownerAddress) {
      ownerAddress = normalizeEvmAddress(txResult.payerAddress);
    }
  } else {
    // Validate authorization nonce matches what we issued
    if (paymentPayload && existingPayment?.response_json) {
      try {
        const authMeta = JSON.parse(existingPayment.response_json) as Record<
          string,
          unknown
        >;
        const payload = (paymentPayload as Record<string, unknown> | null)
          ?.payload;
        const payloadAuth =
          payload && typeof payload === "object"
            ? (payload as Record<string, unknown>).authorization
            : null;
        if (payloadAuth && typeof payloadAuth === "object") {
          const submittedNonce = (payloadAuth as Record<string, unknown>).nonce;
          const expectedNonce = authMeta.nonce;
          if (submittedNonce !== expectedNonce) {
            return errorResponse(
              400,
              "invalid_nonce",
              "Payment authorization nonce does not match the quote.",
            );
          }
          const validBefore =
            typeof (payloadAuth as Record<string, unknown>).validBefore ===
            "number"
              ? ((payloadAuth as Record<string, unknown>).validBefore as number)
              : typeof (payloadAuth as Record<string, unknown>).valid_before ===
                  "number"
                ? ((payloadAuth as Record<string, unknown>)
                    .valid_before as number)
                : null;
          if (
            validBefore != null &&
            validBefore < Math.floor(Date.now() / 1000)
          ) {
            return errorResponse(
              400,
              "authorization_expired",
              "Payment authorization has expired. Please request a new quote.",
            );
          }
        }
      } catch {
        // ignore parse errors, let facilitator validation catch issues
      }
    }
    // CDP facilitator expects EIP-3009 {signature, authorization} format.
    // Payload comes from frontend with validAfter/validBefore as strings.
    const normalizedPayload = paymentPayload;

    settlement = await verifyPayment(
      env,
      paymentRequirementJson,
      normalizedPayload,
      devProof,
    );
    if (!settlement.ok) {
      const now = new Date().toISOString();
      if (!existingPayment) {
        await env.DB.prepare(
          `INSERT INTO meteria402_payments (id, kind, amount, currency, status, payment_requirement_json, response_json, created_at)
           VALUES (?, 'deposit', ?, 'USD', 'verification_failed', ?, ?, ?)`,
        )
          .bind(
            paymentId,
            quote.amount,
            paymentRequirementJson,
            JSON.stringify({
              error: settlement.message,
              ...settlementErrorExtra(settlement),
            }),
            now,
          )
          .run();
      } else if (existingPayment.status !== "settled") {
        await env.DB.prepare(
          `UPDATE meteria402_payments SET status = 'verification_failed', payment_requirement_json = ?, response_json = ? WHERE id = ?`,
        )
          .bind(
            paymentRequirementJson,
            JSON.stringify({
              error: settlement.message,
              ...settlementErrorExtra(settlement),
            }),
            paymentId,
          )
          .run();
      }
      return errorResponse(
        402,
        "payment_required",
        settlement.message,
        settlementErrorExtra(settlement),
      );
    }
  }

  const now = new Date().toISOString();
  const payloadHash = await sha256Hex(
    JSON.stringify(
      paymentPayload ?? {
        tx_hash: txHash,
        dev_proof: devProof,
        payment_id: paymentId,
      },
    ),
  );
  const existingPayload = await env.DB.prepare(
    `SELECT id FROM meteria402_payments WHERE x402_payload_hash = ?`,
  )
    .bind(payloadHash)
    .first<{ id: string; status: string }>();
  if (existingPayload?.status === "settled") {
    return errorResponse(
      409,
      "payment_already_used",
      "This payment payload has already been settled.",
    );
  }

  const minDeposit = parseMoney(env.DEFAULT_MIN_DEPOSIT ?? "5.00");
  const concurrencyLimit = parsePositiveInt(
    env.DEFAULT_CONCURRENCY_LIMIT ?? "1",
    1,
  );

  // ─── Check if owner already has an account — if so, top up instead of creating new ───
  let existingAccount: { id: string; deposit_balance: number } | null = null;
  if (ownerAddress) {
    existingAccount = await getAccountByOwner(env, ownerAddress);
  }

  if (existingAccount) {
    // Top-up existing account
    const newBalance = existingAccount.deposit_balance + quote.amount;
    await env.DB.batch([
      env.DB.prepare(
        `UPDATE meteria402_accounts SET deposit_balance = ?, updated_at = ? WHERE id = ?`,
      ).bind(newBalance, now, existingAccount.id),
      env.DB.prepare(
        `INSERT INTO meteria402_payments (id, account_id, kind, amount, currency, status, x402_payload_hash, tx_hash, payment_requirement_json, response_json, created_at, settled_at)
         VALUES (?, ?, 'deposit', ?, 'USD', 'settled', ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           account_id = excluded.account_id,
           status = 'settled',
           x402_payload_hash = excluded.x402_payload_hash,
           tx_hash = excluded.tx_hash,
           payment_requirement_json = excluded.payment_requirement_json,
           response_json = excluded.response_json,
           settled_at = excluded.settled_at`,
      ).bind(
        paymentId,
        existingAccount.id,
        quote.amount,
        payloadHash,
        settlement.txHash ?? null,
        paymentRequirementJson,
        JSON.stringify(settlement.raw ?? {}),
        now,
        now,
      ),
      env.DB.prepare(
        `INSERT INTO meteria402_ledger_entries (id, account_id, type, amount, currency, related_payment_id, created_at)
         VALUES (?, ?, 'deposit_paid', ?, 'USD', ?, ?)`,
      ).bind(makeId("led"), existingAccount.id, quote.amount, paymentId, now),
    ]);

    return jsonResponse({
      account_id: existingAccount.id,
      deposit_balance: formatMoney(newBalance),
      tx_hash: settlement.txHash,
      payer_address: settlement.payerAddress,
      message: "Deposit topped up successfully.",
    });
  }

  // ─── Create new account for first-time deposit ───
  const accountId = makeId("acct");
  const apiKey = await createApiKey();
  const apiKeyHash = await sha256Hex(apiKey.secret);

  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO meteria402_accounts
       (id, status, owner_address, autopay_url, deposit_balance, unpaid_invoice_total, active_request_count, concurrency_limit, min_deposit_required, refund_address, created_at, updated_at)
       VALUES (?, 'active', ?, ?, ?, 0, 0, ?, ?, ?, ?, ?)`,
    ).bind(
      accountId,
      ownerAddress,
      autopayUrl,
      quote.amount,
      concurrencyLimit,
      minDeposit,
      settlement.payerAddress ?? null,
      now,
      now,
    ),
    env.DB.prepare(
      `INSERT INTO meteria402_payments
       (id, account_id, kind, amount, currency, status, x402_payload_hash, tx_hash, payment_requirement_json, response_json, created_at, settled_at)
       VALUES (?, ?, 'deposit', ?, 'USD', 'settled', ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         account_id = excluded.account_id,
         status = 'settled',
         x402_payload_hash = excluded.x402_payload_hash,
         tx_hash = excluded.tx_hash,
         payment_requirement_json = excluded.payment_requirement_json,
         response_json = excluded.response_json,
         settled_at = excluded.settled_at`,
    ).bind(
      paymentId,
      accountId,
      quote.amount,
      payloadHash,
      settlement.txHash ?? null,
      paymentRequirementJson,
      JSON.stringify(settlement.raw ?? {}),
      now,
      now,
    ),
    env.DB.prepare(
      `INSERT INTO meteria402_api_keys (id, account_id, key_hash, key_prefix, key_suffix, name, expires_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, NULL, ?)`,
    ).bind(
      apiKey.id,
      accountId,
      apiKeyHash,
      apiKey.prefix,
      apiKey.keySuffix,
      randomApiKeyName(),
      now,
    ),
    env.DB.prepare(
      `INSERT INTO meteria402_ledger_entries (id, account_id, type, amount, currency, related_payment_id, created_at)
       VALUES (?, ?, 'deposit_paid', ?, 'USD', ?, ?)`,
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

async function handleDepositAutopayStart(
  request: Request,
  env: Env,
  paymentId: string,
): Promise<Response> {
  const body = await readJsonObject(request);
  const quoteToken = requireString(
    body.quote_token ?? body.quoteToken,
    "quote_token",
  );
  const autopayUrl = normalizeAutopayUrl(body.autopay_url ?? body.autopayUrl);
  const quote = await verifyDepositQuote(env, quoteToken);
  if (paymentId !== quote.payment_id) {
    return errorResponse(
      400,
      "payment_quote_mismatch",
      "Payment ID does not match the deposit quote.",
    );
  }

  return startAutopayForDepositQuote(
    request,
    env,
    quote,
    quoteToken,
    autopayUrl,
  );
}

async function handleDepositAutopayComplete(
  request: Request,
  env: Env,
  paymentId: string,
): Promise<Response> {
  const body = await readJsonObject(request);
  const autopayState = await verifyDepositAutopayState(
    env,
    requireString(body.autopay_state ?? body.autopayState, "autopay_state"),
  );
  if (paymentId !== autopayState.payment_id) {
    return errorResponse(
      400,
      "payment_autopay_mismatch",
      "Payment ID does not match the autopay state.",
    );
  }
  const result = await completeAutopayForDepositQuote(env, autopayState);
  if (result.status !== "approved") return jsonResponse(result);

  const settleRequest = new Request(
    new URL("/api/deposits/settle", request.url),
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        payment_id: paymentId,
        quote_token: autopayState.quote_token,
        payment_payload: result.payment_payload,
        owner_address: result.owner,
        autopay_url: autopayState.autopay_url,
      }),
    },
  );
  const settleResponse = await handleDepositSettle(settleRequest, env);
  const settlement = await settleResponse.json().catch(() => null);
  return jsonResponse(
    {
      status: settleResponse.ok ? "settled" : "settle_failed",
      autopay_status: result.status,
      settlement,
    },
    { status: settleResponse.status },
  );
}

async function handleGetAccount(request: Request, env: Env): Promise<Response> {
  const account = await requireAccountFromSession(request, env);

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

async function handleListApiKeys(
  request: Request,
  env: Env,
): Promise<Response> {
  const account = await requireAccountFromSession(request, env);

  const rows = await env.DB.prepare(
    `SELECT id, key_prefix, key_suffix, name, expires_at, created_at, revoked_at
     FROM meteria402_api_keys
     WHERE account_id = ?
     ORDER BY created_at DESC`,
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

  const keyList = rows.results || [];

  // Aggregate usage stats per key
  const keyIds = keyList.map((k) => k.id);
  const statsMap = new Map<
    string,
    { calls: number; total_tokens: number; total_cost: number; errors: number }
  >();

  if (keyIds.length > 0) {
    const placeholders = keyIds.map(() => "?").join(",");
    const stats = await env.DB.prepare(
      `SELECT api_key_id,
              COUNT(*) AS calls,
              COALESCE(SUM(total_tokens), 0) AS total_tokens,
              COALESCE(SUM(final_cost), 0) AS total_cost,
              COUNT(CASE WHEN status = 'error' OR status = 'pending_reconcile' THEN 1 END) AS errors
       FROM meteria402_requests
       WHERE api_key_id IN (${placeholders})
       GROUP BY api_key_id`,
    )
      .bind(...keyIds)
      .all<{
        api_key_id: string;
        calls: number;
        total_tokens: number;
        total_cost: number;
        errors: number;
      }>();

    for (const row of stats.results || []) {
      statsMap.set(row.api_key_id, {
        calls: Number(row.calls),
        total_tokens: Number(row.total_tokens),
        total_cost: Number(row.total_cost),
        errors: Number(row.errors),
      });
    }
  }

  return jsonResponse({
    current_api_key_id: account.api_key_id,
    api_keys: keyList.map((row) => {
      const stats = statsMap.get(row.id) || {
        calls: 0,
        total_tokens: 0,
        total_cost: 0,
        errors: 0,
      };
      return {
        id: row.id,
        name: row.name || "Unnamed key",
        prefix: row.key_prefix,
        key_suffix: row.key_suffix,
        status: keyStatus(row.revoked_at, row.expires_at),
        expires_at: row.expires_at,
        created_at: row.created_at,
        revoked_at: row.revoked_at,
        calls: stats.calls,
        total_tokens: stats.total_tokens,
        total_cost: stats.total_cost,
        errors: stats.errors,
      };
    }),
  });
}

async function handleCreateApiKey(
  request: Request,
  env: Env,
): Promise<Response> {
  const account = await requireAccountFromSession(request, env);

  const body = await readOptionalJsonObject(request);
  const name = normalizeApiKeyName(body.name);
  const expiresAt = normalizeApiKeyExpiresAt(body.expires_at ?? body.expiresAt);
  const apiKey = await createApiKey();
  const apiKeyHash = await sha256Hex(apiKey.secret);
  const now = new Date().toISOString();

  await env.DB.prepare(
    `INSERT INTO meteria402_api_keys (id, account_id, key_hash, key_prefix, key_suffix, name, expires_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      apiKey.id,
      account.id,
      apiKeyHash,
      apiKey.prefix,
      apiKey.keySuffix,
      name,
      expiresAt,
      now,
    )
    .run();

  return jsonResponse(
    {
      api_key_id: apiKey.id,
      api_key: apiKey.secret,
      name,
      prefix: apiKey.prefix,
      key_suffix: apiKey.keySuffix,
      expires_at: expiresAt,
      created_at: now,
      message: "Store this API key now. It cannot be shown again.",
    },
    { status: 201 },
  );
}

async function handleRevokeApiKey(
  request: Request,
  env: Env,
  apiKeyId: string,
): Promise<Response> {
  const account = await requireAccountFromSession(request, env);

  const now = new Date().toISOString();
  const result = await env.DB.prepare(
    `UPDATE meteria402_api_keys
     SET revoked_at = COALESCE(revoked_at, ?)
     WHERE id = ? AND account_id = ?`,
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

async function handleListInvoices(
  request: Request,
  env: Env,
): Promise<Response> {
  const account = await requireAccountFromSession(request, env);

  const rows = await env.DB.prepare(
    `SELECT id, request_id, status, amount_due, currency, created_at, paid_at
     FROM meteria402_invoices
     WHERE account_id = ?
     ORDER BY created_at DESC
     LIMIT 100`,
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

async function handleListDeposits(
  request: Request,
  env: Env,
): Promise<Response> {
  const account = await requireAccountFromSession(request, env);

  const rows = await env.DB.prepare(
    `SELECT id, amount, currency, status, tx_hash, response_json, created_at, settled_at
     FROM meteria402_payments
     WHERE account_id = ? AND kind = 'deposit'
     ORDER BY settled_at DESC
     LIMIT 100`,
  )
    .bind(account.id)
    .all<{
      id: string;
      amount: number;
      currency: string;
      status: string;
      tx_hash: string | null;
      response_json: string;
      created_at: string;
      settled_at: string | null;
    }>();

  const deposits = rows.results.map((row) => {
    let payerAddress: string | null = null;
    try {
      const parsed = JSON.parse(row.response_json) as Record<string, unknown>;
      payerAddress =
        typeof parsed.payerAddress === "string" ? parsed.payerAddress : null;
      if (!payerAddress && typeof parsed.payer === "string")
        payerAddress = parsed.payer;
    } catch {
      // ignore parse error
    }
    return {
      id: row.id,
      amount: formatMoney(row.amount),
      currency: row.currency,
      status: row.status,
      tx_hash: row.tx_hash,
      payer_address: payerAddress,
      settled_at: row.settled_at,
    };
  });

  return jsonResponse({ deposits });
}

async function handleListRequests(
  request: Request,
  env: Env,
): Promise<Response> {
  const account = await requireAccountFromSession(request, env);

  const rows = await env.DB.prepare(
    `SELECT r.id, r.status, r.model, r.stream, r.ai_gateway_log_id,
            r.input_tokens, r.output_tokens, r.total_tokens, r.final_cost,
            r.error_code, r.started_at, r.completed_at,
            i.id AS invoice_id, i.status AS invoice_status, i.amount_due AS invoice_amount_due
     FROM meteria402_requests r
     LEFT JOIN meteria402_invoices i ON i.request_id = r.id
     WHERE r.account_id = ?
     ORDER BY r.started_at DESC
     LIMIT 100`,
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
            amount_due:
              row.invoice_amount_due == null
                ? null
                : formatMoney(row.invoice_amount_due),
          }
        : null,
    })),
  });
}

async function handleReconcileRequests(
  request: Request,
  env: Env,
): Promise<Response> {
  const account = await requireAccountFromSession(request, env);
  const result = await reconcilePendingGatewayLogs(env, account.id);
  return jsonResponse(result);
}

async function handleInvoicePayQuote(
  request: Request,
  env: Env,
  invoiceId: string,
): Promise<Response> {
  const account = await requireAccountFromSession(request, env);

  const invoice = await env.DB.prepare(
    `SELECT id, amount_due, status
     FROM meteria402_invoices
     WHERE id = ? AND account_id = ?`,
  )
    .bind(invoiceId, account.id)
    .first<{ id: string; amount_due: number; status: string }>();

  if (!invoice) {
    return errorResponse(404, "invoice_not_found", "Invoice was not found.");
  }
  if (invoice.status !== "unpaid") {
    return errorResponse(
      409,
      "invoice_not_payable",
      "Only unpaid invoices can be paid.",
    );
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
     VALUES (?, ?, ?, 'invoice', ?, 'USD', 'pending', ?)`,
  )
    .bind(
      paymentId,
      account.id,
      invoice.id,
      invoice.amount_due,
      JSON.stringify(requirement),
    )
    .run();

  return jsonResponse({
    payment_id: paymentId,
    invoice_id: invoice.id,
    amount: formatMoney(invoice.amount_due),
    currency: "USD",
    payment_requirement: requirement,
  });
}

async function handleInvoicePaySettle(
  request: Request,
  env: Env,
  invoiceId: string,
): Promise<Response> {
  const account = await requireAccountFromSession(request, env);

  const body = await readJsonObject(request);
  const paymentId = requireString(body.payment_id, "payment_id");
  const paymentPayload = body.payment_payload ?? body.paymentPayload ?? null;
  const devProof =
    typeof body.dev_proof === "string" ? body.dev_proof : undefined;

  const payment = await env.DB.prepare(
    `SELECT p.id, p.amount, p.status, p.payment_requirement_json, i.status AS invoice_status
     FROM meteria402_payments p
     JOIN meteria402_invoices i ON i.id = p.invoice_id
     WHERE p.id = ? AND p.invoice_id = ? AND p.account_id = ? AND p.kind = 'invoice'`,
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
    return errorResponse(
      404,
      "payment_not_found",
      "Payment quote was not found.",
    );
  }
  if (payment.status === "settled") {
    return errorResponse(
      409,
      "payment_already_settled",
      "This invoice payment has already been settled.",
    );
  }
  if (payment.invoice_status !== "unpaid") {
    return errorResponse(
      409,
      "invoice_not_payable",
      "Only unpaid invoices can be paid.",
    );
  }

  const settlement = await verifyPayment(
    env,
    payment.payment_requirement_json,
    paymentPayload,
    devProof,
  );
  if (!settlement.ok) {
    return errorResponse(
      402,
      "payment_required",
      settlement.message,
      settlementErrorExtra(settlement),
    );
  }

  const now = new Date().toISOString();
  const payloadHash = await sha256Hex(
    JSON.stringify(
      paymentPayload ?? { dev_proof: devProof, payment_id: paymentId },
    ),
  );

  await env.DB.batch([
    env.DB.prepare(
      `UPDATE meteria402_payments
       SET status = 'settled', x402_payload_hash = ?, tx_hash = ?, response_json = ?, settled_at = ?
       WHERE id = ? AND status = 'pending'`,
    ).bind(
      payloadHash,
      settlement.txHash ?? null,
      JSON.stringify(settlement.raw ?? {}),
      now,
      paymentId,
    ),
    env.DB.prepare(
      `UPDATE meteria402_invoices
       SET status = 'paid', paid_at = ?
       WHERE id = ? AND account_id = ? AND status = 'unpaid'`,
    ).bind(now, invoiceId, account.id),
    env.DB.prepare(
      `UPDATE meteria402_accounts
       SET unpaid_invoice_total = MAX(0, unpaid_invoice_total - ?), updated_at = ?
       WHERE id = ?`,
    ).bind(payment.amount, now, account.id),
    env.DB.prepare(
      `INSERT INTO meteria402_ledger_entries (id, account_id, type, amount, currency, related_invoice_id, related_payment_id, created_at)
       VALUES (?, ?, 'invoice_paid', ?, 'USD', ?, ?, ?)`,
    ).bind(
      makeId("led"),
      account.id,
      payment.amount,
      invoiceId,
      paymentId,
      now,
    ),
  ]);

  return jsonResponse({
    invoice_id: invoiceId,
    payment_id: paymentId,
    status: "paid",
    amount: formatMoney(payment.amount),
  });
}

async function handleInvoiceAutopayStart(
  request: Request,
  env: Env,
  invoiceId: string,
): Promise<Response> {
  const account = await requireAccountFromSession(request, env);

  const invoice = await env.DB.prepare(
    `SELECT id, amount_due, status
     FROM meteria402_invoices
     WHERE id = ? AND account_id = ?`,
  )
    .bind(invoiceId, account.id)
    .first<{ id: string; amount_due: number; status: string }>();

  if (!invoice) {
    return errorResponse(404, "invoice_not_found", "Invoice was not found.");
  }
  if (invoice.status !== "unpaid") {
    return errorResponse(
      409,
      "invoice_not_payable",
      "Only unpaid invoices can be paid.",
    );
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
     VALUES (?, ?, ?, 'invoice', ?, 'USD', 'pending', ?)`,
  )
    .bind(
      paymentId,
      account.id,
      invoice.id,
      invoice.amount_due,
      JSON.stringify(requirement),
    )
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

async function handleInvoiceAutopayComplete(
  request: Request,
  env: Env,
  invoiceId: string,
): Promise<Response> {
  const account = await requireAccountFromSession(request, env);

  const body = await readJsonObject(request);
  const paymentId = requireString(body.payment_id, "payment_id");
  const payment = await env.DB.prepare(
    `SELECT id
     FROM meteria402_payments
     WHERE id = ? AND invoice_id = ? AND account_id = ? AND kind = 'invoice'`,
  )
    .bind(paymentId, invoiceId, account.id)
    .first<{ id: string }>();
  if (!payment) {
    return errorResponse(
      404,
      "payment_not_found",
      "Payment quote was not found.",
    );
  }

  const result = await completeAutopayForPayment(env, paymentId);
  if (result.status !== "approved") return jsonResponse(result);

  const settleRequest = new Request(
    new URL(`/api/invoices/${invoiceId}/pay/settle`, request.url),
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: request.headers.get("authorization") || "",
      },
      body: JSON.stringify({
        payment_id: paymentId,
        payment_payload: result.payment_payload,
      }),
    },
  );
  const settleResponse = await handleInvoicePaySettle(
    settleRequest,
    env,
    invoiceId,
  );
  if (settleResponse.ok) {
    await markAutopaySettled(env, result.autopay_request_id);
  }
  const settlement = await settleResponse.json().catch(() => null);
  return jsonResponse(
    {
      status: settleResponse.ok ? "settled" : "settle_failed",
      autopay_status: result.status,
      settlement,
    },
    { status: settleResponse.status },
  );
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
  // Try to use an existing autopay capability first
  if (payment.account_id) {
    const capabilityPayload = await tryAutopayWithCapability(
      env,
      payment.account_id,
      payment.payment_requirement_json,
      payment.amount,
    );
    if (capabilityPayload) {
      // Store the capability-based payment result for later settlement
      await env.DB.prepare(
        `UPDATE meteria402_payments
         SET status = 'capability_ready', response_json = ?
         WHERE id = ?`,
      )
        .bind(JSON.stringify(capabilityPayload), payment.id)
        .run();

      return jsonResponse(
        {
          payment_id: payment.id,
          invoice_id: payment.invoice_id,
          status: "approved",
          payment_payload: capabilityPayload.payment_payload,
          headers: capabilityPayload.headers,
          capability_used: true,
        },
        { status: 200 },
      );
    }
  }

  const autopayUrl = await requirePaymentAccountAutopayUrl(
    env,
    payment.account_id,
  );
  const paymentRequired = JSON.parse(
    payment.payment_requirement_json,
  ) as PaymentRequirement;
  const policyValidBefore = new Date(
    Date.now() + 7 * 24 * 60 * 60 * 1000,
  ).toISOString();
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

  const body = (await response.json().catch(() => null)) as Record<
    string,
    unknown
  > | null;
  if (!response.ok || !body) {
    return errorResponse(
      response.status || 502,
      "autopay_request_failed",
      "Autopay authorization request could not be created.",
      {
        autopay_response: body,
      },
    );
  }

  const autopayRequestId = requireString(body.request_id, "request_id");
  const pollToken = requireString(body.poll_token, "poll_token");
  const verificationUriComplete = requireString(
    body.verification_uri_complete,
    "verification_uri_complete",
  );
  const autopayRecordId = makeId("ap");
  const now = new Date().toISOString();

  await env.DB.prepare(
    `INSERT INTO meteria402_autopay_requests
     (id, payment_id, account_id, invoice_id, autopay_url, autopay_request_id, poll_token, status, verification_uri_complete, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`,
  )
    .bind(
      autopayRecordId,
      payment.id,
      payment.account_id,
      payment.invoice_id,
      autopayUrl,
      autopayRequestId,
      pollToken,
      verificationUriComplete,
      now,
    )
    .run();

  return jsonResponse(
    {
      id: autopayRecordId,
      payment_id: payment.id,
      invoice_id: payment.invoice_id,
      status: "pending",
      verification_uri_complete: verificationUriComplete,
      websocket_uri_complete:
        typeof body.websocket_uri_complete === "string"
          ? body.websocket_uri_complete
          : undefined,
      expires_in: body.expires_in,
      interval: body.interval,
    },
    { status: 201 },
  );
}

async function startAutopayForDepositQuote(
  request: Request,
  env: Env,
  quote: DepositQuoteState,
  quoteToken: string,
  autopayUrl: string,
): Promise<Response> {
  const policyValidBefore = new Date(
    Date.now() + 7 * 24 * 60 * 60 * 1000,
  ).toISOString();
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

  const body = (await response.json().catch(() => null)) as Record<
    string,
    unknown
  > | null;
  console.log(
    "[DEBUG] api/auth/requests response:",
    JSON.stringify(body, null, 2),
  );
  if (!response.ok || !body) {
    return errorResponse(
      response.status || 502,
      "autopay_request_failed",
      "Autopay authorization request could not be created.",
      {
        autopay_response: body,
      },
    );
  }

  const autopayRequestId = requireString(body.request_id, "request_id");
  const pollToken = requireString(body.poll_token, "poll_token");
  const verificationUriComplete = requireString(
    body.verification_uri_complete,
    "verification_uri_complete",
  );
  console.log("[DEBUG] verification_uri_complete:", verificationUriComplete);
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

  return jsonResponse(
    {
      payment_id: quote.payment_id,
      status: "pending",
      verification_uri_complete: verificationUriComplete,
      websocket_uri_complete:
        typeof body.websocket_uri_complete === "string"
          ? body.websocket_uri_complete
          : undefined,
      expires_in: body.expires_in,
      interval: body.interval,
      autopay_state: autopayState,
    },
    { status: 201 },
  );
}

async function completeAutopayForPayment(
  env: Env,
  paymentId: string,
): Promise<
  Record<string, unknown> & {
    status: string;
    autopay_request_id?: string;
    payment_payload?: unknown;
  }
> {
  // Check if a capability-based payment was already prepared
  const capabilityPayment = await env.DB.prepare(
    `SELECT status, response_json
     FROM meteria402_payments
     WHERE id = ? AND status = 'capability_ready'`,
  )
    .bind(paymentId)
    .first<{ status: string; response_json: string }>();

  if (capabilityPayment) {
    try {
      const parsed = JSON.parse(capabilityPayment.response_json) as {
        payment_payload: unknown;
        headers: Record<string, string>;
      };
      return {
        status: "approved",
        payment_id: paymentId,
        payment_payload: parsed.payment_payload,
        selected_requirement: parsed.headers,
        capability_used: true,
      };
    } catch {
      // Fall through to normal flow if parsing fails
    }
  }

  const record = await env.DB.prepare(
    `SELECT id, payment_id, account_id, invoice_id, autopay_url, autopay_request_id, poll_token, status, verification_uri_complete
     FROM meteria402_autopay_requests
     WHERE payment_id = ?
     ORDER BY created_at DESC
     LIMIT 1`,
  )
    .bind(paymentId)
    .first<AutopayRequestRow>();

  if (!record) {
    throw new HttpError(
      404,
      "autopay_request_not_found",
      "Autopay request was not found for this payment.",
    );
  }
  if (record.status === "settled") {
    return {
      status: "settled",
      payment_id: paymentId,
      autopay_request_id: record.id,
    };
  }

  const pollResponse = await fetch(
    `${record.autopay_url}/api/auth/requests/${encodeURIComponent(record.autopay_request_id)}/poll`,
    {
      headers: { "x-autopay-poll-token": record.poll_token },
    },
  );
  const pollBody = (await pollResponse.json().catch(() => null)) as Record<
    string,
    unknown
  > | null;
  if (!pollResponse.ok || !pollBody) {
    throw new HttpError(
      pollResponse.status || 502,
      "autopay_poll_failed",
      "Autopay authorization status could not be checked.",
    );
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

  const authorization = pollBody.authorization as
    | Record<string, unknown>
    | undefined;
  if (!authorization) {
    throw new HttpError(
      502,
      "invalid_autopay_authorization",
      "Autopay approval did not include authorization details.",
    );
  }

  const payment = await env.DB.prepare(
    `SELECT payment_requirement_json
     FROM meteria402_payments
     WHERE id = ? AND status = 'pending'`,
  )
    .bind(paymentId)
    .first<{ payment_requirement_json: string }>();
  if (!payment) {
    throw new HttpError(
      404,
      "payment_not_found",
      "Pending payment was not found.",
    );
  }

  const paymentRequired = JSON.parse(
    payment.payment_requirement_json,
  ) as PaymentRequirement;
  const payResponse = await fetch(`${record.autopay_url}/api/pay`, {
    method: "POST",
    headers: JSON_HEADERS,
    body: JSON.stringify({
      siwe_message: authorization.siwe_message,
      siwe_signature: authorization.siwe_signature,
      paymentRequired,
    }),
  });
  const payBody = (await payResponse.json().catch(() => null)) as Record<
    string,
    unknown
  > | null;
  if (!payResponse.ok || !payBody) {
    throw new HttpError(
      payResponse.status || 502,
      "autopay_payment_failed",
      "Autopay payment payload could not be created.",
    );
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
): Promise<
  Record<string, unknown> & {
    status: string;
    autopay_request_id?: string;
    payment_payload?: unknown;
    owner?: string;
  }
> {
  const quote = await verifyDepositQuote(env, state.quote_token);
  if (quote.payment_id !== state.payment_id) {
    throw new HttpError(
      400,
      "payment_quote_mismatch",
      "Payment ID does not match the deposit quote.",
    );
  }

  const pollResponse = await fetch(
    `${state.autopay_url}/api/auth/requests/${encodeURIComponent(state.autopay_request_id)}/poll`,
    {
      headers: { "x-autopay-poll-token": state.poll_token },
    },
  );
  const pollBody = (await pollResponse.json().catch(() => null)) as Record<
    string,
    unknown
  > | null;
  if (!pollResponse.ok || !pollBody) {
    throw new HttpError(
      pollResponse.status || 502,
      "autopay_poll_failed",
      "Autopay authorization status could not be checked.",
    );
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

  const authorization = pollBody.authorization as
    | Record<string, unknown>
    | undefined;
  if (!authorization) {
    throw new HttpError(
      502,
      "invalid_autopay_authorization",
      "Autopay approval did not include authorization details.",
    );
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
  const payBody = (await payResponse.json().catch(() => null)) as Record<
    string,
    unknown
  > | null;
  if (!payResponse.ok || !payBody) {
    throw new HttpError(
      payResponse.status || 502,
      "autopay_payment_failed",
      "Autopay payment payload could not be created.",
    );
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

async function updateAutopayStatus(
  env: Env,
  id: string,
  status: string,
): Promise<void> {
  const approvedAt = status === "approved" ? new Date().toISOString() : null;
  await env.DB.prepare(
    `UPDATE meteria402_autopay_requests
     SET status = ?, approved_at = COALESCE(approved_at, ?)
     WHERE id = ?`,
  )
    .bind(status, approvedAt, id)
    .run();
}

async function markAutopaySettled(
  env: Env,
  id: string | undefined,
): Promise<void> {
  if (!id) return;
  await env.DB.prepare(
    `UPDATE meteria402_autopay_requests
     SET status = 'settled', settled_at = ?
     WHERE id = ?`,
  )
    .bind(new Date().toISOString(), id)
    .run();
}

async function fetchAutopayPayerAddress(
  autopayUrl: string,
  owner?: string,
): Promise<string | null> {
  const url = new URL("/api/capabilities", autopayUrl);
  if (owner) url.searchParams.set("owner", owner);
  const response = await fetch(url.toString());
  const body = (await response.json().catch(() => null)) as Record<
    string,
    unknown
  > | null;
  if (!response.ok || !body) return null;
  return typeof body.payer_address === "string" ? body.payer_address : null;
}

async function handleRefundRequest(
  request: Request,
  env: Env,
): Promise<Response> {
  const account = await requireAccountFromSession(request, env);

  if (account.unpaid_invoice_total > 0) {
    return paymentRequiredResponse(
      "unpaid_invoice",
      "All unpaid invoices must be paid before a refund can be requested.",
      {
        unpaid_invoice_total: formatMoney(account.unpaid_invoice_total),
      },
    );
  }
  if (account.active_request_count > 0) {
    return errorResponse(
      409,
      "requests_running",
      "Refund cannot be requested while requests are running.",
    );
  }

  const now = new Date().toISOString();
  await env.DB.prepare(
    `UPDATE meteria402_accounts
     SET status = 'refund_requested', updated_at = ?
     WHERE id = ? AND status = 'active'`,
  )
    .bind(now, account.id)
    .run();

  return jsonResponse({
    account_id: account.id,
    status: "refund_requested",
    refundable_amount: formatMoney(account.deposit_balance),
  });
}

async function handleListAutopayCapabilities(
  request: Request,
  env: Env,
): Promise<Response> {
  const account = await requireAccountFromSession(request, env);

  const rows = await env.DB.prepare(
    `SELECT id, owner_address, autopay_url, capability_json, max_single_amount, total_budget, spent_amount, valid_before, created_at, revoked_at
     FROM meteria402_autopay_capabilities
     WHERE account_id = ?
     ORDER BY created_at DESC
     LIMIT 50`,
  )
    .bind(account.id)
    .all<{
      id: string;
      owner_address: string;
      autopay_url: string;
      capability_json: string;
      max_single_amount: number;
      total_budget: number;
      spent_amount: number;
      valid_before: string;
      created_at: string;
      revoked_at: string | null;
    }>();

  const now = new Date().toISOString();
  const list = (rows.results || []).map((row) => {
    const isExpired = row.valid_before < now;
    const isRevoked = row.revoked_at != null;
    const remaining = Math.max(0, row.total_budget - row.spent_amount);
    return {
      id: row.id,
      owner_address: row.owner_address,
      autopay_url: row.autopay_url,
      max_single_amount: formatMoney(row.max_single_amount),
      total_budget: formatMoney(row.total_budget),
      spent_amount: formatMoney(row.spent_amount),
      remaining_budget: formatMoney(remaining),
      valid_before: row.valid_before,
      status: isRevoked
        ? "revoked"
        : isExpired
          ? "expired"
          : remaining <= 0
            ? "depleted"
            : "active",
      created_at: row.created_at,
    };
  });

  return jsonResponse({ capabilities: list });
}

async function handleCreateAutopayCapability(
  request: Request,
  env: Env,
): Promise<Response> {
  const account = await requireAccountFromSession(request, env);
  const body = await readJsonObject(request);

  if (!account.owner_address || !account.autopay_url) {
    return errorResponse(
      400,
      "missing_autopay_setup",
      "Account must have an autopay setup to create capabilities.",
    );
  }

  const autopayUrl = normalizeAutopayUrl(
    body.autopay_url ?? account.autopay_url,
  );
  const totalBudget = parseMoney(String(body.total_budget ?? "5.00"));
  const maxSingleAmount = parseMoney(
    String(body.max_single_amount ?? body.total_budget ?? "5.00"),
  );
  const ttlDays =
    typeof body.ttl_days === "number"
      ? Math.max(1, Math.min(30, body.ttl_days))
      : 7;
  const validBefore = new Date(
    Date.now() + ttlDays * 24 * 60 * 60 * 1000,
  ).toISOString();

  // First, create an auth request via autopay worker
  const authResponse = await fetch(`${autopayUrl}/api/auth/requests`, {
    method: "POST",
    headers: JSON_HEADERS,
    body: JSON.stringify({
      kind: "payment",
      returnOrigin: new URL(request.url).origin,
      ttlSeconds: 300,
      policy: {
        allowedOrigins: [new URL(request.url).origin],
        allowedPayTo: [requireRecipientAddress(env)],
        network: env.X402_NETWORK || BASE_MAINNET,
        asset: env.X402_ASSET || BASE_USDC,
        maxSingleAmount: x402AmountFromMicroUsd(maxSingleAmount, env),
        totalBudget: x402AmountFromMicroUsd(totalBudget, env),
        validBefore,
      },
      policyValidBefore: validBefore,
    }),
  });

  const authBody = (await authResponse.json().catch(() => null)) as Record<
    string,
    unknown
  > | null;
  if (!authResponse.ok || !authBody) {
    return errorResponse(
      authResponse.status || 502,
      "autopay_auth_request_failed",
      "Could not create autopay authorization request.",
      {
        autopay_response: authBody,
      },
    );
  }

  const authRequestId = requireString(authBody.request_id, "request_id");
  const pollToken = requireString(authBody.poll_token, "poll_token");
  const verificationUriComplete = requireString(
    authBody.verification_uri_complete,
    "verification_uri_complete",
  );
  const websocketUriComplete =
    typeof authBody.websocket_uri_complete === "string"
      ? authBody.websocket_uri_complete
      : "";

  // Return the auth request details; the client must poll/approve via the autopay worker page
  return jsonResponse(
    {
      capability_id: authRequestId,
      status: "pending_approval",
      verification_uri_complete: verificationUriComplete,
      websocket_uri_complete: websocketUriComplete,
      poll_token: pollToken,
      autopay_url: autopayUrl,
      total_budget: formatMoney(totalBudget),
      max_single_amount: formatMoney(maxSingleAmount),
      valid_before: validBefore,
      ttl_days: ttlDays,
      message:
        "Approve this authorization on the autopay worker page. Polling will complete when done.",
    },
    { status: 201 },
  );
}

async function handleRevokeAutopayCapability(
  request: Request,
  env: Env,
  capabilityId: string,
): Promise<Response> {
  const account = await requireAccountFromSession(request, env);

  const now = new Date().toISOString();
  const result = await env.DB.prepare(
    `UPDATE meteria402_autopay_capabilities
     SET revoked_at = COALESCE(revoked_at, ?)
     WHERE id = ? AND account_id = ?`,
  )
    .bind(now, capabilityId, account.id)
    .run();

  if (result.meta.changes === 0) {
    return errorResponse(
      404,
      "capability_not_found",
      "Autopay capability was not found.",
    );
  }

  return jsonResponse({
    capability_id: capabilityId,
    status: "revoked",
    revoked_at: now,
  });
}

async function handleCompleteAutopayCapability(
  request: Request,
  env: Env,
  capabilityId: string,
): Promise<Response> {
  const account = await requireAccountFromSession(request, env);
  const body = await readJsonObject(request);

  const autopayUrl = normalizeAutopayUrl(
    body.autopay_url ?? account.autopay_url,
  );
  const pollToken = requireString(body.poll_token, "poll_token");

  // Poll the autopay worker for approval
  const pollResponse = await fetch(
    `${autopayUrl}/api/auth/requests/${encodeURIComponent(capabilityId)}/poll`,
    {
      headers: { "x-autopay-poll-token": pollToken },
    },
  );
  const pollBody = (await pollResponse.json().catch(() => null)) as Record<
    string,
    unknown
  > | null;
  if (!pollResponse.ok || !pollBody) {
    throw new HttpError(
      pollResponse.status || 502,
      "autopay_poll_failed",
      "Could not poll autopay authorization status.",
    );
  }

  const status = requireString(pollBody.status, "status");
  if (status !== "approved") {
    return jsonResponse({
      status,
      capability_id: capabilityId,
      expires_at: pollBody.expires_at,
    });
  }

  const authorization = pollBody.authorization as
    | Record<string, unknown>
    | undefined;
  const owner =
    typeof authorization?.owner === "string" ? authorization.owner : "";
  if (!owner) {
    throw new HttpError(
      502,
      "invalid_autopay_authorization",
      "Autopay approval did not include owner wallet.",
    );
  }

  const siweMessage =
    typeof authorization?.siwe_message === "string"
      ? authorization.siwe_message
      : "";
  const siweSignature =
    typeof authorization?.siwe_signature === "string"
      ? authorization.siwe_signature
      : "";
  const capability = authorization?.capability as
    | Record<string, unknown>
    | undefined;
  if (!siweMessage || !siweSignature || !capability) {
    throw new HttpError(
      502,
      "incomplete_autopay_authorization",
      "Autopay authorization is missing required fields.",
    );
  }

  const totalBudget = parseMoney(String(body.total_budget ?? "5.00"));
  const maxSingleAmount = parseMoney(
    String(body.max_single_amount ?? body.total_budget ?? "5.00"),
  );
  const validBefore =
    typeof capability.validBefore === "string"
      ? capability.validBefore
      : new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();

  const now = new Date().toISOString();
  const capId = makeId("cap");

  await env.DB.prepare(
    `INSERT INTO meteria402_autopay_capabilities
     (id, account_id, owner_address, autopay_url, siwe_message, siwe_signature, capability_json, max_single_amount, total_budget, spent_amount, valid_before, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`,
  )
    .bind(
      capId,
      account.id,
      normalizeEvmAddress(owner),
      autopayUrl,
      siweMessage,
      siweSignature,
      JSON.stringify(capability),
      maxSingleAmount,
      totalBudget,
      validBefore,
      now,
    )
    .run();

  return jsonResponse(
    {
      capability_id: capId,
      status: "active",
      owner_address: normalizeEvmAddress(owner),
      autopay_url: autopayUrl,
      total_budget: formatMoney(totalBudget),
      max_single_amount: formatMoney(maxSingleAmount),
      valid_before: validBefore,
      created_at: now,
    },
    { status: 201 },
  );
}

async function getActiveAutopayCapability(
  env: Env,
  accountId: string,
  amount: number,
): Promise<{
  id: string;
  siwe_message: string;
  siwe_signature: string;
  capability_json: string;
  autopay_url: string;
} | null> {
  const now = new Date().toISOString();
  const row = await env.DB.prepare(
    `SELECT id, siwe_message, siwe_signature, capability_json, autopay_url
     FROM meteria402_autopay_capabilities
     WHERE account_id = ?
       AND revoked_at IS NULL
       AND valid_before > ?
       AND (spent_amount + ?) <= total_budget
       AND max_single_amount >= ?
     ORDER BY created_at DESC
     LIMIT 1`,
  )
    .bind(accountId, now, amount, amount)
    .first<{
      id: string;
      siwe_message: string;
      siwe_signature: string;
      capability_json: string;
      autopay_url: string;
    }>();

  return row ?? null;
}

async function deductCapabilityBudget(
  env: Env,
  capabilityId: string,
  amount: number,
): Promise<void> {
  await env.DB.prepare(
    `UPDATE meteria402_autopay_capabilities
     SET spent_amount = spent_amount + ?
     WHERE id = ?
       AND revoked_at IS NULL
       AND (spent_amount + ?) <= total_budget`,
  )
    .bind(amount, capabilityId, amount)
    .run();
}

async function tryAutopayWithCapability(
  env: Env,
  accountId: string,
  paymentRequirementJson: string,
  amount: number,
): Promise<{
  payment_payload: unknown;
  headers: Record<string, string>;
} | null> {
  const capability = await getActiveAutopayCapability(env, accountId, amount);
  if (!capability) return null;

  try {
    const response = await fetch(`${capability.autopay_url}/api/pay`, {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({
        paymentRequired: JSON.parse(paymentRequirementJson),
        siweMessage: capability.siwe_message,
        siweSignature: capability.siwe_signature,
      }),
    });

    const body = (await response.json().catch(() => null)) as Record<
      string,
      unknown
    > | null;
    if (!response.ok || !body || !body.payment_payload) {
      console.warn("Capability pay failed", { status: response.status, body });
      return null;
    }

    // Deduct budget only after successful payment creation
    await deductCapabilityBudget(env, capability.id, amount);

    return {
      payment_payload: body.payment_payload,
      headers: (body.headers as Record<string, string>) || {},
    };
  } catch (error) {
    console.warn("Capability pay error", error);
    return null;
  }
}

async function tryAutoPayInvoice(
  env: Env,
  accountId: string,
  amount: number,
  requirement: PaymentRequirement,
): Promise<{ ok: true; method: string } | { ok: false }> {
  const account = await getAccount(env, accountId);
  if (!account) return { ok: false };

  // 1. 尝试用 excess deposit 支付（deposit_balance - min_deposit_required）
  const excess = account.deposit_balance - account.min_deposit_required;
  if (excess >= amount) {
    return { ok: true, method: "excess_deposit" };
  }

  // 2. 尝试 capability autopay
  const capResult = await tryAutopayWithCapability(
    env,
    accountId,
    JSON.stringify(requirement),
    amount,
  );
  if (capResult) {
    return { ok: true, method: "capability" };
  }

  return { ok: false };
}

async function handleChatCompletions(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
  provider: string,
): Promise<Response> {
  const account = await authenticate(request, env);
  if (account instanceof Response) return account;

  if (!env.CLOUDFLARE_ACCOUNT_ID && !env.UPSTREAM_BASE_URL) {
    return errorResponse(
      500,
      "missing_ai_gateway_config",
      "Cloudflare account ID is not configured.",
    );
  }

  const body = (await readJsonObject(request)) as ChatBody;
  const stream = body.stream === true;
  if (stream) {
    body.stream_options = {
      ...(typeof body.stream_options === "object" && body.stream_options
        ? body.stream_options
        : {}),
      include_usage: true,
    };
  }

  const requestId = makeId("req");
  const started = await startMeteredRequest(
    env,
    account.id,
    account.api_key_id,
    requestId,
    String(body.model ?? ""),
    stream,
  );
  if (started instanceof Response) return started;

  const upstreamRequest = buildAiGatewayRequest(
    env,
    provider,
    JSON.stringify(body),
    "chat/completions",
    "application/json",
    "POST",
    "",
    requestId,
    request.headers,
  );
  let upstreamResponse: Response;
  try {
    upstreamResponse = await fetch(upstreamRequest);
  } catch (error) {
    await failMeteredRequest(
      env,
      account.id,
      requestId,
      "upstream_fetch_failed",
    );
    console.error("AI Gateway request failed", error);
    return errorResponse(
      502,
      "upstream_fetch_failed",
      "The upstream AI Gateway request failed.",
    );
  }

  if (!upstreamResponse.ok) {
    await failMeteredRequest(
      env,
      account.id,
      requestId,
      `upstream_${upstreamResponse.status}`,
    );
    return copyResponse(upstreamResponse, {
      "meteria402-request-id": requestId,
    });
  }

  if (stream) {
    return proxyStreamingResponse(
      upstreamResponse,
      env,
      ctx,
      account.id,
      requestId,
      body,
    );
  }

  const responseText = await upstreamResponse.text();
  const headers = cloneHeaders(upstreamResponse.headers);
  headers.set("meteria402-request-id", requestId);

  const usage = extractUsageFromText(responseText);
  if (!usage) {
    await deferMeteredRequestForGatewayReconcile(
      env,
      account.id,
      requestId,
      body.model,
      null,
      upstreamResponse.headers,
    );
    ctx.waitUntil(reconcileGatewayLogAfterDelay(env, requestId));
    headers.set("meteria402-reconcile", "pending");
    return new Response(responseText, {
      status: upstreamResponse.status,
      statusText: upstreamResponse.statusText,
      headers,
    });
  }

  await deferMeteredRequestForGatewayReconcile(
    env,
    account.id,
    requestId,
    body.model,
    usage,
    upstreamResponse.headers,
  );
  ctx.waitUntil(reconcileGatewayLogAfterDelay(env, requestId));
  headers.set("meteria402-reconcile", "pending");

  return new Response(responseText, {
    status: upstreamResponse.status,
    statusText: upstreamResponse.statusText,
    headers,
  });
}

async function handleV1Request(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
  provider: string,
  endpoint: string,
): Promise<Response> {
  if (request.method === "GET") {
    return handleModelsRequest(request, env, provider, endpoint);
  }

  if (endpoint === "chat/completions") {
    return handleChatCompletions(request, env, ctx, provider);
  }
  return handleGenericV1Endpoint(request, env, ctx, provider, endpoint);
}

async function handleModelsRequest(
  request: Request,
  env: Env,
  provider: string,
  endpoint: string,
): Promise<Response> {
  const account = await authenticate(request, env);
  if (account instanceof Response) return account;

  if (!env.CLOUDFLARE_ACCOUNT_ID && !env.UPSTREAM_BASE_URL) {
    return errorResponse(
      500,
      "missing_ai_gateway_config",
      "Cloudflare account ID is not configured.",
    );
  }

  if (provider === "openai" && endpoint === "models") {
    return handleOpenAiModelsRequest(request, env);
  }

  const upstreamRequest = buildAiGatewayRequest(
    env,
    provider,
    null,
    endpoint,
    null,
    "GET",
    new URL(request.url).search,
    undefined,
    request.headers,
  );
  let upstreamResponse: Response;
  try {
    upstreamResponse = await fetch(upstreamRequest);
  } catch (error) {
    console.error("AI Gateway models request failed", error);
    return errorResponse(
      502,
      "upstream_fetch_failed",
      "The upstream AI Gateway request failed.",
    );
  }

  return copyResponse(upstreamResponse, {});
}

async function handleOpenAiModelsRequest(
  request: Request,
  env: Env,
): Promise<Response> {
  const upstreamRequest = buildAiGatewayRequest(
    env,
    "compat",
    null,
    "models",
    null,
    "GET",
    new URL(request.url).search,
    undefined,
    request.headers,
  );
  let upstreamResponse: Response;
  try {
    upstreamResponse = await fetch(upstreamRequest);
  } catch (error) {
    console.error("AI Gateway compat models request failed", error);
    return errorResponse(
      502,
      "upstream_fetch_failed",
      "The upstream AI Gateway request failed.",
    );
  }

  if (!upstreamResponse.ok) {
    return copyResponse(upstreamResponse, {});
  }

  const body = (await upstreamResponse.json().catch(() => null)) as
    | Record<string, unknown>
    | null;
  if (!body || !Array.isArray(body.data)) {
    return errorResponse(
      502,
      "invalid_models_response",
      "AI Gateway models response could not be parsed.",
    );
  }

  return jsonResponse({
    ...body,
    data: body.data
      .filter((model): model is Record<string, unknown> => {
        return (
          Boolean(model) &&
          typeof model === "object" &&
          typeof (model as Record<string, unknown>).id === "string" &&
          ((model as Record<string, unknown>).id as string).startsWith(
            "openai/",
          )
        );
      })
      .map((model) => ({
        ...model,
        id: (model.id as string).slice("openai/".length),
      })),
  });
}

async function handleGenericV1Endpoint(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
  provider: string,
  endpoint: string,
): Promise<Response> {
  const account = await authenticate(request, env);
  if (account instanceof Response) return account;

  if (!env.CLOUDFLARE_ACCOUNT_ID && !env.UPSTREAM_BASE_URL) {
    return errorResponse(
      500,
      "missing_ai_gateway_config",
      "Cloudflare account ID is not configured.",
    );
  }

  const contentType = request.headers.get("content-type") || "";
  const isJsonBody = contentType.includes("application/json");

  let bodyJson: Record<string, unknown> | null = null;
  let upstreamBody: BodyInit;

  if (isJsonBody) {
    try {
      const bodyClone = request.clone() as Request;
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
  const started = await startMeteredRequest(
    env,
    account.id,
    account.api_key_id,
    requestId,
    model,
    false,
  );
  if (started instanceof Response) return started;

  const upstreamRequest = buildAiGatewayRequest(
    env,
    provider,
    upstreamBody,
    endpoint,
    contentType,
    "POST",
    "",
    requestId,
    request.headers,
  );
  let upstreamResponse: Response;
  try {
    upstreamResponse = await fetch(upstreamRequest);
  } catch (error) {
    await failMeteredRequest(
      env,
      account.id,
      requestId,
      "upstream_fetch_failed",
    );
    console.error("AI Gateway request failed", error);
    return errorResponse(
      502,
      "upstream_fetch_failed",
      "The upstream AI Gateway request failed.",
    );
  }

  if (!upstreamResponse.ok) {
    await failMeteredRequest(
      env,
      account.id,
      requestId,
      `upstream_${upstreamResponse.status}`,
    );
    return copyResponse(upstreamResponse, {
      "meteria402-request-id": requestId,
    });
  }

  const responseContentType =
    upstreamResponse.headers.get("content-type") || "";
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
    await deferMeteredRequestForGatewayReconcile(
      env,
      account.id,
      requestId,
      model,
      null,
      upstreamResponse.headers,
    );
    ctx.waitUntil(reconcileGatewayLogAfterDelay(env, requestId));
    headers.set("meteria402-reconcile", "pending");
    return new Response(responseBody, {
      status: upstreamResponse.status,
      statusText: upstreamResponse.statusText,
      headers,
    });
  }

  await deferMeteredRequestForGatewayReconcile(
    env,
    account.id,
    requestId,
    model,
    usage,
    upstreamResponse.headers,
  );
  ctx.waitUntil(reconcileGatewayLogAfterDelay(env, requestId));
  headers.set("meteria402-reconcile", "pending");

  return new Response(responseBody, {
    status: upstreamResponse.status,
    statusText: upstreamResponse.statusText,
    headers,
  });
}

async function startMeteredRequest(
  env: Env,
  accountId: string,
  apiKeyId: string,
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
     RETURNING id`,
  )
    .bind(now, accountId)
    .first<{ id: string }>();

  if (!gate) {
    const account = await getAccount(env, accountId);
    if (!account) {
      return errorResponse(401, "invalid_api_key", "The API key is invalid.");
    }
    if (account.status !== "active") {
      return errorResponse(
        403,
        "account_not_active",
        "The account is not active.",
      );
    }
    if (account.unpaid_invoice_total > 0) {
      return paymentRequiredResponse(
        "unpaid_invoice",
        "An unpaid invoice must be paid before making another request.",
        {
          unpaid_invoice_total: formatMoney(account.unpaid_invoice_total),
        },
      );
    }
    if (account.deposit_balance < account.min_deposit_required) {
      return paymentRequiredResponse(
        "deposit_required",
        "A refundable deposit is required before making this request.",
        {
          required_deposit: formatMoney(account.min_deposit_required),
          current_deposit: formatMoney(account.deposit_balance),
        },
      );
    }
    return errorResponse(
      429,
      "concurrency_limit_exceeded",
      "The account concurrency limit has been reached.",
    );
  }

  try {
    await env.DB.prepare(
      `INSERT INTO meteria402_requests (id, account_id, api_key_id, status, model, stream, started_at)
       VALUES (?, ?, ?, 'running', ?, ?, ?)`,
    )
      .bind(requestId, accountId, apiKeyId, model || null, stream ? 1 : 0, now)
      .run();
  } catch (error) {
    await decrementActiveRequest(env, accountId);
    throw error;
  }

  return true;
}

async function failMeteredRequest(
  env: Env,
  accountId: string,
  requestId: string,
  errorCode: string,
): Promise<void> {
  const now = new Date().toISOString();
  await env.DB.batch([
    env.DB.prepare(
      `UPDATE meteria402_requests
       SET status = 'failed', error_code = ?, completed_at = ?
       WHERE id = ? AND account_id = ?`,
    ).bind(errorCode, now, requestId, accountId),
    env.DB.prepare(
      `UPDATE meteria402_accounts
       SET active_request_count = MAX(0, active_request_count - 1), updated_at = ?
       WHERE id = ?`,
    ).bind(now, accountId),
  ]);
}

async function markPendingReconcile(
  env: Env,
  accountId: string,
  requestId: string,
): Promise<void> {
  const now = new Date().toISOString();
  await env.DB.batch([
    env.DB.prepare(
      `UPDATE meteria402_requests
       SET status = 'pending_reconcile', completed_at = ?
       WHERE id = ? AND account_id = ?`,
    ).bind(now, requestId, accountId),
    env.DB.prepare(
      `UPDATE meteria402_accounts
       SET active_request_count = MAX(0, active_request_count - 1), updated_at = ?
       WHERE id = ?`,
    ).bind(now, accountId),
  ]);
}

async function deferMeteredRequestForGatewayReconcile(
  env: Env,
  accountId: string,
  requestId: string,
  model: unknown,
  usage: Usage | null,
  upstreamHeaders: Headers,
): Promise<void> {
  const now = new Date().toISOString();
  const aigLogId = getAiGatewayLogId(upstreamHeaders);
  await env.DB.batch([
    env.DB.prepare(
      `UPDATE meteria402_requests
       SET status = 'pending_reconcile',
           model = COALESCE(?, model),
           ai_gateway_log_id = COALESCE(?, ai_gateway_log_id),
           input_tokens = COALESCE(?, input_tokens),
           output_tokens = COALESCE(?, output_tokens),
           total_tokens = COALESCE(?, total_tokens),
           completed_at = ?
       WHERE id = ? AND account_id = ?`,
    ).bind(
      String(model ?? "") || null,
      aigLogId,
      usage?.inputTokens ?? null,
      usage?.outputTokens ?? null,
      usage?.totalTokens ?? null,
      now,
      requestId,
      accountId,
    ),
    env.DB.prepare(
      `UPDATE meteria402_accounts
       SET active_request_count = MAX(0, active_request_count - 1), updated_at = ?
       WHERE id = ?`,
    ).bind(now, accountId),
  ]);
}

async function reconcileGatewayLogAfterDelay(
  env: Env,
  requestId: string,
): Promise<void> {
  for (const delayMs of [5_000, 15_000, 45_000]) {
    await sleep(delayMs);
    const result = await reconcileOneGatewayLog(env, requestId);
    if (result.status === "settled" || result.status === "skipped") return;
  }
}

async function reconcilePendingGatewayLogs(
  env: Env,
  accountId?: string,
): Promise<{ checked: number; settled: number; pending: number; skipped: number }> {
  const rows = accountId
    ? await env.DB.prepare(
        `SELECT id
         FROM meteria402_requests
         WHERE account_id = ?
           AND status = 'pending_reconcile'
           AND ai_gateway_log_id IS NOT NULL
         ORDER BY completed_at ASC
         LIMIT 50`,
      )
        .bind(accountId)
        .all<{ id: string }>()
    : await env.DB.prepare(
        `SELECT id
         FROM meteria402_requests
         WHERE status = 'pending_reconcile'
           AND ai_gateway_log_id IS NOT NULL
         ORDER BY completed_at ASC
         LIMIT 50`,
      ).all<{ id: string }>();

  let settled = 0;
  let pending = 0;
  let skipped = 0;
  for (const row of rows.results) {
    const result = await reconcileOneGatewayLog(env, row.id);
    if (result.status === "settled") settled += 1;
    else if (result.status === "pending") pending += 1;
    else skipped += 1;
  }

  return { checked: rows.results.length, settled, pending, skipped };
}

async function reconcileOneGatewayLog(
  env: Env,
  requestId: string,
): Promise<{ status: "settled" | "pending" | "skipped" }> {
  const request = await env.DB.prepare(
    `UPDATE meteria402_requests
     SET status = 'reconciling'
     WHERE id = ?
       AND status = 'pending_reconcile'
       AND ai_gateway_log_id IS NOT NULL
     RETURNING id, account_id, model, ai_gateway_log_id, input_tokens, output_tokens, total_tokens`,
  )
    .bind(requestId)
    .first<{
      id: string;
      account_id: string;
      model: string | null;
      ai_gateway_log_id: string;
      input_tokens: number | null;
      output_tokens: number | null;
      total_tokens: number | null;
    }>();

  if (!request) return { status: "skipped" };

  try {
    const log = await fetchAiGatewayLogCost(env, request.ai_gateway_log_id);
    if (!log) {
      await restorePendingReconcile(env, request.id);
      return { status: "pending" };
    }

    const usage =
      log.usage ??
      (request.input_tokens != null &&
      request.output_tokens != null &&
      request.total_tokens != null
        ? {
            inputTokens: request.input_tokens,
            outputTokens: request.output_tokens,
            totalTokens: request.total_tokens,
          }
        : { inputTokens: 0, outputTokens: 0, totalTokens: 0 });

    await settleMeteredRequest(
      env,
      request.account_id,
      request.id,
      request.model,
      usage,
      log.cost,
      new Headers({ "cf-aig-log-id": request.ai_gateway_log_id }),
    );
    return { status: "settled" };
  } catch (error) {
    console.error("AI Gateway log reconcile failed", {
      requestId: request.id,
      logId: request.ai_gateway_log_id,
      error,
    });
    await restorePendingReconcile(env, request.id);
    return { status: "pending" };
  }
}

async function restorePendingReconcile(
  env: Env,
  requestId: string,
): Promise<void> {
  await env.DB.prepare(
    `UPDATE meteria402_requests
     SET status = 'pending_reconcile'
     WHERE id = ? AND status = 'reconciling'`,
  )
    .bind(requestId)
    .run();
}

async function settleMeteredRequest(
  env: Env,
  accountId: string,
  requestId: string,
  model: unknown,
  usage: Usage,
  cost: number,
  upstreamHeaders: Headers,
): Promise<{ invoiceId: string; autoPaid: boolean; autoPayMethod?: string }> {
  const now = new Date().toISOString();
  const invoiceId = makeId("inv");
  const aigLogId =
    upstreamHeaders.get("cf-aig-log-id") ??
    upstreamHeaders.get("cf-ai-gateway-log-id");
  const requirement = createPaymentRequirementFromValues(env, {
    resource: `/api/invoices/${invoiceId}/pay`,
    kind: "invoice",
    id: invoiceId,
    amount: cost,
    description: `Meteria402 invoice ${invoiceId}`,
  });

  // Step 1: 先更新 request 状态
  await env.DB.prepare(
    `UPDATE meteria402_requests
     SET status = 'completed',
         model = COALESCE(?, model),
         ai_gateway_log_id = ?,
         input_tokens = ?,
         output_tokens = ?,
         total_tokens = ?,
         final_cost = ?,
         completed_at = ?
     WHERE id = ? AND account_id = ?`,
  )
    .bind(
      String(model ?? "") || null,
      aigLogId,
      usage.inputTokens,
      usage.outputTokens,
      usage.totalTokens,
      cost,
      now,
      requestId,
      accountId,
    )
    .run();

  // Step 2: 尝试自动支付
  const autoPay = await tryAutoPayInvoice(env, accountId, cost, requirement);

  if (autoPay.ok) {
    // 自动支付成功：invoice 直接 paid
    const ledgerId = makeId("led");
    const batch: D1PreparedStatement[] = [
      env.DB.prepare(
        `INSERT INTO meteria402_invoices
         (id, account_id, request_id, status, amount_due, currency, payment_requirement_json, created_at, paid_at)
         VALUES (?, ?, ?, 'paid', ?, 'USD', ?, ?, ?)`,
      ).bind(
        invoiceId,
        accountId,
        requestId,
        cost,
        JSON.stringify(requirement),
        now,
        now,
      ),
      env.DB.prepare(
        `UPDATE meteria402_accounts
         SET active_request_count = MAX(0, active_request_count - 1),
             updated_at = ?
         WHERE id = ?`,
      ).bind(now, accountId),
      env.DB.prepare(
        `INSERT INTO meteria402_ledger_entries
         (id, account_id, type, amount, currency, related_request_id, related_invoice_id, created_at)
         VALUES (?, ?, 'invoice_paid', ?, 'USD', ?, ?, ?)`,
      ).bind(ledgerId, accountId, cost, requestId, invoiceId, now),
    ];

    if (autoPay.method === "excess_deposit") {
      batch.push(
        env.DB.prepare(
          `UPDATE meteria402_accounts
           SET deposit_balance = deposit_balance - ?,
               updated_at = ?
           WHERE id = ?`,
        ).bind(cost, now, accountId),
      );
    }

    await env.DB.batch(batch);
  } else {
    // 挂账
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO meteria402_invoices
         (id, account_id, request_id, status, amount_due, currency, payment_requirement_json, created_at)
         VALUES (?, ?, ?, 'unpaid', ?, 'USD', ?, ?)`,
      ).bind(
        invoiceId,
        accountId,
        requestId,
        cost,
        JSON.stringify(requirement),
        now,
      ),
      env.DB.prepare(
        `UPDATE meteria402_accounts
         SET active_request_count = MAX(0, active_request_count - 1),
             unpaid_invoice_total = unpaid_invoice_total + ?,
             updated_at = ?
         WHERE id = ?`,
      ).bind(cost, now, accountId),
      env.DB.prepare(
        `INSERT INTO meteria402_ledger_entries
         (id, account_id, type, amount, currency, related_request_id, related_invoice_id, created_at)
         VALUES (?, ?, 'invoice_created', ?, 'USD', ?, ?, ?)`,
      ).bind(makeId("led"), accountId, cost, requestId, invoiceId, now),
    ]);
  }

  return {
    invoiceId,
    autoPaid: autoPay.ok,
    autoPayMethod: autoPay.ok ? autoPay.method : undefined,
  };
}

async function decrementActiveRequest(
  env: Env,
  accountId: string,
): Promise<void> {
  await env.DB.prepare(
    `UPDATE meteria402_accounts
     SET active_request_count = MAX(0, active_request_count - 1), updated_at = ?
     WHERE id = ?`,
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
    ctx.waitUntil(
      (async () => {
        await deferMeteredRequestForGatewayReconcile(
          env,
          accountId,
          requestId,
          body.model,
          null,
          upstreamResponse.headers,
        );
        await reconcileGatewayLogAfterDelay(env, requestId);
      })(),
    );
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

  ctx.waitUntil(
    (async () => {
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          if (value) {
            buffer += decoder.decode(value, { stream: true });
            usage = extractUsageFromSseBuffer(buffer) ?? usage;
            const lastDoubleBreak = Math.max(
              buffer.lastIndexOf("\n\n"),
              buffer.lastIndexOf("\r\n\r\n"),
            );
            if (lastDoubleBreak >= 0) {
              buffer = buffer.slice(lastDoubleBreak + 2);
            }
            await writer.write(value);
          }
        }
        buffer += decoder.decode();
        usage = extractUsageFromSseBuffer(buffer) ?? usage;
        if (usage) {
          await deferMeteredRequestForGatewayReconcile(
            env,
            accountId,
            requestId,
            body.model,
            usage,
            upstreamResponse.headers,
          );
          await reconcileGatewayLogAfterDelay(env, requestId);
        } else {
          await deferMeteredRequestForGatewayReconcile(
            env,
            accountId,
            requestId,
            body.model,
            null,
            upstreamResponse.headers,
          );
          await reconcileGatewayLogAfterDelay(env, requestId);
        }
        await writer.close();
      } catch (error) {
        console.error("Streaming proxy failed", error);
        await failMeteredRequest(
          env,
          accountId,
          requestId,
          "stream_proxy_failed",
        );
        await writer.abort(error);
      } finally {
        reader.releaseLock();
      }
    })(),
  );

  return new Response(readable, {
    status: upstreamResponse.status,
    statusText: upstreamResponse.statusText,
    headers,
  });
}

function buildAiGatewayRequest(
  env: Env,
  provider: string,
  body: BodyInit | null,
  endpoint: string,
  contentType: string | null,
  method = "POST",
  search = "",
  requestId?: string,
  sourceHeaders?: Headers,
): Request {
  const upstreamUrl = env.UPSTREAM_BASE_URL;
  if (upstreamUrl) {
    const url = `${formatUpstreamBaseUrl(upstreamUrl, provider)}/${endpoint}${search}`;
    const headers = buildUpstreamHeaders(env, provider, contentType, sourceHeaders);
    addAiGatewayAuthHeaders(headers, env);
    addAiGatewayLogHeaders(headers, requestId);
    return new Request(url, {
      method,
      headers,
      ...(body == null ? {} : { body }),
    });
  }

  const gatewayId = env.AI_GATEWAY_ID || "default";
  const gatewayProvider = provider || DEFAULT_GATEWAY_PROVIDER;
  const url = `https://gateway.ai.cloudflare.com/v1/${encodeURIComponent(env.CLOUDFLARE_ACCOUNT_ID || "")}/${encodeURIComponent(gatewayId)}/${encodeURIComponent(gatewayProvider)}/${endpoint}${search}`;
  const headers = buildUpstreamHeaders(env, gatewayProvider, contentType, sourceHeaders);
  addAiGatewayAuthHeaders(headers, env);
  addAiGatewayLogHeaders(headers, requestId);
  return new Request(url, {
    method,
    headers,
    ...(body == null ? {} : { body }),
  });
}

function formatUpstreamBaseUrl(upstreamUrl: string, provider: string): string {
  const base = upstreamUrl.replace(/\/$/, "");
  if (base.includes("{provider}")) {
    return base.replaceAll("{provider}", encodeURIComponent(provider));
  }
  return base;
}

function buildUpstreamHeaders(
  env: Env,
  provider: string,
  contentType: string | null,
  sourceHeaders?: Headers,
): Headers {
  const headers = new Headers();
  if (contentType) {
    headers.set("content-type", contentType);
  }
  copyProviderHeaders(headers, provider, sourceHeaders);
  addProviderApiKeyHeaders(headers, env, provider);
  return headers;
}

function copyProviderHeaders(
  headers: Headers,
  provider: string,
  sourceHeaders?: Headers,
): void {
  if (!sourceHeaders) return;

  const allowlist = new Set([
    "accept",
    "anthropic-beta",
    "anthropic-version",
    "openai-organization",
    "openai-project",
    "x-goog-api-client",
  ]);

  if (provider === "openrouter") {
    allowlist.add("http-referer");
    allowlist.add("x-title");
  }

  for (const name of allowlist) {
    const value = sourceHeaders.get(name);
    if (value) headers.set(name, value);
  }
}

function addProviderApiKeyHeaders(
  headers: Headers,
  env: Env,
  provider: string,
): void {
  if (!env.AI_GATEWAY_API_KEY) return;
  if (provider === "anthropic") {
    headers.set("x-api-key", env.AI_GATEWAY_API_KEY);
    return;
  }
  if (provider === "google-ai-studio") {
    headers.set("x-goog-api-key", env.AI_GATEWAY_API_KEY);
    return;
  }
  headers.set("authorization", `Bearer ${env.AI_GATEWAY_API_KEY}`);
}

function addAiGatewayLogHeaders(headers: Headers, requestId?: string): void {
  if (!requestId) return;
  headers.set("cf-aig-collect-log-payload", "false");
  headers.set("cf-aig-metadata", JSON.stringify({ request_id: requestId }));
}

function addAiGatewayAuthHeaders(headers: Headers, env: Env): void {
  if (env.AI_GATEWAY_AUTH_TOKEN) {
    headers.set("cf-aig-authorization", `Bearer ${env.AI_GATEWAY_AUTH_TOKEN}`);
  }
}

function getAiGatewayLogId(headers: Headers): string | null {
  return (
    headers.get("cf-aig-log-id") ??
    headers.get("cf-ai-gateway-log-id")
  );
}

async function fetchAiGatewayLogCost(
  env: Env,
  logId: string,
): Promise<{ cost: number; usage?: Usage } | null> {
  const tokens = [
    env.CLOUDFLARE_API_TOKEN,
    env.AI_GATEWAY_AUTH_TOKEN,
    env.AI_GATEWAY_API_KEY,
  ].filter((token): token is string => Boolean(token));
  const accountId = env.CLOUDFLARE_ACCOUNT_ID;
  if (tokens.length === 0 || !accountId) {
    console.warn("AI Gateway log lookup skipped", {
      logId,
      hasAccountId: Boolean(accountId),
      hasCloudflareApiToken: Boolean(env.CLOUDFLARE_API_TOKEN),
      hasGatewayAuthToken: Boolean(env.AI_GATEWAY_AUTH_TOKEN),
      hasGatewayApiKey: Boolean(env.AI_GATEWAY_API_KEY),
    });
    return null;
  }

  const gatewayId = env.AI_GATEWAY_ID || "default";
  const url =
    `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(accountId)}` +
    `/ai-gateway/gateways/${encodeURIComponent(gatewayId)}` +
    `/logs/${encodeURIComponent(logId)}`;
  let response: Response | null = null;
  for (const token of tokens) {
    response = await fetch(url, {
      headers: { authorization: `Bearer ${token}` },
    });
    if (response.ok || response.status === 404) break;
    if (response.status !== 401 && response.status !== 403) break;
  }
  if (!response || response.status === 404) return null;
  if (!response.ok) {
    console.error("AI Gateway log lookup failed", {
      status: response.status,
      logId,
    });
    return null;
  }

  const body = (await response.json().catch(() => null)) as
    | { result?: unknown }
    | null;
  const result =
    body && typeof body.result === "object" && body.result
      ? (body.result as Record<string, unknown>)
      : null;
  if (!result) {
    console.warn("AI Gateway log lookup returned no result", { logId, body });
    return null;
  }

  const dollarCost =
    typeof result.cost === "number"
      ? result.cost
      : typeof result.cost === "string"
        ? Number(result.cost)
        : null;
  if (dollarCost == null || !Number.isFinite(dollarCost)) {
    console.warn("AI Gateway log lookup returned no cost", {
      logId,
      cost: result.cost,
      tokens_in: result.tokens_in,
      tokens_out: result.tokens_out,
    });
    return null;
  }

  const cost = Math.max(1, Math.ceil(dollarCost * 1_000_000));
  return {
    cost,
    usage: usageFromAiGatewayLog(result),
  };
}

function usageFromAiGatewayLog(log: Record<string, unknown>): Usage | undefined {
  const inputTokens = numberFromUnknown(log.tokens_in);
  const outputTokens = numberFromUnknown(log.tokens_out);
  if (inputTokens == null && outputTokens == null) return undefined;
  const input = inputTokens ?? 0;
  const output = outputTokens ?? 0;
  const total = numberFromUnknown(log.total_tokens) ?? input + output;
  return { inputTokens: input, outputTokens: output, totalTokens: total };
}

function calculateCost(model: unknown, usage: Usage, env: Env): number {
  const priceTable = parsePriceTable(env);
  const modelKey = typeof model === "string" ? model : "";
  const modelPrice = modelKey ? priceTable[modelKey] : undefined;
  const inputPrice =
    modelPrice?.input_micro_usd_per_token ??
    parseMoneyLikeNumber(env.DEFAULT_INPUT_MICRO_USD_PER_TOKEN ?? "1");
  const outputPrice =
    modelPrice?.output_micro_usd_per_token ??
    parseMoneyLikeNumber(env.DEFAULT_OUTPUT_MICRO_USD_PER_TOKEN ?? "4");
  const cost = Math.ceil(
    usage.inputTokens * inputPrice + usage.outputTokens * outputPrice,
  );
  return Math.max(cost, 1);
}

function parsePriceTable(
  env: Env,
): Record<
  string,
  { input_micro_usd_per_token: number; output_micro_usd_per_token: number }
> {
  const raw = (env as { PRICE_TABLE_JSON?: string }).PRICE_TABLE_JSON;
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as Record<
      string,
      {
        input_micro_usd_per_token?: unknown;
        output_micro_usd_per_token?: unknown;
      }
    >;
    const table: Record<
      string,
      { input_micro_usd_per_token: number; output_micro_usd_per_token: number }
    > = {};
    for (const [key, value] of Object.entries(parsed)) {
      table[key] = {
        input_micro_usd_per_token: parseMoneyLikeNumber(
          String(value.input_micro_usd_per_token ?? "0"),
        ),
        output_micro_usd_per_token: parseMoneyLikeNumber(
          String(value.output_micro_usd_per_token ?? "0"),
        ),
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
  const output = numberFromUnknown(
    usage.completion_tokens ?? usage.output_tokens,
  );
  const total =
    numberFromUnknown(usage.total_tokens) ?? (input ?? 0) + (output ?? 0);
  if (input == null && output == null && total === 0) return null;
  return {
    inputTokens: input ?? Math.max(0, total - (output ?? 0)),
    outputTokens: output ?? Math.max(0, total - (input ?? 0)),
    totalTokens: total,
  };
}
