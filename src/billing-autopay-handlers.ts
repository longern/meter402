import {
  getAccount,
  requireAccountFromSession,
  requirePaymentAccountAutopayUrl,
} from "./accounts";
import { accountGateActiveCount } from "./account-gate";
import { normalizeAutopayUrl } from "./autopay";
import { BASE_MAINNET, BASE_USDC, JSON_HEADERS } from "./constants";
import { makeId, sha256Hex } from "./crypto";
import {
  errorResponse,
  HttpError,
  jsonResponse,
  paymentRequiredResponse,
  readJsonObject,
  requireString,
} from "./http";
import { formatMoney, parseMoney } from "./money";
import {
  hashAutopayCapability,
  requesterMetadata,
  signedAutopayHeaders,
  signedSettlementReportHeaders,
} from "./requester-proof";
import { signDepositAutopayState, verifyDepositQuote } from "./signed-state";
import type {
  AutopayRequestRow,
  DepositAutopayState,
  DepositQuoteState,
  Env,
  PaymentRequirement,
} from "./types";
import {
  createPaymentRequirement,
  createPaymentRequirementFromValues,
  normalizeEvmAddress,
  paymentCurrencyFromRequirement,
  requireRecipientAddress,
  settlementErrorExtra,
  verifyPayment,
  x402AmountFromMicroUsd,
} from "./x402";

type AutopayPaymentResult = {
  status: "approved";
  payment_id: string;
  autopay_request_id?: string;
  worker_autopay_request_id?: string;
  autopay_url?: string;
  payment_payload: unknown;
  selected_requirement?: unknown;
  capability_used?: boolean;
  capability_id?: string;
  capability_amount?: number;
};

type AutopayPendingResult = Record<string, unknown> & {
  status: string;
  payment_id: string;
  autopay_request_id?: string;
};

type CapabilityBudgetCharge = {
  id: string;
  amount: number;
};

type SettlementReportInput = {
  autopayUrl?: string | null;
  autopayRequestId?: string;
  paymentId: string;
  invoiceId?: string | null;
  status: "settled";
  amount: string;
  txHash?: string;
  settledAt: string;
};

export async function handleInvoicePayQuote(
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
  const minRechargeAmount = account.autopay_min_recharge_amount || 0;
  const rechargeNeededForDepositFloor =
    Math.max(0, account.min_deposit_required - account.deposit_balance) +
    invoice.amount_due;
  const paymentKind =
    minRechargeAmount > invoice.amount_due ||
    rechargeNeededForDepositFloor > invoice.amount_due
      ? "deposit"
      : "invoice";
  const paymentAmount =
    paymentKind === "deposit"
      ? Math.max(minRechargeAmount, rechargeNeededForDepositFloor)
      : invoice.amount_due;
  const requirement = createPaymentRequirement(request, env, {
    kind: paymentKind,
    id: paymentKind === "deposit" ? paymentId : invoice.id,
    amount: paymentAmount,
    description:
      paymentKind === "deposit"
        ? `Meteria402 recharge for invoice ${invoice.id}`
        : `Meteria402 invoice ${invoice.id}`,
  });
  const paymentCurrency = paymentCurrencyFromRequirement(requirement);

  await env.DB.prepare(
    `INSERT INTO meteria402_payments
     (id, account_id, invoice_id, kind, amount, currency, status, payment_requirement_json)
     VALUES (?, ?, ?, ?, ?, ?, 'pending', ?)`,
  )
    .bind(
      paymentId,
      account.id,
      invoice.id,
      paymentKind,
      paymentAmount,
      paymentCurrency,
      JSON.stringify(requirement),
    )
    .run();

  return jsonResponse({
    payment_id: paymentId,
    invoice_id: invoice.id,
    amount: formatMoney(invoice.amount_due),
    currency: paymentCurrency,
    payment_requirement: requirement,
  });
}

