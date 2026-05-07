import {
authenticate,
getAccount
} from "./accounts";
import {
buildAiGatewayRequest,
extractUsageFromSseBuffer,
extractUsageFromText,
fetchAiGatewayLogByEventId,
fetchAiGatewayLogCost,
getAiGatewayLogId,
} from "./ai-gateway";
import {
  CORS_HEADERS,
  JSON_HEADERS,
} from "./constants";
import { makeId } from "./crypto";
import {
cloneHeaders,
copyResponse,
errorResponse,
jsonResponse,
paymentRequiredResponse,
readJsonObject
} from "./http";
import {
formatMoney
} from "./money";
import {
extractCloudflareAiImage,
openAiImageDataItem,
readOpenAiImageRequest,
} from "./openai-images";
import type {
ChatBody,
Env,
Usage
} from "./types";
import {
createPaymentRequirementFromValues,
paymentCurrencyFromRequirement
} from "./x402";

import { tryAutoPayInvoice,tryAutopayRecharge } from "./billing-autopay-handlers";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
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

export async function handleV1Request(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
  provider: string,
  endpoint: string,
): Promise<Response> {
  if (request.method === "GET") {
    return handleModelsRequest(request, env, provider, endpoint);
  }

  if (
    env.AI &&
    provider === "openai" &&
    (endpoint === "images/generations" || endpoint === "images/edits")
  ) {
    return handleOpenAiImageRequest(request, env, ctx, endpoint);
  }

  if (endpoint === "chat/completions") {
    return handleChatCompletions(request, env, ctx, provider);
  }
  return handleGenericV1Endpoint(request, env, ctx, provider, endpoint);
}

