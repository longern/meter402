import {
getAccountByOwner,
requireAccountAutopayUrl,
requireAutopayWalletBalanceEligibility
} from "./accounts";
import { normalizeAutopayUrl } from "./autopay";
import {
BASE_MAINNET,
BASE_USDC,
} from "./constants";
import {
errorResponse,
jsonResponse,
readJsonObject,
} from "./http";
import {
parsePositiveInt
} from "./money";
import {
requireSession,
serializeExpiredSessionCookie,
serializeSessionCookie,
} from "./session";
import {
signSessionState,
} from "./signed-state";
import type {
Env
} from "./types";
import {
formatTokenAmount,
getRpcUrl,
normalizeEvmAddress,
readErc20Balance
} from "./x402";

import { fetchAutopayPayerAddress } from "./billing-autopay-handlers";

export function handleGetConfig(env: Env): Response {
  return jsonResponse({
    x402_network: env.X402_NETWORK || BASE_MAINNET,
  });
}

export async function handleAutopayWalletBalance(
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

export async function handleGetSession(request: Request, env: Env): Promise<Response> {
  const session = await requireSession(request, env);
  const sessionToken = await signSessionState(env, {
    owner: session.owner,
    expires_at: session.expires_at,
  });
  return jsonResponse(
    {
      owner: session.owner,
      expires_at: new Date(session.expires_at).toISOString(),
    },
    {
      headers: {
        "set-cookie": serializeSessionCookie(request, sessionToken, session.expires_at),
      },
    },
  );
}

export function handleLogout(request: Request): Response {
  return jsonResponse(
    { status: "logged_out" },
    {
      headers: {
        "set-cookie": serializeExpiredSessionCookie(request),
      },
    },
  );
}

export async function handleUpdateSessionAutopay(
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

  if (!account) {
    return errorResponse(
      404,
      "account_not_found",
      "No account found for this session.",
    );
  }

  await env.DB.prepare(
    `UPDATE meteria402_accounts SET autopay_url = ?, updated_at = ? WHERE id = ?`,
  )
    .bind(newAutopayUrl, now, account.id)
    .run();

  return jsonResponse({
    owner: session.owner,
    autopay_url: newAutopayUrl,
    updated_at: now,
  });
}