export async function handleInvoicePaySettle(
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
    `SELECT p.id, p.kind
     FROM meteria402_payments p
     JOIN meteria402_invoices i ON i.id = p.invoice_id
     WHERE p.id = ? AND p.invoice_id = ? AND p.account_id = ? AND p.kind IN ('invoice', 'deposit')`,
  )
    .bind(paymentId, invoiceId, account.id)
    .first<{
      id: string;
      kind: string;
    }>();

  if (!payment) {
    return errorResponse(
      404,
      "payment_not_found",
      "Payment quote was not found.",
    );
  }

  if (payment.kind === "deposit") {
    const recharge = await settleRechargePaymentForInvoice(
      env,
      account.id,
      invoiceId,
      paymentId,
      paymentPayload,
      devProof,
    );
    return jsonResponse(recharge.body, { status: recharge.status });
  }

  const settlement = await settleInvoicePayment(
    env,
    account.id,
    invoiceId,
    paymentId,
    paymentPayload,
    devProof,
  );
  return jsonResponse(settlement.body, { status: settlement.status });
}

export async function handleInvoiceAutopayStart(
  request: Request,
  env: Env,
  invoiceId: string,
): Promise<Response> {
  const account = await requireAccountFromSession(request, env);

  const invoice = await env.DB.prepare(
    `SELECT id, amount_due, currency, status
     FROM meteria402_invoices
     WHERE id = ? AND account_id = ?`,
  )
    .bind(invoiceId, account.id)
    .first<{
      id: string;
      amount_due: number;
      currency: string;
      status: string;
    }>();

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

  const depositPayment = await payInvoiceFromExcessDeposit(
    env,
    account.id,
    invoice.id,
    invoice.amount_due,
    invoice.currency,
  );
  if (depositPayment.ok) {
    return jsonResponse({
      invoice_id: invoice.id,
      status: "settled",
      payment_method: "excess_deposit",
      amount: formatMoney(invoice.amount_due),
    });
  }

  const paymentId = makeId("pay");
  const minRechargeAmount = account.autopay_min_recharge_amount || 0;
  const rechargeNeededForDepositFloor =
    Math.max(0, account.min_deposit_required - account.deposit_balance) +
    invoice.amount_due;
  const paymentKind =
    minRechargeAmount > invoice.amount_due ||
    rechargeNeededForDepositFloor > invoice.amount_due
      ? "deposit"
      : "invoice";
  const paymentAmount =
    paymentKind === "deposit"
      ? Math.max(minRechargeAmount, rechargeNeededForDepositFloor)
      : invoice.amount_due;
  const requirement = createPaymentRequirement(request, env, {
    kind: paymentKind,
    id: paymentKind === "deposit" ? paymentId : invoice.id,
    amount: paymentAmount,
    description:
      paymentKind === "deposit"
        ? `Meteria402 recharge for invoice ${invoice.id}`
        : `Meteria402 invoice ${invoice.id}`,
  });
  const paymentCurrency = paymentCurrencyFromRequirement(requirement);

  await env.DB.prepare(
    `INSERT INTO meteria402_payments
     (id, account_id, invoice_id, kind, amount, currency, status, payment_requirement_json)
     VALUES (?, ?, ?, ?, ?, ?, 'pending', ?)`,
  )
    .bind(
      paymentId,
      account.id,
      invoice.id,
      paymentKind,
      paymentAmount,
      paymentCurrency,
      JSON.stringify(requirement),
    )
    .run();

  const start = await startAutopayForPayment(request, env, {
    id: paymentId,
    account_id: account.id,
    invoice_id: invoice.id,
    kind: paymentKind,
    amount: paymentAmount,
    status: "pending",
    payment_requirement_json: JSON.stringify(requirement),
  });
  if (start.status !== "approved") {
    return jsonResponse(start, { status: 201 });
  }
  const approvedStart = start as AutopayPaymentResult;

  const settlement =
    paymentKind === "deposit"
      ? await settleRechargePaymentForInvoice(
          env,
          account.id,
          invoice.id,
          paymentId,
          approvedStart.payment_payload,
          undefined,
          capabilityBudgetCharge(approvedStart),
          {
            autopayUrl: approvedStart.autopay_url,
            autopayRequestId: approvedStart.worker_autopay_request_id,
          },
        )
      : await settleInvoicePayment(
          env,
          account.id,
          invoice.id,
          paymentId,
          approvedStart.payment_payload,
          undefined,
          capabilityBudgetCharge(approvedStart),
          {
            autopayUrl: approvedStart.autopay_url,
            autopayRequestId: approvedStart.worker_autopay_request_id,
          },
        );
  return jsonResponse(
    {
      status: settlement.ok ? "settled" : "settle_failed",
      autopay_status: start.status,
      capability_used: start.capability_used === true,
      settlement: settlement.body,
    },
    { status: settlement.status },
  );
}

