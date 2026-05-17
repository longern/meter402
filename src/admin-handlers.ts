import { errorResponse, HttpError, jsonResponse } from "./http";
import { requireSession } from "./session";
import type { Env } from "./types";
import { isAdminWallet } from "./accounts";
import { makeId } from "./crypto";
import { parseMoney, parsePositiveInt } from "./money";

export async function requireAdmin(
  request: Request,
  env: Env,
): Promise<{ owner: string }> {
  const session = await requireSession(request, env);
  if (!isAdminWallet(env, session.owner)) {
    throw new HttpError(403, "forbidden", "Admin access required.");
  }
  return { owner: session.owner };
}

export async function handleAdminCreateAccount(
  request: Request,
  env: Env,
): Promise<Response> {
  await requireAdmin(request, env);

  const body = await request.json<{ owner_address?: unknown }>();
  const rawAddress = body?.owner_address;
  if (!rawAddress || typeof rawAddress !== "string" || !rawAddress.trim()) {
    throw new HttpError(400, "missing_owner_address", "Owner address is required.");
  }

  const ownerAddress = rawAddress.trim().toLowerCase();
  if (!/^0x[0-9a-f]{40}$/.test(ownerAddress)) {
    throw new HttpError(400, "invalid_address", "Invalid wallet address. Must be a 0x-prefixed 40-hex EVM address.");
  }

  const existing = await env.DB.prepare(
    `SELECT id FROM meteria402_accounts WHERE lower(owner_address) = ?`,
  )
    .bind(ownerAddress)
    .first<{ id: string }>();

  if (existing) {
    throw new HttpError(409, "account_exists", "An account already exists for this wallet address.");
  }

  const now = new Date().toISOString();
  const accountId = makeId("acct");
  const concurrencyLimit = parsePositiveInt(env.DEFAULT_CONCURRENCY_LIMIT || "3", 3);
  const minDepositRequired = parseMoney(env.DEFAULT_MIN_DEPOSIT || "5.00");

  await env.DB.prepare(
    `INSERT INTO meteria402_accounts
     (id, status, owner_address, autopay_url, deposit_balance, unpaid_invoice_total,
      concurrency_limit, min_deposit_required, refund_address, autopay_min_recharge_amount, created_at, updated_at)
     VALUES (?, 'active', ?, NULL, 0, 0, ?, ?, NULL, 10000, ?, ?)`,
  ).bind(accountId, ownerAddress, concurrencyLimit, minDepositRequired, now, now);

  return jsonResponse({
    id: accountId,
    status: "active",
    owner_address: ownerAddress,
    deposit_balance: 0,
    unpaid_invoice_total: 0,
    created_at: now,
  });
}

export async function handleAdminListAccounts(
  request: Request,
  env: Env,
): Promise<Response> {
  await requireAdmin(request, env);

  const url = new URL(request.url);
  const limit = Math.min(parseInt(url.searchParams.get("limit") || "50", 10), 100);
  const offset = parseInt(url.searchParams.get("offset") || "0", 10);

  const accounts = await env.DB.prepare(
    `SELECT id, status, owner_address, deposit_balance, unpaid_invoice_total,
            concurrency_limit, min_deposit_required, autopay_min_recharge_amount,
            created_at, updated_at
     FROM meteria402_accounts
     ORDER BY created_at DESC
     LIMIT ? OFFSET ?`,
  )
    .bind(limit, offset)
    .all();

  const total = await env.DB.prepare(
    `SELECT COUNT(*) as total FROM meteria402_accounts`,
  )
    .first<{ total: number }>();

  return jsonResponse({
    accounts: accounts.results || [],
    total: total?.total || 0,
    limit,
    offset,
  });
}

export async function handleAdminListApiKeys(
  request: Request,
  env: Env,
): Promise<Response> {
  await requireAdmin(request, env);

  const url = new URL(request.url);
  const limit = Math.min(parseInt(url.searchParams.get("limit") || "50", 10), 100);
  const offset = parseInt(url.searchParams.get("offset") || "0", 10);

  const keys = await env.DB.prepare(
    `SELECT k.id, k.account_id, k.name, k.spend_limit, k.spent_amount,
            k.created_at, k.expires_at, k.revoked_at, k.deleted_at,
            a.owner_address
     FROM meteria402_api_keys k
     JOIN meteria402_accounts a ON a.id = k.account_id
     ORDER BY k.created_at DESC
     LIMIT ? OFFSET ?`,
  )
    .bind(limit, offset)
    .all();

  const total = await env.DB.prepare(
    `SELECT COUNT(*) as total FROM meteria402_api_keys`,
  )
    .first<{ total: number }>();

  return jsonResponse({
    api_keys: keys.results || [],
    total: total?.total || 0,
    limit,
    offset,
  });
}

