import { requireAccountFromSession } from "./accounts";
import {
  createApiKey,
  keyStatus,
  normalizeApiKeyExpiresAt,
  normalizeApiKeyName,
  normalizeApiKeySpendLimit,
} from "./api-keys";
import { verifyMessage, type Hex } from "viem";
import { base64UrlRandom, sha256Hex } from "./crypto";
import {
  errorResponse,
  HttpError,
  jsonResponse,
  readJsonObject,
  readOptionalJsonObject,
} from "./http";
import { parsePositiveInt } from "./money";
import { serializeExpiredSessionCookie } from "./session";
import {
  signOwnerRebindChallengeState,
  verifyOwnerRebindChallengeState,
} from "./signed-state";
import type { Env, OwnerRebindChallengeState } from "./types";
import { normalizeEvmAddress } from "./x402";

import { reconcilePendingGatewayLogs } from "./v1-handlers";

const OWNER_REBIND_TTL_SECONDS = 5 * 60;
const OWNER_REBIND_STATEMENT = "Confirm Meteria402 main wallet rebinding.";
const OWNER_REBIND_RESOURCE_PREFIX = "urn:meteria402:owner-rebind:";
const REQUESTS_PAGE_SIZE = 25;

type RequestCursor = {
  startedAt: string;
  id: string;
};

type RequestRow = {
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
};

export async function handleGetAccount(
  request: Request,
  env: Env,
): Promise<Response> {
  const account = await requireAccountFromSession(request, env);

  return jsonResponse({
    account_id: account.id,
    status: account.status,
    autopay_url: account.autopay_url || "",
    deposit_balance: account.deposit_balance,
    unpaid_invoice_total: account.unpaid_invoice_total,
    concurrency_limit: account.concurrency_limit,
    min_deposit_required: account.min_deposit_required,
    autopay_min_recharge_amount: account.autopay_min_recharge_amount,
  });
}

export async function handleUpdateAccount(
  request: Request,
  env: Env,
): Promise<Response> {
  const account = await requireAccountFromSession(request, env);
  const body = await readJsonObject(request);
  const newAmount = parseInt(
    String(
      body.autopay_min_recharge_amount ?? body.autopayMinRechargeAmount ?? "0",
    ),
    10,
  );
  if (newAmount < 10_000) {
    return errorResponse(
      400,
      "invalid_amount",
      "autopay_min_recharge_amount must be at least 0.01 USDC.",
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
    autopay_min_recharge_amount: newAmount,
    updated_at: now,
  });
}

export async function handleCreateOwnerRebindChallenge(
  request: Request,
  env: Env,
): Promise<Response> {
  const account = await requireAccountFromSession(request, env);
  if (!account.owner_address) {
    return errorResponse(
      409,
      "missing_owner",
      "Account does not have an owner wallet.",
    );
  }
  if (account.status !== "active") {
    return errorResponse(
      409,
      "account_not_active",
      "Only active accounts can rebind the main wallet.",
    );
  }

  const body = await readJsonObject(request);
  const newOwner = normalizeEvmAddress(body.new_owner ?? body.newOwner);
  const oldOwner = normalizeEvmAddress(account.owner_address);
  if (newOwner.toLowerCase() === oldOwner.toLowerCase()) {
    return errorResponse(
      400,
      "same_owner",
      "New owner wallet must be different from the current owner.",
    );
  }

  const existing = await env.DB.prepare(
    `SELECT id FROM meteria402_accounts WHERE lower(owner_address) = lower(?) LIMIT 1`,
  )
    .bind(newOwner)
    .first<{ id: string }>();
  if (existing && existing.id !== account.id) {
    return errorResponse(
      409,
      "owner_already_bound",
      "This wallet is already bound to another account.",
    );
  }

  const origin = requestOrigin(request);
  const originUrl = new URL(origin);
  const issuedAt = new Date().toISOString();
  const expiresAt = Date.now() + OWNER_REBIND_TTL_SECONDS * 1000;
  const state: OwnerRebindChallengeState = {
    account_id: account.id,
    old_owner: oldOwner,
    new_owner: newOwner,
    nonce: base64UrlRandom(12),
    domain: originUrl.host,
    uri: originUrl.origin,
    chain_id: chainIdFromEnv(env),
    issued_at: issuedAt,
    expires_at: expiresAt,
  };
  return jsonResponse(
    {
      challenge_token: await signOwnerRebindChallengeState(env, state),
      message: buildOwnerRebindMessage(state),
      old_owner: state.old_owner,
      new_owner: state.new_owner,
      expires_at: new Date(expiresAt).toISOString(),
    },
    { status: 201 },
  );
}