export async function handleInvoiceAutopayComplete(
  request: Request,
  env: Env,
  invoiceId: string,
): Promise<Response> {
  const account = await requireAccountFromSession(request, env);

  const body = await readJsonObject(request);
  const paymentId = requireString(body.payment_id, "payment_id");
  const payment = await env.DB.prepare(
    `SELECT id, kind
     FROM meteria402_payments
     WHERE id = ? AND invoice_id = ? AND account_id = ? AND kind IN ('invoice', 'deposit')`,
  )
    .bind(paymentId, invoiceId, account.id)
    .first<{ id: string; kind: string }>();
  if (!payment) {
    return errorResponse(
      404,
      "payment_not_found",
      "Payment quote was not found.",
    );
  }

  const result = await completeAutopayForPayment(env, request, paymentId);
  if (result.status !== "approved") return jsonResponse(result);
  const approvedResult = result as AutopayPaymentResult;

  if (payment.kind === "deposit") {
    const recharge = await settleRechargePaymentForInvoice(
      env,
      account.id,
      invoiceId,
      paymentId,
      approvedResult.payment_payload,
      undefined,
      capabilityBudgetCharge(approvedResult),
      {
        autopayUrl: approvedResult.autopay_url,
        autopayRequestId: approvedResult.worker_autopay_request_id,
      },
    );
    if (recharge.ok) {
      await markAutopaySettled(env, approvedResult.autopay_request_id);
    }
    return jsonResponse(
      {
        status: recharge.ok ? "settled" : "settle_failed",
        autopay_status: result.status,
        settlement: recharge.body,
      },
      { status: recharge.status },
    );
  }

  const invoiceSettlement = await settleInvoicePayment(
    env,
    account.id,
    invoiceId,
    paymentId,
    approvedResult.payment_payload,
    undefined,
    capabilityBudgetCharge(approvedResult),
    {
      autopayUrl: approvedResult.autopay_url,
      autopayRequestId: approvedResult.worker_autopay_request_id,
    },
  );
  if (invoiceSettlement.ok) {
    await markAutopaySettled(env, approvedResult.autopay_request_id);
  }
  return jsonResponse(
    {
      status: invoiceSettlement.ok ? "settled" : "settle_failed",
      autopay_status: result.status,
      settlement: invoiceSettlement.body,
    },
    { status: invoiceSettlement.status },
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
): Promise<AutopayPaymentResult | AutopayPendingResult> {
  // Try to use an existing autopay capability first
  if (payment.account_id) {
    const capabilityPayload = await tryAutopayWithCapability(
      env,
      payment.account_id,
      payment.id,
      payment.payment_requirement_json,
      payment.amount,
    );
    if (capabilityPayload) {
      return {
        payment_id: payment.id,
        invoice_id: payment.invoice_id,
        status: "approved",
        payment_payload: capabilityPayload.payment_payload,
        selected_requirement: capabilityPayload.headers,
        capability_used: true,
        capability_id: capabilityPayload.capability_id,
        capability_amount: capabilityPayload.capability_amount,
        autopay_url: capabilityPayload.autopay_url,
      };
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
      requester: requesterMetadata(env, request),
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
    throw new HttpError(
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

  return {
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
  };
}

export async function startAutopayForDepositQuote(
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
      requester: requesterMetadata(env, request),
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
  request: Request,
  paymentId: string,
): Promise<AutopayPaymentResult | AutopayPendingResult> {
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
  const payResponse = await callAutopayPay(
    env,
    request,
    `${record.autopay_url}/api/pay`,
    {
      siwe_message: authorization.siwe_message,
      siwe_signature: authorization.siwe_signature,
      paymentRequired,
      payment_id: paymentId,
    },
    authorization.capability,
  );
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
    worker_autopay_request_id: record.autopay_request_id,
    autopay_url: record.autopay_url,
    payment_payload: payBody.payment_payload,
    selected_requirement: payBody.selected_requirement,
  };
}

export async function completeAutopayForDepositQuote(
  env: Env,
  request: Request,
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

  const payResponse = await callAutopayPay(
    env,
    request,
    `${state.autopay_url}/api/pay`,
    {
      siwe_message: authorization.siwe_message,
      siwe_signature: authorization.siwe_signature,
      paymentRequired: quote.payment_requirement,
      payment_id: state.payment_id,
    },
    authorization.capability,
  );
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
    worker_autopay_request_id: state.autopay_request_id,
    autopay_url: state.autopay_url,
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

export async function reportAutopaySettlement(
  env: Env,
  input: SettlementReportInput,
): Promise<void> {
  if (!input.autopayUrl || !input.txHash) return;
  const url = `${normalizeAutopayUrl(input.autopayUrl)}/api/settlement-reports`;
  const bodyText = JSON.stringify({
    version: 1,
    autopay_request_id: input.autopayRequestId,
    payment_id: input.paymentId,
    invoice_id: input.invoiceId,
    status: input.status,
    amount: input.amount,
    tx_hash: input.txHash,
    settled_at: input.settledAt,
  });
  try {
    const headers = await signedSettlementReportHeaders(env, url, bodyText);
    const response = await fetch(url, {
      method: "POST",
      headers,
      body: bodyText,
    });
    if (!response.ok) {
      const text = await response.text().catch(() => "");
      console.warn("[autopay settlement report] failed", response.status, text.slice(0, 500));
    }
  } catch (error) {
    console.warn("[autopay settlement report] error", error);
  }
}

export async function fetchAutopayPayerAddress(
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

async function payInvoiceFromExcessDeposit(
  env: Env,
  accountId: string,
  invoiceId: string,
  amount: number,
  currency: string,
): Promise<{ ok: true } | { ok: false }> {
  const account = await getAccount(env, accountId);
  if (!account) return { ok: false };
  const excess = account.deposit_balance - account.min_deposit_required;
  if (excess < amount) return { ok: false };

  const now = new Date().toISOString();
  const result = await env.DB.prepare(
    `UPDATE meteria402_invoices
     SET status = 'paid', paid_at = ?
     WHERE id = ? AND account_id = ? AND status = 'unpaid'`,
  )
    .bind(now, invoiceId, accountId)
    .run();
  if (result.meta.changes === 0) return { ok: false };

  await env.DB.batch([
    env.DB.prepare(
      `UPDATE meteria402_accounts
       SET deposit_balance = deposit_balance - ?,
           unpaid_invoice_total = MAX(0, unpaid_invoice_total - ?),
           updated_at = ?
       WHERE id = ?`,
    ).bind(amount, amount, now, accountId),
    env.DB.prepare(
      `INSERT INTO meteria402_ledger_entries
       (id, account_id, type, amount, currency, related_invoice_id, created_at)
       VALUES (?, ?, 'invoice_paid', ?, ?, ?, ?)`,
    ).bind(makeId("led"), accountId, amount, currency, invoiceId, now),
  ]);

  return { ok: true };
}

async function claimPaymentForSettlement(
  env: Env,
  paymentId: string,
): Promise<{ ok: true } | { ok: false; status: string | null }> {
  const claimed = await env.DB.prepare(
    `UPDATE meteria402_payments
     SET status = 'settling'
     WHERE id = ? AND status = 'pending'`,
  )
    .bind(paymentId)
    .run();
  if (claimed.meta.changes > 0) return { ok: true };

  const current = await env.DB.prepare(
    `SELECT status FROM meteria402_payments WHERE id = ?`,
  )
    .bind(paymentId)
    .first<{ status: string }>();
  return { ok: false, status: current?.status ?? null };
}

function capabilityBudgetCharge(
  result: AutopayPaymentResult | AutopayPendingResult,
): CapabilityBudgetCharge | undefined {
  const candidate = result as Partial<AutopayPaymentResult>;
  if (
    candidate.capability_used === true &&
    typeof candidate.capability_id === "string" &&
    typeof candidate.capability_amount === "number"
  ) {
    return { id: candidate.capability_id, amount: candidate.capability_amount };
  }
  return undefined;
}

function deductCapabilityBudgetStatement(
  env: Env,
  charge: CapabilityBudgetCharge,
): D1PreparedStatement {
  return env.DB.prepare(
    `UPDATE meteria402_autopay_capabilities
     SET spent_amount = spent_amount + ?
     WHERE id = ?
       AND revoked_at IS NULL
       AND (spent_amount + ?) <= total_budget`,
  ).bind(charge.amount, charge.id, charge.amount);
}

async function settleInvoicePayment(
  env: Env,
  accountId: string,
  invoiceId: string,
  paymentId: string,
  paymentPayload: unknown,
  devProof?: string,
  capabilityCharge?: CapabilityBudgetCharge,
  settlementReport?: Pick<SettlementReportInput, "autopayUrl" | "autopayRequestId">,
): Promise<{ ok: boolean; status: number; body: Record<string, unknown> }> {
  const payment = await env.DB.prepare(
    `SELECT p.id, p.amount, p.currency, p.status, p.payment_requirement_json, i.status AS invoice_status
     FROM meteria402_payments p
     JOIN meteria402_invoices i ON i.id = p.invoice_id
     WHERE p.id = ? AND p.invoice_id = ? AND p.account_id = ? AND p.kind = 'invoice'`,
  )
    .bind(paymentId, invoiceId, accountId)
    .first<{
      id: string;
      amount: number;
      currency: string;
      status: string;
      payment_requirement_json: string;
      invoice_status: string;
    }>();
  if (!payment) {
    return {
      ok: false,
      status: 404,
      body: {
        error: "payment_not_found",
        message: "Payment quote was not found.",
      },
    };
  }
  if (payment.status === "settled" && payment.invoice_status === "paid") {
    return {
      ok: true,
      status: 200,
      body: {
        invoice_id: invoiceId,
        payment_id: paymentId,
        status: "paid",
        amount: formatMoney(payment.amount),
      },
    };
  }
  if (payment.invoice_status !== "unpaid") {
    return {
      ok: false,
      status: 409,
      body: {
        error: "invoice_not_payable",
        message: "Only unpaid invoices can be paid.",
      },
    };
  }

  const claim = await claimPaymentForSettlement(env, paymentId);
  if (!claim.ok) {
    return {
      ok: false,
      status: 409,
      body: {
        invoice_id: invoiceId,
        payment_id: paymentId,
        status: "payment_not_settleable",
        payment_status: claim.status,
      },
    };
  }

  const settlement = await verifyPayment(
    env,
    payment.payment_requirement_json,
    paymentPayload,
    devProof,
  );
  if (!settlement.ok) {
    await env.DB.prepare(
      `UPDATE meteria402_payments
       SET status = 'verification_failed', response_json = ?
       WHERE id = ? AND status = 'settling'`,
    )
      .bind(
        JSON.stringify(settlement.raw ?? { error: settlement.message }),
        paymentId,
      )
      .run();
    return {
      ok: false,
      status: 402,
      body: {
        invoice_id: invoiceId,
        payment_id: paymentId,
        status: "payment_required",
        error: settlement.message,
        ...settlementErrorExtra(settlement),
      },
    };
  }

  const now = new Date().toISOString();
  const payloadHash = await sha256Hex(
    JSON.stringify(
      paymentPayload ?? { dev_proof: devProof, payment_id: paymentId },
    ),
  );
  const batch: D1PreparedStatement[] = [
    env.DB.prepare(
      `UPDATE meteria402_payments
       SET status = 'settled', x402_payload_hash = ?, tx_hash = ?, response_json = ?, settled_at = ?
       WHERE id = ? AND status = 'settling'`,
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
    ).bind(now, invoiceId, accountId),
    env.DB.prepare(
      `UPDATE meteria402_accounts
       SET unpaid_invoice_total = MAX(0, unpaid_invoice_total - ?), updated_at = ?
       WHERE id = ?`,
    ).bind(payment.amount, now, accountId),
    env.DB.prepare(
      `INSERT INTO meteria402_ledger_entries
       (id, account_id, type, amount, currency, related_invoice_id, related_payment_id, created_at)
       VALUES (?, ?, 'invoice_paid', ?, ?, ?, ?, ?)`,
    ).bind(
      makeId("led"),
      accountId,
      payment.amount,
      payment.currency,
      invoiceId,
      paymentId,
      now,
    ),
  ];
  if (capabilityCharge) {
    batch.push(deductCapabilityBudgetStatement(env, capabilityCharge));
  }
  await env.DB.batch(batch);
  await reportAutopaySettlement(env, {
    autopayUrl: settlementReport?.autopayUrl,
    autopayRequestId: settlementReport?.autopayRequestId,
    paymentId,
    invoiceId,
    status: "settled",
    amount: formatMoney(payment.amount),
    txHash: settlement.txHash,
    settledAt: now,
  });

  return {
    ok: true,
    status: 200,
    body: {
      invoice_id: invoiceId,
      payment_id: paymentId,
      status: "paid",
      amount: formatMoney(payment.amount),
      tx_hash: settlement.txHash ?? null,
    },
  };
}

async function settleRechargePaymentForInvoice(
  env: Env,
  accountId: string,
  invoiceId: string,
  paymentId: string,
  paymentPayload: unknown,
  devProof?: string,
  capabilityCharge?: CapabilityBudgetCharge,
  settlementReport?: Pick<SettlementReportInput, "autopayUrl" | "autopayRequestId">,
): Promise<{ ok: boolean; status: number; body: Record<string, unknown> }> {
  const payment = await env.DB.prepare(
    `SELECT id, amount, currency, status, payment_requirement_json
     FROM meteria402_payments
     WHERE id = ? AND account_id = ? AND invoice_id = ? AND kind = 'deposit'`,
  )
    .bind(paymentId, accountId, invoiceId)
    .first<{
      id: string;
      amount: number;
      currency: string;
      status: string;
      payment_requirement_json: string;
    }>();
  if (!payment) {
    return {
      ok: false,
      status: 404,
      body: {
        error: "payment_not_found",
        message: "Recharge payment was not found.",
      },
    };
  }
  if (payment.status === "settled") {
    const invoice = await env.DB.prepare(
      `SELECT amount_due, currency, status FROM meteria402_invoices WHERE id = ? AND account_id = ?`,
    )
      .bind(invoiceId, accountId)
      .first<{ amount_due: number; currency: string; status: string }>();
    if (invoice?.status === "paid") {
      return {
        ok: true,
        status: 200,
        body: {
          invoice_id: invoiceId,
          payment_id: paymentId,
          status: "paid",
        },
      };
    }
    const paid = invoice
      ? await payInvoiceFromExcessDeposit(
          env,
          accountId,
          invoiceId,
          invoice.amount_due,
          invoice.currency,
        )
      : { ok: false };
    return {
      ok: paid.ok,
      status: paid.ok ? 200 : 409,
      body: {
        invoice_id: invoiceId,
        payment_id: paymentId,
        status: paid.ok ? "paid" : "unpaid",
      },
    };
  }
  const claim = await claimPaymentForSettlement(env, paymentId);
  if (!claim.ok) {
    return {
      ok: false,
      status: 409,
      body: {
        invoice_id: invoiceId,
        payment_id: paymentId,
        status: "payment_not_settleable",
        payment_status: claim.status,
      },
    };
  }

  const settlement = await verifyPayment(
    env,
    payment.payment_requirement_json,
    paymentPayload,
    devProof,
  );
  if (!settlement.ok) {
    await env.DB.prepare(
      `UPDATE meteria402_payments
       SET status = 'verification_failed', response_json = ?
       WHERE id = ? AND status = 'settling'`,
    )
      .bind(
        JSON.stringify(settlement.raw ?? { error: settlement.message }),
        paymentId,
      )
      .run();
    return {
      ok: false,
      status: 402,
      body: {
        invoice_id: invoiceId,
        payment_id: paymentId,
        status: "payment_required",
        error: settlement.message,
        ...settlementErrorExtra(settlement),
      },
    };
  }

  const now = new Date().toISOString();
  const payloadHash = await sha256Hex(
    JSON.stringify(
      paymentPayload ?? { dev_proof: devProof, payment_id: paymentId },
    ),
  );
  const batch: D1PreparedStatement[] = [
    env.DB.prepare(
      `UPDATE meteria402_payments
       SET status = 'settled', x402_payload_hash = ?, tx_hash = ?, response_json = ?, settled_at = ?
       WHERE id = ? AND status = 'settling'`,
    ).bind(
      payloadHash,
      settlement.txHash ?? null,
      JSON.stringify(settlement.raw ?? {}),
      now,
      paymentId,
    ),
    env.DB.prepare(
      `UPDATE meteria402_accounts
       SET deposit_balance = deposit_balance + ?, updated_at = ?
       WHERE id = ?`,
    ).bind(payment.amount, now, accountId),
    env.DB.prepare(
      `INSERT INTO meteria402_ledger_entries
       (id, account_id, type, amount, currency, related_invoice_id, related_payment_id, created_at)
       VALUES (?, ?, 'deposit_paid', ?, ?, ?, ?, ?)`,
    ).bind(
      makeId("led"),
      accountId,
      payment.amount,
      payment.currency,
      invoiceId,
      paymentId,
      now,
    ),
  ];
  if (capabilityCharge) {
    batch.push(deductCapabilityBudgetStatement(env, capabilityCharge));
  }
  await env.DB.batch(batch);
  await reportAutopaySettlement(env, {
    autopayUrl: settlementReport?.autopayUrl,
    autopayRequestId: settlementReport?.autopayRequestId,
    paymentId,
    invoiceId,
    status: "settled",
    amount: formatMoney(payment.amount),
    txHash: settlement.txHash,
    settledAt: now,
  });

  const invoice = await env.DB.prepare(
    `SELECT amount_due, currency FROM meteria402_invoices WHERE id = ? AND account_id = ?`,
  )
    .bind(invoiceId, accountId)
    .first<{ amount_due: number; currency: string }>();
  if (!invoice) {
    return {
      ok: false,
      status: 404,
      body: {
        invoice_id: invoiceId,
        payment_id: paymentId,
        status: "invoice_not_found",
      },
    };
  }

  const paid = await payInvoiceFromExcessDeposit(
    env,
    accountId,
    invoiceId,
    invoice.amount_due,
    invoice.currency,
  );
  return {
    ok: paid.ok,
    status: paid.ok ? 200 : 409,
    body: {
      invoice_id: invoiceId,
      payment_id: paymentId,
      status: paid.ok ? "paid" : "unpaid",
      recharge_amount: formatMoney(payment.amount),
      amount: formatMoney(invoice.amount_due),
      tx_hash: settlement.txHash ?? null,
    },
  };
}

export async function handleRefundRequest(
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
  const activeRequestCount = await accountGateActiveCount(env, account.id);
  if (activeRequestCount > 0) {
    return errorResponse(
      409,
      "requests_running",
      "Refund cannot be requested while requests are running.",
      { active_request_count: activeRequestCount },
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

export async function handleListAutopayCapabilities(
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

export async function handleCreateAutopayCapability(
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
      requester: requesterMetadata(env, request),
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

export async function handleRevokeAutopayCapability(
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

export async function handleCompleteAutopayCapability(
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

async function callAutopayPay(
  env: Env,
  request: Request | null,
  url: string,
  body: Record<string, unknown>,
  capability: unknown,
): Promise<Response> {
  const bodyText = JSON.stringify(body);
  const headers = new Headers(JSON_HEADERS);
  const proofHeaders = await signedAutopayHeaders(
    env,
    request,
    url,
    bodyText,
    await hashAutopayCapability(capability),
  );
  proofHeaders.forEach((value, key) => headers.set(key, value));
  return fetch(url, {
    method: "POST",
    headers,
    body: bodyText,
  });
}

async function tryAutopayWithCapability(
  env: Env,
  accountId: string,
  paymentId: string,
  paymentRequirementJson: string,
  amount: number,
): Promise<{
  payment_payload: unknown;
  headers: Record<string, string>;
  capability_id: string;
  capability_amount: number;
  autopay_url?: string;
} | null> {
  const capability = await getActiveAutopayCapability(env, accountId, amount);
  if (!capability) return null;

  try {
    const parsedCapability = JSON.parse(capability.capability_json);
    const response = await callAutopayPay(
      env,
      null,
      `${capability.autopay_url}/api/pay`,
      {
        paymentRequired: JSON.parse(paymentRequirementJson),
        payment_id: paymentId,
        siweMessage: capability.siwe_message,
        siweSignature: capability.siwe_signature,
      },
      parsedCapability,
    );

    const body = (await response.json().catch(() => null)) as Record<
      string,
      unknown
    > | null;
    if (!response.ok || !body || !body.payment_payload) {
      console.warn("Capability pay failed", { status: response.status, body });
      return null;
    }

    return {
      payment_payload: body.payment_payload,
      headers: (body.headers as Record<string, string>) || {},
      capability_id: capability.id,
      capability_amount: amount,
      autopay_url: capability.autopay_url,
    };
  } catch (error) {
    console.warn("Capability pay error", error);
    return null;
  }
}

export async function tryAutoPayInvoice(
  env: Env,
  accountId: string,
  amount: number,
  _requirement: PaymentRequirement,
): Promise<{ ok: true; method: string } | { ok: false }> {
  const account = await getAccount(env, accountId);
  if (!account) return { ok: false };

  // 1. 尝试用 excess deposit 支付（deposit_balance - min_deposit_required）
  const excess = account.deposit_balance - account.min_deposit_required;
  if (excess >= amount) {
    return { ok: true, method: "excess_deposit" };
  }

  return { ok: false };
}

export async function tryAutopayRecharge(
  env: Env,
  accountId: string,
  invoiceAmount: number,
): Promise<{ ok: true; rechargeAmount: number } | { ok: false }> {
  const account = await getAccount(env, accountId);
  if (
    !account ||
    !account.autopay_min_recharge_amount ||
    account.autopay_min_recharge_amount <= 0
  ) {
    return { ok: false };
  }

  const rechargeAmount = Math.max(
    invoiceAmount,
    account.autopay_min_recharge_amount,
  );

  const paymentId = makeId("pay");
  const requirement = createPaymentRequirementFromValues(env, {
    resource: `/api/payments/${paymentId}`,
    kind: "deposit",
    id: paymentId,
    amount: rechargeAmount,
    description: "Auto-recharge for API usage",
  });

  const paymentCurrency = paymentCurrencyFromRequirement(requirement);
  const capResult = await tryAutopayWithCapability(
    env,
    accountId,
    paymentId,
    JSON.stringify(requirement),
    rechargeAmount,
  );
  if (!capResult) {
    return { ok: false };
  }

  const paymentRequirementJson = JSON.stringify(requirement);
  const settlement = await verifyPayment(
    env,
    paymentRequirementJson,
    capResult.payment_payload,
  );
  if (!settlement.ok) {
    console.warn("[auto-recharge] settlement failed", settlement.message);
    return { ok: false };
  }

  const now = new Date().toISOString();
  const payloadHash = await sha256Hex(
    JSON.stringify(capResult.payment_payload),
  );

  const existingPayload = await env.DB.prepare(
    `SELECT id FROM meteria402_payments WHERE x402_payload_hash = ?`,
  )
    .bind(payloadHash)
    .first<{ id: string }>();
  if (existingPayload) {
    console.warn("[auto-recharge] payload already used");
    return { ok: false };
  }

  await env.DB.batch([
    env.DB.prepare(
      `UPDATE meteria402_accounts
       SET deposit_balance = deposit_balance + ?, updated_at = ?
       WHERE id = ?`,
    ).bind(rechargeAmount, now, accountId),
    deductCapabilityBudgetStatement(env, {
      id: capResult.capability_id,
      amount: capResult.capability_amount,
    }),
    env.DB.prepare(
      `INSERT INTO meteria402_payments (id, account_id, kind, amount, currency, status, x402_payload_hash, tx_hash, payment_requirement_json, response_json, created_at, settled_at)
       VALUES (?, ?, 'deposit', ?, ?, 'settled', ?, ?, ?, ?, ?, ?)`,
    ).bind(
      paymentId,
      accountId,
      rechargeAmount,
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
      accountId,
      rechargeAmount,
      paymentCurrency,
      paymentId,
      now,
    ),
  ]);
  await reportAutopaySettlement(env, {
    autopayUrl: capResult.autopay_url,
    paymentId,
    status: "settled",
    amount: formatMoney(rechargeAmount),
    txHash: settlement.txHash,
    settledAt: now,
  });

  return { ok: true, rechargeAmount };
}