export async function handleAdminListDeposits(
  request: Request,
  env: Env,
): Promise<Response> {
  await requireAdmin(request, env);

  const url = new URL(request.url);
  const limit = Math.min(parseInt(url.searchParams.get("limit") || "50", 10), 100);
  const offset = parseInt(url.searchParams.get("offset") || "0", 10);

  const deposits = await env.DB.prepare(
    `SELECT p.id, p.account_id, p.amount, p.currency, p.status,
            p.settled_at, p.created_at, a.owner_address
     FROM meteria402_payments p
     JOIN meteria402_accounts a ON a.id = p.account_id
     WHERE p.kind = 'deposit'
     ORDER BY p.created_at DESC
     LIMIT ? OFFSET ?`,
  )
    .bind(limit, offset)
    .all();

  const total = await env.DB.prepare(
    `SELECT COUNT(*) as total FROM meteria402_payments WHERE kind = 'deposit'`,
  )
    .first<{ total: number }>();

  return jsonResponse({
    deposits: deposits.results || [],
    total: total?.total || 0,
    limit,
    offset,
  });
}

export async function handleAdminListInvoices(
  request: Request,
  env: Env,
): Promise<Response> {
  await requireAdmin(request, env);

  const url = new URL(request.url);
  const limit = Math.min(parseInt(url.searchParams.get("limit") || "50", 10), 100);
  const offset = parseInt(url.searchParams.get("offset") || "0", 10);

  const invoices = await env.DB.prepare(
    `SELECT i.id, i.account_id, i.amount_due as amount, i.status, i.paid_at as settled_at,
            i.created_at, a.owner_address
     FROM meteria402_invoices i
     JOIN meteria402_accounts a ON a.id = i.account_id
     ORDER BY i.created_at DESC
     LIMIT ? OFFSET ?`,
  )
    .bind(limit, offset)
    .all();

  const total = await env.DB.prepare(
    `SELECT COUNT(*) as total FROM meteria402_invoices`,
  )
    .first<{ total: number }>();

  return jsonResponse({
    invoices: invoices.results || [],
    total: total?.total || 0,
    limit,
    offset,
  });
}

export async function handleAdminListRequests(
  request: Request,
  env: Env,
): Promise<Response> {
  await requireAdmin(request, env);

  const url = new URL(request.url);
  const limit = Math.min(parseInt(url.searchParams.get("limit") || "50", 10), 100);
  const offset = parseInt(url.searchParams.get("offset") || "0", 10);

  const reqs = await env.DB.prepare(
    `SELECT r.id, r.account_id, r.api_key_id, r.model as provider, r.model,
            r.input_tokens, r.output_tokens, r.final_cost as cost, r.started_at as created_at,
            a.owner_address
     FROM meteria402_requests r
     JOIN meteria402_accounts a ON a.id = r.account_id
     ORDER BY r.started_at DESC
     LIMIT ? OFFSET ?`,
  )
    .bind(limit, offset)
    .all();

  const total = await env.DB.prepare(
    `SELECT COUNT(*) as total FROM meteria402_requests`,
  )
    .first<{ total: number }>();

  return jsonResponse({
    requests: reqs.results || [],
    total: total?.total || 0,
    limit,
    offset,
  });
}

export async function handleAdminStats(
  request: Request,
  env: Env,
): Promise<Response> {
  await requireAdmin(request, env);

  const stats = await env.DB.prepare(
    `SELECT
      (SELECT COUNT(*) FROM meteria402_accounts) as total_accounts,
      (SELECT COUNT(*) FROM meteria402_accounts WHERE status = 'active') as active_accounts,
      (SELECT COUNT(*) FROM meteria402_api_keys WHERE revoked_at IS NULL AND deleted_at IS NULL) as active_keys,
      (SELECT SUM(deposit_balance) FROM meteria402_accounts) as total_deposits,
      (SELECT SUM(unpaid_invoice_total) FROM meteria402_accounts) as total_unpaid,
      (SELECT COUNT(*) FROM meteria402_requests WHERE started_at > datetime('now', '-24 hours')) as requests_24h`,
  )
    .first<{
      total_accounts: number;
      active_accounts: number;
      active_keys: number;
      total_deposits: number;
      total_unpaid: number;
      requests_24h: number;
    }>();

  return jsonResponse(stats || {
    total_accounts: 0,
    active_accounts: 0,
    active_keys: 0,
    total_deposits: 0,
    total_unpaid: 0,
    requests_24h: 0,
  });
}
