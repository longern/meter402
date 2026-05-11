import { normalizeAutopayUrl } from "./autopay";
import { sha256Hex } from "./crypto";
import { errorResponse, HttpError } from "./http";
import { requireSession } from "./session";
import type {
  Account,
  AuthenticatedAccount,
  AutopayWalletBalanceEligibility,
  Env,
} from "./types";
import { normalizeEvmAddress } from "./x402";

export async function authenticate(
  request: Request,
  env: Env,
): Promise<AuthenticatedAccount | Response> {
  const apiKey = readMeteriaApiKey(request);
  if (!apiKey) {
    return errorResponse(401, "missing_api_key", "Missing bearer API key.");
  }

  const keyHash = await sha256Hex(apiKey);
  const account = await env.DB.prepare(
    `SELECT a.id, a.status, a.owner_address, a.autopay_url, a.deposit_balance, a.unpaid_invoice_total,
            a.concurrency_limit, a.min_deposit_required, a.autopay_min_recharge_amount, a.refund_address,
            k.id AS api_key_id, k.spend_limit AS api_key_spend_limit, k.spent_amount AS api_key_spent_amount
     FROM meteria402_api_keys k
     JOIN meteria402_accounts a ON a.id = k.account_id
     WHERE k.key_hash = ?
       AND k.revoked_at IS NULL
       AND (k.expires_at IS NULL OR k.expires_at > ?)`,
  )
    .bind(keyHash, new Date().toISOString())
    .first<AuthenticatedAccount>();

  if (!account) {
    return errorResponse(401, "invalid_api_key", "The API key is invalid.");
  }
  return account;
}

export async function requireAccountFromSession(
  request: Request,
  env: Env,
): Promise<AuthenticatedAccount> {
  const session = await requireSession(request, env);
  const account = await getAccountByOwner(env, session.owner);
  if (!account) {
    throw new HttpError(
      401,
      "account_not_found",
      "No account found for this session.",
    );
  }
  return {
    ...account,
    api_key_id: "",
    api_key_spend_limit: null,
    api_key_spent_amount: 0,
  };
}

export async function getAccount(
  env: Env,
  accountId: string,
): Promise<Account | null> {
  return env.DB.prepare(
    `SELECT id, status, owner_address, autopay_url, deposit_balance, unpaid_invoice_total,
            concurrency_limit, min_deposit_required, autopay_min_recharge_amount, refund_address
     FROM meteria402_accounts
     WHERE id = ?`,
  )
    .bind(accountId)
    .first<Account>();
}

export async function getAccountByOwner(
  env: Env,
  owner: string,
): Promise<Account | null> {
  return env.DB.prepare(
    `SELECT id, status, owner_address, autopay_url, deposit_balance, unpaid_invoice_total,
            concurrency_limit, min_deposit_required, autopay_min_recharge_amount, refund_address
     FROM meteria402_accounts
     WHERE lower(owner_address) = lower(?)
     LIMIT 1`,
  )
    .bind(owner)
    .first<Account>();
}

export function requireAccountAutopayUrl(account: Account): string {
  if (!account.autopay_url) {
    throw new HttpError(
      409,
      "autopay_not_configured",
      "Autopay worker is not configured for this account.",
    );
  }
  return normalizeAutopayUrl(account.autopay_url);
}

export async function requirePaymentAccountAutopayUrl(
  env: Env,
  accountId: string | null,
): Promise<string> {
  if (!accountId) {
    throw new HttpError(
      409,
      "autopay_not_configured",
      "Autopay worker is not configured for this payment.",
    );
  }
  const account = await getAccount(env, accountId);
  if (!account) {
    throw new HttpError(404, "account_not_found", "The account was not found.");
  }
  return requireAccountAutopayUrl(account);
}

export async function requireAutopayWalletBalanceEligibility(
  request: Request,
  env: Env,
): Promise<AutopayWalletBalanceEligibility> {
  const session = await requireSession(request, env);
  const owner = normalizeEvmAddress(session.owner);
  const account = await getAccountByOwner(env, owner);
  if (!account) {
    throw new HttpError(
      402,
      "deposit_required",
      "Deposit is required before loading the autopay wallet balance.",
      {
        owner,
      },
    );
  }
  return { account, owner };
}

function readMeteriaApiKey(request: Request): string | null {
  const auth = request.headers.get("authorization") || "";
  const match = auth.match(/^Bearer\s+(.+)$/i);
  if (match) return match[1];
  return (
    request.headers.get("x-api-key") ||
    request.headers.get("x-goog-api-key")
  );
}
