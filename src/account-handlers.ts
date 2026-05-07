import {
requireAccountFromSession
} from "./accounts";
import {
createApiKey,
keyStatus,
normalizeApiKeyExpiresAt,
normalizeApiKeyName
} from "./api-keys";
import { sha256Hex } from "./crypto";
import {
errorResponse,
jsonResponse,
readJsonObject,
readOptionalJsonObject
} from "./http";
import {
formatMoney,
parseMoney
} from "./money";
import type {
Env
} from "./types";

import { reconcilePendingGatewayLogs } from "./v1-handlers";

export async function handleGetAccount(request: Request, env: Env): Promise<Response> {
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
    autopay_min_recharge_amount: formatMoney(account.autopay_min_recharge_amount),
  });
}

export async function handleUpdateAccount(request: Request, env: Env): Promise<Response> {
  const account = await requireAccountFromSession(request, env);
  const body = await readJsonObject(request);
  const newAmount = parseMoney(
    String(body.autopay_min_recharge_amount ?? body.autopayMinRechargeAmount ?? "0"),
  );
  if (newAmount < 0) {
    return errorResponse(
      400,
      "invalid_amount",
      "autopay_min_recharge_amount must be a non-negative decimal.",
    );
  }

  const now = new Date().toISOString();
  await env.DB.prepare(
    `UPDATE meteria402_accounts SET autopay_min_recharge_amount = ?, updated_at = ? WHERE id = ?`,
  )
    .bind(newAmount, now, account.id)
    .run();

  return jsonResponse({
    account_id: account.id,
    autopay_min_recharge_amount: formatMoney(newAmount),
    updated_at: now,
  });
}

export async function handleListApiKeys(
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

export async function handleCreateApiKey(
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

export async function handleRevokeApiKey(
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

export async function handleListInvoices(
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

export async function handleListDeposits(
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

export async function handleListRequests(
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

export async function handleReconcileRequests(
  request: Request,
  env: Env,
): Promise<Response> {
  const account = await requireAccountFromSession(request, env);
  const result = await reconcilePendingGatewayLogs(env, account.id);
  return jsonResponse(result);
}