export async function handleCompleteOwnerRebind(
  request: Request,
  env: Env,
): Promise<Response> {
  const account = await requireAccountFromSession(request, env);
  const body = await readJsonObject(request);
  const challengeToken = requireBodyString(
    body.challenge_token ?? body.challengeToken,
    "challenge_token",
  );
  const message = requireBodyString(body.message, "message");
  const signature = requireBodyString(body.signature, "signature") as Hex;
  const state = await verifyOwnerRebindChallengeState(env, challengeToken);
  const currentOwner = normalizeEvmAddress(account.owner_address);

  if (state.account_id !== account.id) {
    throw new HttpError(
      403,
      "owner_rebind_account_mismatch",
      "Owner rebind challenge is not bound to this account.",
    );
  }
  if (
    normalizeEvmAddress(state.old_owner).toLowerCase() !==
    currentOwner.toLowerCase()
  ) {
    throw new HttpError(
      403,
      "owner_rebind_old_owner_mismatch",
      "Owner rebind challenge does not match the current owner.",
    );
  }
  if (message !== buildOwnerRebindMessage(state)) {
    throw new HttpError(
      403,
      "owner_rebind_message_mismatch",
      "Owner rebind message does not match the challenge.",
    );
  }

  const valid = await verifyMessage({
    address: normalizeEvmAddress(state.old_owner) as `0x${string}`,
    message,
    signature,
  });
  if (!valid) {
    throw new HttpError(
      403,
      "invalid_signature",
      "Owner rebind signature is invalid.",
    );
  }

  const existing = await env.DB.prepare(
    `SELECT id FROM meteria402_accounts WHERE lower(owner_address) = lower(?) LIMIT 1`,
  )
    .bind(state.new_owner)
    .first<{ id: string }>();
  if (existing && existing.id !== account.id) {
    return errorResponse(
      409,
      "owner_already_bound",
      "This wallet is already bound to another account.",
    );
  }

  const now = new Date().toISOString();
  const [ownerUpdate] = await env.DB.batch([
    env.DB.prepare(
      `UPDATE meteria402_accounts
       SET owner_address = ?, updated_at = ?
       WHERE id = ? AND lower(owner_address) = lower(?)`,
    ).bind(
      normalizeEvmAddress(state.new_owner),
      now,
      account.id,
      state.old_owner,
    ),
    env.DB.prepare(
      `UPDATE meteria402_autopay_capabilities
       SET revoked_at = COALESCE(revoked_at, ?)
       WHERE account_id = ? AND revoked_at IS NULL`,
    ).bind(now, account.id),
  ]);
  if (ownerUpdate.meta.changes === 0) {
    throw new HttpError(
      409,
      "owner_rebind_conflict",
      "Account owner changed before the rebind completed.",
    );
  }

  return jsonResponse(
    {
      account_id: account.id,
      old_owner: state.old_owner,
      new_owner: state.new_owner,
      status: "owner_rebound",
      revoked_autopay_capabilities: true,
      requires_login: true,
    },
    {
      headers: {
        "set-cookie": serializeExpiredSessionCookie(request),
      },
    },
  );
}

