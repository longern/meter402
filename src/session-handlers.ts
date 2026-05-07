import {
getAccountByOwner,
requireAccountAutopayUrl,
requireAutopayWalletBalanceEligibility
} from "./accounts";
import { normalizeAutopayUrl } from "./autopay";
import {
BASE_MAINNET,
BASE_USDC,
JSON_HEADERS,
} from "./constants";
import {
errorResponse,
HttpError,
jsonResponse,
readJsonObject,
requireString
} from "./http";
import {
parsePositiveInt
} from "./money";
import {
requireSession,
serializeExpiredSessionCookie,
serializeSessionCookie,
sessionExpiresAt
} from "./session";
import {
signLoginState,
signSessionState,
verifyLoginState
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
  return jsonResponse({
    owner: session.owner,
    autopay_url: session.autopay_url,
    expires_at: new Date(session.expires_at).toISOString(),
  });
}

export async function handleLoginAutopayStart(
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

export async function handleLoginAutopayComplete(
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
