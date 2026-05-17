import { getAccountByOwner } from "./accounts";
import { createApiKey, randomApiKeyName } from "./api-keys";
import { normalizeAutopayUrl } from "./autopay";
import { makeId, sha256Hex } from "./crypto";
import { getSettingWithFallback } from "./settings";
import {
  errorResponse,
  HttpError,
  jsonResponse,
  readJsonObject,
  requireString,
} from "./http";
import { formatMoney, parseMoney, parsePositiveInt } from "./money";
import { requireSession } from "./session";
import {
  signDepositIntent,
  signDepositQuote,
  verifyDepositAutopayState,
  verifyDepositIntent,
  verifyDepositQuote,
} from "./signed-state";
import type { DepositIntentState, DepositQuoteState, Env } from "./types";
import {
  createPaymentRequirement,
  createPaymentRequirementFromValues,
  normalizeEvmAddress,
  paymentCurrencyFromRequirement,
  settlementErrorExtra,
  verifyPayment,
  verifyTxHash,
} from "./x402";

import {
  completeAutopayForDepositQuote,
  reportAutopaySettlement,
  startAutopayForDepositQuote,
} from "./billing-autopay-handlers";

export async function handleDepositQuote(
  request: Request,
  env: Env,
): Promise<Response> {
  const session = await requireSession(request, env);
  const body = await readJsonObject(request);
  const account = await getAccountByOwner(env, session.owner);
  const requestedAutopayUrl =
    typeof (body.autopay_url ?? body.autopayUrl) === "string" &&
    String(body.autopay_url ?? body.autopayUrl).trim()
      ? normalizeAutopayUrl(body.autopay_url ?? body.autopayUrl)
      : "";
  const autopayUrl = account?.autopay_url || requestedAutopayUrl;
  const defaultMinDeposit = await getSettingWithFallback(env.DB, "default_min_deposit", env.DEFAULT_MIN_DEPOSIT);
  const amount = parseMoney(
    String(body.amount ?? defaultMinDeposit),
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
  const paymentCurrency = paymentCurrencyFromRequirement(requirement);

  const nowSeconds = Math.floor(Date.now() / 1000);
  const validAfter = nowSeconds - 60; // allow 1 min clock skew
  const validBefore = nowSeconds + 300; // 5 min expiry
  const nonceBytes = new Uint8Array(32);
  crypto.getRandomValues(nonceBytes);
  const nonce =
    "0x" + [...nonceBytes].map((b) => b.toString(16).padStart(2, "0")).join("");
  const authMeta = {
    nonce,
    valid_after: String(validAfter),
    valid_before: String(validBefore),
  };

  const expiresAt = Date.now() + 60 * 60 * 1000;
  const quoteToken = await signDepositQuote(env, {
    payment_id: paymentId,
    kind: "deposit",
    amount,
    currency: paymentCurrency,
    owner_address: session.owner,
    autopay_url: autopayUrl,
    payment_requirement: requirement,
    authorization: authMeta,
    expires_at: expiresAt,
  });
  const accept = requirement.accepts[0];
  const intentToken = await signDepositIntent(env, {
    payment_id: paymentId,
    amount,
    owner_address: session.owner,
    autopay_url: autopayUrl,
    token_amount: accept.amount,
    currency: paymentCurrency,
    network: accept.network,
    asset: accept.asset,
    pay_to: accept.payTo,
    nonce,
    valid_after: String(validAfter),
    valid_before: String(validBefore),
    expires_at: expiresAt,
  });

  return jsonResponse({
    payment_id: paymentId,
    amount: formatMoney(amount),
    currency: paymentCurrency,
    payment_requirement: requirement,
    authorization: {
      to: requirement.accepts[0].payTo,
      value: requirement.accepts[0].amount,
      valid_after: String(validAfter),
      valid_before: String(validBefore),
      nonce,
    },
    quote_token: quoteToken,
    intent_token: intentToken,
    expires_at: new Date(expiresAt).toISOString(),
  });
}

export async function handleDepositSettle(
  request: Request,
  env: Env,
): Promise<Response> {
  const body = await readJsonObject(request);
  const quoteTokenInput = body.quote_token ?? body.quoteToken;
  const intentTokenInput = body.deposit_intent ?? body.depositIntent;
  const quote =
    quoteTokenInput != null
      ? await verifyDepositQuote(
          env,
          requireString(quoteTokenInput, "quote_token"),
        )
      : depositQuoteFromIntent(
          request,
          env,
          await verifyDepositIntent(
            env,
            requireString(intentTokenInput, "deposit_intent"),
          ),
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
  const ownerAddress = normalizeEvmAddress(quote.owner_address);
  const autopayUrl = quote.autopay_url ? normalizeAutopayUrl(quote.autopay_url) : null;

  const paymentRequirementJson = JSON.stringify(quote.payment_requirement);
  const paymentCurrency = quote.currency;

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
           VALUES (?, 'deposit', ?, ?, 'verification_failed', ?, ?, ?, ?)`,
        )
          .bind(
            paymentId,
            quote.amount,
            paymentCurrency,
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
  } else {
    // Validate authorization nonce matches what we issued
    if (paymentPayload) {
      try {
        const payload = (paymentPayload as Record<string, unknown> | null)
          ?.payload;
        const payloadAuth =
          payload && typeof payload === "object"
            ? (payload as Record<string, unknown>).authorization
            : null;
        if (payloadAuth && typeof payloadAuth === "object") {
          const submittedNonce = (payloadAuth as Record<string, unknown>).nonce;
          const expectedNonce = quote.authorization.nonce;
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
           VALUES (?, 'deposit', ?, ?, 'verification_failed', ?, ?, ?)`,
        )
          .bind(
            paymentId,
            quote.amount,
            paymentCurrency,
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

  const minDepositStr = await getSettingWithFallback(env.DB, "default_min_deposit", env.DEFAULT_MIN_DEPOSIT);
  const concurrencyLimitStr = await getSettingWithFallback(env.DB, "default_concurrency_limit", env.DEFAULT_CONCURRENCY_LIMIT);
  const minDeposit = parseMoney(minDepositStr);
  const concurrencyLimit = parsePositiveInt(
    concurrencyLimitStr,
    8,
  );

  // ─── Check if owner already has an account — if so, top up instead of creating new ───
  let existingAccount: { id: string; deposit_balance: number } | null =
    await getAccountByOwner(env, ownerAddress);

  if (existingAccount) {
    // Top-up existing account
    const newBalance = existingAccount.deposit_balance + quote.amount;
    await env.DB.batch([
      env.DB.prepare(
        `UPDATE meteria402_accounts SET deposit_balance = ?, updated_at = ? WHERE id = ?`,
      ).bind(newBalance, now, existingAccount.id),
      env.DB.prepare(
        `INSERT INTO meteria402_payments (id, account_id, kind, amount, currency, status, x402_payload_hash, tx_hash, payment_requirement_json, response_json, created_at, settled_at)
         VALUES (?, ?, 'deposit', ?, ?, 'settled', ?, ?, ?, ?, ?, ?)
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
        paymentCurrency,
        payloadHash,
        settlement.txHash ?? null,
        paymentRequirementJson,
        JSON.stringify(settlement.raw ?? {}),
        now,
        now,
      ),
      env.DB.prepare(
        `INSERT INTO meteria402_ledger_entries (id, account_id, type, amount, currency, related_payment_id, created_at)
         VALUES (?, ?, 'deposit_paid', ?, ?, ?, ?)`,
      ).bind(
        makeId("led"),
        existingAccount.id,
        quote.amount,
        paymentCurrency,
        paymentId,
        now,
      ),
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
	       (id, status, owner_address, autopay_url, deposit_balance, unpaid_invoice_total, concurrency_limit, min_deposit_required, refund_address, autopay_min_recharge_amount, created_at, updated_at)
	       VALUES (?, 'active', ?, ?, ?, 0, ?, ?, ?, 10000, ?, ?)`,
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
       VALUES (?, ?, 'deposit', ?, ?, 'settled', ?, ?, ?, ?, ?, ?)
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
      paymentCurrency,
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
       VALUES (?, ?, 'deposit_paid', ?, ?, ?, ?)`,
    ).bind(
      makeId("led"),
      accountId,
      quote.amount,
      paymentCurrency,
      paymentId,
      now,
    ),
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

export async function handleDepositIntent(
  request: Request,
  env: Env,
): Promise<Response> {
  const url = new URL(request.url);
  const token = requireString(url.searchParams.get("i"), "deposit_intent");
  const quote = depositQuoteFromIntent(
    request,
    env,
    await verifyDepositIntent(env, token),
  );
  const accept = quote.payment_requirement.accepts[0];
  return jsonResponse({
    payment_id: quote.payment_id,
    amount: formatMoney(quote.amount),
    currency: quote.currency,
    payment_requirement: quote.payment_requirement,
    authorization: {
      to: accept.payTo,
      value: accept.amount,
      valid_after: quote.authorization.valid_after,
      valid_before: quote.authorization.valid_before,
      nonce: quote.authorization.nonce,
    },
    deposit_intent: token,
    expires_at: new Date(quote.expires_at).toISOString(),
  });
}

function depositQuoteFromIntent(
  request: Request,
  env: Env,
  intent: DepositIntentState,
): DepositQuoteState {
  const url = new URL(request.url);
  const requirement = createPaymentRequirementFromValues(env, {
    resource: `${url.origin}/api/payments/${intent.payment_id}`,
    kind: "deposit",
    id: intent.payment_id,
    amount: intent.amount,
    description: "Refundable Meteria402 API deposit",
  });
  const accept = requirement.accepts[0];
  if (
    (intent.network && accept.network !== intent.network) ||
    (intent.asset &&
      accept.asset.toLowerCase() !== intent.asset.toLowerCase()) ||
    (intent.token_amount && accept.amount !== intent.token_amount) ||
    (intent.pay_to &&
      accept.payTo.toLowerCase() !== intent.pay_to.toLowerCase())
  ) {
    throw new HttpError(
      400,
      "deposit_intent_config_mismatch",
      "Deposit intent does not match the current payment configuration.",
    );
  }
  return {
    payment_id: intent.payment_id,
    kind: "deposit",
    amount: intent.amount,
    currency: intent.currency || paymentCurrencyFromRequirement(requirement),
    owner_address: intent.owner_address,
    autopay_url: intent.autopay_url,
    payment_requirement: requirement,
    authorization: {
      nonce: intent.nonce,
      valid_after: intent.valid_after,
      valid_before: intent.valid_before,
    },
    expires_at: intent.expires_at,
  };
}

export async function handleDepositAutopayStart(
  request: Request,
  env: Env,
  paymentId: string,
): Promise<Response> {
  const body = await readJsonObject(request);
  const quoteToken = requireString(
    body.quote_token ?? body.quoteToken,
    "quote_token",
  );
  const quote = await verifyDepositQuote(env, quoteToken);
  if (paymentId !== quote.payment_id) {
    return errorResponse(
      400,
      "payment_quote_mismatch",
      "Payment ID does not match the deposit quote.",
    );
  }
  if (!quote.autopay_url) {
    return errorResponse(
      400,
      "missing_autopay_url",
      "Deposit quote does not include an autopay endpoint.",
    );
  }
  const autopayUrl = normalizeAutopayUrl(quote.autopay_url);

  return startAutopayForDepositQuote(
    request,
    env,
    quote,
    quoteToken,
    autopayUrl,
  );
}

export async function handleDepositAutopayComplete(
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
  const result = await completeAutopayForDepositQuote(
    env,
    request,
    autopayState,
  );
  if (result.status !== "approved") return jsonResponse(result);
  const quote = await verifyDepositQuote(env, autopayState.quote_token);
  if (normalizeEvmAddress(result.owner).toLowerCase() !== quote.owner_address.toLowerCase()) {
    return errorResponse(
      403,
      "deposit_owner_mismatch",
      "Approved wallet does not match the deposit owner.",
    );
  }

  const settleRequest = new Request(
    new URL("/api/deposits/settle", request.url),
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        payment_id: paymentId,
        quote_token: autopayState.quote_token,
        payment_payload: result.payment_payload,
      }),
    },
  );
  const settleResponse = await handleDepositSettle(settleRequest, env);
  const settlement = await settleResponse.json().catch(() => null);
  if (settleResponse.ok && settlement && typeof settlement === "object") {
    await reportAutopaySettlement(env, {
      autopayUrl:
        typeof result.autopay_url === "string" ? result.autopay_url : undefined,
      autopayRequestId:
        typeof result.worker_autopay_request_id === "string"
          ? result.worker_autopay_request_id
          : typeof result.autopay_request_id === "string"
            ? result.autopay_request_id
            : undefined,
      paymentId,
      status: "settled",
      amount: formatMoney(quote.amount),
      txHash:
        typeof (settlement as Record<string, unknown>).tx_hash === "string"
          ? ((settlement as Record<string, unknown>).tx_hash as string)
          : undefined,
      settledAt: new Date().toISOString(),
    });
  }
  return jsonResponse(
    {
      status: settleResponse.ok ? "settled" : "settle_failed",
      autopay_status: result.status,
      settlement,
    },
    { status: settleResponse.status },
  );
}