export async function handleListApiKeys(
  request: Request,
  env: Env,
): Promise<Response> {
  const account = await requireAccountFromSession(request, env);

  const rows = await env.DB.prepare(
    `SELECT id, key_prefix, key_suffix, name, expires_at, spend_limit, spent_amount, created_at, revoked_at
     FROM meteria402_api_keys
     WHERE account_id = ? AND deleted_at IS NULL
     ORDER BY created_at DESC`,
  )
    .bind(account.id)
    .all<{
      id: string;
      key_prefix: string;
      key_suffix: string;
      name: string | null;
      expires_at: string | null;
      spend_limit: number | null;
      spent_amount: number;
      created_at: string;
      revoked_at: string | null;
    }>();

  return jsonResponse({
    api_keys: (rows.results || []).map((row) => ({
      id: row.id,
      name: row.name || "Unnamed key",
      prefix: row.key_prefix,
      key_suffix: row.key_suffix,
      status: keyStatus(row.revoked_at, row.expires_at, row.spend_limit, row.spent_amount),
      expires_at: row.expires_at,
      spend_limit: row.spend_limit,
      spent_amount: row.spent_amount,
      created_at: row.created_at,
      revoked_at: row.revoked_at,
      total_cost: row.spent_amount,
    })),
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
  const spendLimit = normalizeApiKeySpendLimit(body.spend_limit ?? body.spendLimit);
  const apiKey = await createApiKey();
  const apiKeyHash = await sha256Hex(apiKey.secret);
  const now = new Date().toISOString();

  await env.DB.prepare(
    `INSERT INTO meteria402_api_keys
       (id, account_id, key_hash, key_prefix, key_suffix, name, expires_at, spend_limit, spent_amount, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?)`,
  )
    .bind(
      apiKey.id,
      account.id,
      apiKeyHash,
      apiKey.prefix,
      apiKey.keySuffix,
      name,
      expiresAt,
      spendLimit,
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
      spend_limit: spendLimit,
      spent_amount: 0,
      created_at: now,
      message: "Store this API key now. It cannot be shown again.",
    },
    { status: 201 },
  );
}

export async function handleDisableApiKey(
  request: Request,
  env: Env,
  apiKeyId: string,
): Promise<Response> {
  const account = await requireAccountFromSession(request, env);

  const now = new Date().toISOString();
  const result = await env.DB.prepare(
    `UPDATE meteria402_api_keys
     SET revoked_at = COALESCE(revoked_at, ?)
     WHERE id = ? AND account_id = ? AND deleted_at IS NULL`,
  )
    .bind(now, apiKeyId, account.id)
    .run();

  if (result.meta.changes === 0) {
    return errorResponse(404, "api_key_not_found", "API key was not found.");
  }

  return jsonResponse({
    api_key_id: apiKeyId,
    status: "disabled",
    revoked_at: now,
  });
}

export async function handleEnableApiKey(
  request: Request,
  env: Env,
  apiKeyId: string,
): Promise<Response> {
  const account = await requireAccountFromSession(request, env);

  const result = await env.DB.prepare(
    `UPDATE meteria402_api_keys
     SET revoked_at = NULL
     WHERE id = ? AND account_id = ? AND deleted_at IS NULL`,
  )
    .bind(apiKeyId, account.id)
    .run();

  if (result.meta.changes === 0) {
    return errorResponse(404, "api_key_not_found", "API key was not found.");
  }

  const row = await env.DB.prepare(
    `SELECT expires_at, spend_limit, spent_amount
     FROM meteria402_api_keys
     WHERE id = ? AND account_id = ? AND deleted_at IS NULL`,
  )
    .bind(apiKeyId, account.id)
    .first<{
      expires_at: string | null;
      spend_limit: number | null;
      spent_amount: number;
    }>();

  return jsonResponse({
    api_key_id: apiKeyId,
    status: row
      ? keyStatus(null, row.expires_at, row.spend_limit, row.spent_amount)
      : "active",
    revoked_at: null,
  });
}

export async function handleDeleteApiKey(
  request: Request,
  env: Env,
  apiKeyId: string,
): Promise<Response> {
  const account = await requireAccountFromSession(request, env);

  const now = new Date().toISOString();
  const result = await env.DB.prepare(
    `UPDATE meteria402_api_keys
     SET deleted_at = COALESCE(deleted_at, ?),
         revoked_at = COALESCE(revoked_at, ?)
     WHERE id = ? AND account_id = ?`,
  )
    .bind(now, now, apiKeyId, account.id)
    .run();

  if (result.meta.changes === 0) {
    return errorResponse(404, "api_key_not_found", "API key was not found.");
  }

  return jsonResponse({
    api_key_id: apiKeyId,
    status: "deleted",
    deleted_at: now,
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
     ORDER BY CASE WHEN status = 'unpaid' THEN 0 ELSE 1 END, created_at DESC
     LIMIT 10`,
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
      amount_due: row.amount_due,
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
      amount: row.amount,
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
  const url = new URL(request.url);
  const cursor = decodeRequestsCursor(url.searchParams.get("cursor"));
  const limit = REQUESTS_PAGE_SIZE + 1;

  const rows = cursor
    ? await env.DB.prepare(
        `SELECT r.id, r.status, r.model, r.stream, r.ai_gateway_log_id,
                r.input_tokens, r.output_tokens, r.total_tokens, r.final_cost,
                r.error_code, r.started_at, r.completed_at,
                i.id AS invoice_id, i.status AS invoice_status, i.amount_due AS invoice_amount_due
         FROM meteria402_requests r
         LEFT JOIN meteria402_invoices i ON i.request_id = r.id
         WHERE r.account_id = ?
           AND (r.started_at < ? OR (r.started_at = ? AND r.id < ?))
         ORDER BY r.started_at DESC, r.id DESC
         LIMIT ?`,
      )
        .bind(account.id, cursor.startedAt, cursor.startedAt, cursor.id, limit)
        .all<RequestRow>()
    : await env.DB.prepare(
        `SELECT r.id, r.status, r.model, r.stream, r.ai_gateway_log_id,
                r.input_tokens, r.output_tokens, r.total_tokens, r.final_cost,
                r.error_code, r.started_at, r.completed_at,
                i.id AS invoice_id, i.status AS invoice_status, i.amount_due AS invoice_amount_due
         FROM meteria402_requests r
         LEFT JOIN meteria402_invoices i ON i.request_id = r.id
         WHERE r.account_id = ?
         ORDER BY r.started_at DESC, r.id DESC
         LIMIT ?`,
      )
        .bind(account.id, limit)
        .all<RequestRow>();

  const pageRows = rows.results.slice(0, REQUESTS_PAGE_SIZE);
  const hasMore = rows.results.length > REQUESTS_PAGE_SIZE;
  const lastRow = pageRows.at(-1);

  return jsonResponse({
    requests: pageRows.map((row) => ({
      id: row.id,
      status: row.status,
      model: row.model,
      stream: Boolean(row.stream),
      ai_gateway_log_id: row.ai_gateway_log_id,
      input_tokens: row.input_tokens,
      output_tokens: row.output_tokens,
      total_tokens: row.total_tokens,
      final_cost: row.final_cost == null ? null : row.final_cost,
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
                : row.invoice_amount_due,
          }
        : null,
    })),
    page_size: REQUESTS_PAGE_SIZE,
    next_cursor: hasMore && lastRow ? encodeRequestsCursor(lastRow) : null,
  });
}

function encodeRequestsCursor(row: Pick<RequestRow, "started_at" | "id">): string {
  const raw = JSON.stringify({ startedAt: row.started_at, id: row.id });
  return btoa(raw).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function decodeRequestsCursor(value: string | null): RequestCursor | null {
  if (!value) return null;
  try {
    const base64 = value.replace(/-/g, "+").replace(/_/g, "/");
    const padded = base64.padEnd(Math.ceil(base64.length / 4) * 4, "=");
    const parsed = JSON.parse(atob(padded)) as Partial<RequestCursor>;
    if (typeof parsed.startedAt !== "string" || typeof parsed.id !== "string") {
      throw new Error("Invalid cursor");
    }
    return {
      startedAt: parsed.startedAt,
      id: parsed.id,
    };
  } catch {
    throw new HttpError(400, "invalid_cursor", "Request cursor is invalid.");
  }
}

export async function handleReconcileRequests(
  request: Request,
  env: Env,
): Promise<Response> {
  const account = await requireAccountFromSession(request, env);
  const result = await reconcilePendingGatewayLogs(env, account.id);
  return jsonResponse(result);
}

function buildOwnerRebindMessage(state: OwnerRebindChallengeState): string {
  return [
    `${state.domain} wants you to confirm your Ethereum account:`,
    state.old_owner,
    "",
    OWNER_REBIND_STATEMENT,
    "",
    `Account ID: ${state.account_id}`,
    `Old owner: ${state.old_owner}`,
    `New owner: ${state.new_owner}`,
    "",
    `URI: ${state.uri}`,
    "Version: 1",
    `Chain ID: ${state.chain_id}`,
    `Nonce: ${state.nonce}`,
    `Issued At: ${state.issued_at}`,
    `Expiration Time: ${new Date(state.expires_at).toISOString()}`,
    "Resources:",
    `- ${OWNER_REBIND_RESOURCE_PREFIX}${state.account_id}:${state.nonce}`,
  ].join("\n");
}

function requireBodyString(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new HttpError(400, "missing_field", `${field} is required.`);
  }
  return value;
}

function requestOrigin(request: Request): string {
  const origin = request.headers.get("origin");
  if (origin) {
    const parsed = new URL(origin);
    if (parsed.protocol === "http:" || parsed.protocol === "https:") {
      return parsed.origin;
    }
  }
  const url = new URL(request.url);
  const referer = request.headers.get("referer");
  if (referer) {
    const parsed = new URL(referer);
    if (parsed.protocol === "http:" || parsed.protocol === "https:") {
      return parsed.origin;
    }
  }
  const host = request.headers.get("host");
  if (host) {
    const protocol =
      request.headers.get("x-forwarded-proto") || url.protocol.replace(":", "");
    return `${protocol === "https" ? "https" : "http"}://${host}`;
  }
  return url.origin;
}

function chainIdFromEnv(env: Env): number {
  const network = env.X402_NETWORK || "eip155:8453";
  const chainId = Number(network.split(":")[1] || "8453");
  if (!Number.isSafeInteger(chainId) || chainId <= 0) {
    throw new HttpError(
      500,
      "invalid_owner_rebind_network",
      "X402_NETWORK must include an EVM chain ID.",
    );
  }
  return chainId;
}