async function handleOpenAiImageRequest(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
  endpoint: string,
): Promise<Response> {
  const account = await authenticate(request, env);
  if (account instanceof Response) return account;

  const parsed = await readOpenAiImageRequest(request, endpoint);
  if (parsed instanceof Response) return parsed;

  const requestId = makeId("req");
  const started = await startMeteredRequest(
    env,
    account.id,
    account.api_key_id,
    requestId,
    parsed.model,
    false,
  );
  if (started instanceof Response) return started;

  let aiResponse: unknown;
  let aiGatewayLogId: string | null = null;
  try {
    aiResponse = await env.AI!.run(parsed.model, parsed.input, {
      gateway: {
        id: env.AI_GATEWAY_ID || "default",
        collectLog: true,
        eventId: requestId,
        metadata: { request_id: requestId },
      },
    });
    aiGatewayLogId = env.AI!.aiGatewayLogId || null;
  } catch (error) {
    await failMeteredRequest(
      env,
      account.id,
      requestId,
      "upstream_ai_binding_failed",
    );
    console.error("Cloudflare AI image request failed", error);
    return errorResponse(
      502,
      "upstream_ai_binding_failed",
      "The upstream image request failed.",
    );
  }

  const image = extractCloudflareAiImage(aiResponse);
  if (!image) {
    await failMeteredRequest(
      env,
      account.id,
      requestId,
      "invalid_image_response",
    );
    return errorResponse(
      502,
      "invalid_image_response",
      "Cloudflare AI image response could not be parsed.",
    );
  }

  const headers = new Headers({
    ...JSON_HEADERS,
    ...CORS_HEADERS,
  });
  headers.set("meteria402-request-id", requestId);
  if (aiGatewayLogId) {
    headers.set("cf-aig-log-id", aiGatewayLogId);
  } else {
    console.warn("Cloudflare AI Gateway log id missing after image request", {
      requestId,
      model: parsed.model,
    });
  }
  headers.set("meteria402-reconcile", "pending");

  await deferMeteredRequestForGatewayReconcile(
    env,
    account.id,
    requestId,
    parsed.model,
    null,
    headers,
  );
  ctx.waitUntil(reconcileGatewayLogAfterDelay(env, requestId));

  const item = await openAiImageDataItem(image);
  if (!item) {
    await failMeteredRequest(
      env,
      account.id,
      requestId,
      "image_conversion_failed",
    );
    return errorResponse(
      502,
      "image_conversion_failed",
      "Cloudflare AI image response could not be converted to the requested format.",
    );
  }

  return new Response(
    JSON.stringify({
      created: Math.floor(Date.now() / 1000),
      data: [item],
    }),
    { headers },
  );
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

export async function reconcilePendingGatewayLogs(
  env: Env,
  accountId?: string,
): Promise<{ checked: number; settled: number; pending: number; skipped: number }> {
  const rows = accountId
    ? await env.DB.prepare(
        `SELECT id
         FROM meteria402_requests
         WHERE account_id = ?
           AND status = 'pending_reconcile'
         ORDER BY completed_at ASC
         LIMIT 50`,
      )
        .bind(accountId)
        .all<{ id: string }>()
    : await env.DB.prepare(
        `SELECT id
         FROM meteria402_requests
         WHERE status = 'pending_reconcile'
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
     RETURNING id, account_id, model, ai_gateway_log_id, input_tokens, output_tokens, total_tokens`,
  )
    .bind(requestId)
    .first<{
      id: string;
      account_id: string;
      model: string | null;
      ai_gateway_log_id: string | null;
      input_tokens: number | null;
      output_tokens: number | null;
      total_tokens: number | null;
    }>();

  if (!request) return { status: "skipped" };

  try {
    const log = request.ai_gateway_log_id
      ? await fetchAiGatewayLogCost(env, request.ai_gateway_log_id)
      : await fetchAiGatewayLogByEventId(env, request.id);
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
      new Headers({ "cf-aig-log-id": request.ai_gateway_log_id ?? log.id }),
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
  const paymentCurrency = paymentCurrencyFromRequirement(requirement);

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
  let rechargeResult:
    | { ok: true; rechargeAmount: number }
    | { ok: false }
    | undefined = undefined;

  if (autoPay.ok) {
    // 自动支付成功：invoice 直接 paid
    const ledgerId = makeId("led");
    const batch: D1PreparedStatement[] = [
      env.DB.prepare(
        `INSERT INTO meteria402_invoices
         (id, account_id, request_id, status, amount_due, currency, payment_requirement_json, created_at, paid_at)
         VALUES (?, ?, ?, 'paid', ?, ?, ?, ?, ?)`,
      ).bind(
        invoiceId,
        accountId,
        requestId,
        cost,
        paymentCurrency,
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
         VALUES (?, ?, 'invoice_paid', ?, ?, ?, ?, ?)`,
      ).bind(
        ledgerId,
        accountId,
        cost,
        paymentCurrency,
        requestId,
        invoiceId,
        now,
      ),
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
    // 尝试自动充值
    rechargeResult = await tryAutopayRecharge(env, accountId, cost);
    if (rechargeResult.ok) {
      // 充值成功，用 excess deposit 支付 invoice
      const ledgerId = makeId("led");
      await env.DB.batch([
        env.DB.prepare(
          `INSERT INTO meteria402_invoices
           (id, account_id, request_id, status, amount_due, currency, payment_requirement_json, created_at, paid_at)
           VALUES (?, ?, ?, 'paid', ?, ?, ?, ?, ?)`,
        ).bind(
          invoiceId,
          accountId,
          requestId,
          cost,
          paymentCurrency,
          JSON.stringify(requirement),
          now,
          now,
        ),
        env.DB.prepare(
          `UPDATE meteria402_accounts
           SET active_request_count = MAX(0, active_request_count - 1),
               deposit_balance = deposit_balance - ?,
               updated_at = ?
           WHERE id = ?`,
        ).bind(cost, now, accountId),
        env.DB.prepare(
          `INSERT INTO meteria402_ledger_entries
           (id, account_id, type, amount, currency, related_request_id, related_invoice_id, created_at)
           VALUES (?, ?, 'invoice_paid', ?, ?, ?, ?, ?)`,
        ).bind(
          ledgerId,
          accountId,
          cost,
          paymentCurrency,
          requestId,
          invoiceId,
          now,
        ),
      ]);
    } else {
      // 挂账
      await env.DB.batch([
        env.DB.prepare(
          `INSERT INTO meteria402_invoices
           (id, account_id, request_id, status, amount_due, currency, payment_requirement_json, created_at)
           VALUES (?, ?, ?, 'unpaid', ?, ?, ?, ?)`,
        ).bind(
          invoiceId,
          accountId,
          requestId,
          cost,
          paymentCurrency,
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
           VALUES (?, ?, 'invoice_created', ?, ?, ?, ?, ?)`,
        ).bind(
          makeId("led"),
          accountId,
          cost,
          paymentCurrency,
          requestId,
          invoiceId,
          now,
        ),
      ]);
    }
  }

  return {
    invoiceId,
    autoPaid: autoPay.ok || (rechargeResult?.ok ?? false),
    autoPayMethod: autoPay.ok
      ? autoPay.method
      : rechargeResult?.ok
        ? "autopay_recharge"
        : undefined,
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
