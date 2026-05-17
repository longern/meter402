import { errorResponse, jsonResponse } from "./http";
import type { Env } from "./types";
import { GATEWAY_PROVIDER_ROUTES } from "./gateway-providers";

type Handler = (request: Request, env: Env) => Response | Promise<Response>;
type IdHandler = (
  request: Request,
  env: Env,
  id: string,
) => Response | Promise<Response>;

export type RouteHandlers = {
  handleGetConfig: (env: Env) => Response;
  handleAutopayWalletBalance: Handler;
  handleGetSession: Handler;
  handleLoginChallenge: Handler;
  handleLoginComplete: Handler;
  handleLoginScanStart: Handler;
  handleLoginScanRequest: (
    request: Request,
    env: Env,
    requestId: string,
    action: string,
  ) => Response | Promise<Response>;
  handleLogout: (request: Request) => Response;
  handleUpdateSessionAutopay: Handler;
  handleListDeposits: Handler;
  handleDepositQuote: Handler;
  handleDepositIntent: Handler;
  handleDepositSettle: Handler;
  handleDepositAutopayStart: IdHandler;
  handleDepositAutopayComplete: IdHandler;
  handleGetAccount: Handler;
  handleUpdateAccount: Handler;
  handleCreateOwnerRebindChallenge: Handler;
  handleCompleteOwnerRebind: Handler;
  handleListApiKeys: Handler;
  handleCreateApiKey: Handler;
  handleDisableApiKey: IdHandler;
  handleEnableApiKey: IdHandler;
  handleDeleteApiKey: IdHandler;
  handleListInvoices: Handler;
  handleListRequests: Handler;
  handleReconcileRequests: Handler;
  handleInvoicePayQuote: IdHandler;
  handleInvoicePaySettle: IdHandler;
  handleInvoiceAutopayStart: IdHandler;
  handleInvoiceAutopayComplete: IdHandler;
  handleRefundRequest: Handler;
  handleListAutopayCapabilities: Handler;
  handleCreateAutopayCapability: Handler;
  handleRevokeAutopayCapability: IdHandler;
  handleCompleteAutopayCapability: IdHandler;
  handleAdminCreateAccount: Handler;
  handleAdminListAccounts: Handler;
  handleAdminListApiKeys: Handler;
  handleAdminListDeposits: Handler;
  handleAdminListInvoices: Handler;
  handleAdminListRequests: Handler;
  handleAdminStats: Handler;
  handleAdminListSettings: Handler;
  handleAdminUpdateSettings: Handler;
  handleV1Request: (
    request: Request,
    env: Env,
    ctx: ExecutionContext,
    provider: string,
    endpoint: string,
  ) => Promise<Response>;
};

export async function dispatchRoute(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
  handlers: RouteHandlers,
): Promise<Response> {
  const url = new URL(request.url);
  const { method } = request;

  if (method === "GET" && url.pathname === "/health") {
    return jsonResponse({ ok: true, service: "meteria402" });
  }
  if (method === "GET" && url.pathname === "/api/config") {
    return handlers.handleGetConfig(env);
  }

  const sessionResponse = await dispatchSessionRoute(request, env, handlers);
  if (sessionResponse) return sessionResponse;

  const depositResponse = await dispatchDepositRoute(request, env, url, handlers);
  if (depositResponse) return depositResponse;

  const billingResponse = await dispatchBillingRoute(request, env, url, handlers);
  if (billingResponse) return billingResponse;

  const autopayResponse = await dispatchAutopayRoute(request, env, url, handlers);
  if (autopayResponse) return autopayResponse;

  const adminResponse = await dispatchAdminRoute(request, env, url, handlers);
  if (adminResponse) return adminResponse;

  const gatewayRoute = matchGatewayProviderRoute(url.pathname);
  if (gatewayRoute && (method === "GET" || method === "POST")) {
    return handlers.handleV1Request(
      request,
      env,
      ctx,
      gatewayRoute.provider,
      gatewayRoute.endpoint,
    );
  }

  return errorResponse(404, "not_found", "No route matches this request.");
}

async function dispatchSessionRoute(
  request: Request,
  env: Env,
  handlers: RouteHandlers,
): Promise<Response | null> {
  const url = new URL(request.url);
  const { method } = request;

  if (method === "GET" && url.pathname === "/api/autopay-wallet/balance") {
    return handlers.handleAutopayWalletBalance(request, env);
  }
  if (method === "GET" && url.pathname === "/api/session") {
    return handlers.handleGetSession(request, env);
  }
  if (method === "POST" && url.pathname === "/api/login/challenge") {
    return handlers.handleLoginChallenge(request, env);
  }
  if (method === "POST" && url.pathname === "/api/login/complete") {
    return handlers.handleLoginComplete(request, env);
  }
  if (method === "POST" && url.pathname === "/api/login/scan/start") {
    return handlers.handleLoginScanStart(request, env);
  }
  const scanLogin = matchPath(
    url.pathname,
    /^\/api\/login\/scan\/([^/]+)\/(details|challenge|approve|deny|complete|events)$/,
  );
  if (scanLogin && (
    (method === "GET" && (scanLogin[1] === "details" || scanLogin[1] === "events")) ||
    (method === "POST" && (scanLogin[1] === "challenge" || scanLogin[1] === "approve" || scanLogin[1] === "deny" || scanLogin[1] === "complete"))
  )) {
    return handlers.handleLoginScanRequest(request, env, scanLogin[0], scanLogin[1]);
  }
  if (method === "POST" && url.pathname === "/api/logout") {
    return handlers.handleLogout(request);
  }
  if (method === "POST" && url.pathname === "/api/session/autopay") {
    return handlers.handleUpdateSessionAutopay(request, env);
  }
  return null;
}

async function dispatchDepositRoute(
  request: Request,
  env: Env,
  url: URL,
  handlers: RouteHandlers,
): Promise<Response | null> {
  const { method } = request;

  if (method === "GET" && url.pathname === "/api/deposits") {
    return handlers.handleListDeposits(request, env);
  }
  if (method === "POST" && url.pathname === "/api/deposits/quote") {
    return handlers.handleDepositQuote(request, env);
  }
  if (method === "GET" && url.pathname === "/api/deposits/intent") {
    return handlers.handleDepositIntent(request, env);
  }
  if (method === "POST" && url.pathname === "/api/deposits/settle") {
    return handlers.handleDepositSettle(request, env);
  }

  const depositAutopay = matchPath(
    url.pathname,
    /^\/api\/deposits\/([^/]+)\/autopay\/(start|complete)$/,
  );
  if (method === "POST" && depositAutopay) {
    const [paymentId, action] = depositAutopay;
    if (action === "start") {
      return handlers.handleDepositAutopayStart(request, env, paymentId);
    }
    return handlers.handleDepositAutopayComplete(request, env, paymentId);
  }

  return null;
}

async function dispatchBillingRoute(
  request: Request,
  env: Env,
  url: URL,
  handlers: RouteHandlers,
): Promise<Response | null> {
  const { method } = request;

  if (method === "GET" && url.pathname === "/api/account") {
    return handlers.handleGetAccount(request, env);
  }
  if (method === "PATCH" && url.pathname === "/api/account") {
    return handlers.handleUpdateAccount(request, env);
  }
  if (method === "POST" && url.pathname === "/api/account/owner-rebind/challenge") {
    return handlers.handleCreateOwnerRebindChallenge(request, env);
  }
  if (method === "POST" && url.pathname === "/api/account/owner-rebind/complete") {
    return handlers.handleCompleteOwnerRebind(request, env);
  }
  if (method === "GET" && url.pathname === "/api/api-keys") {
    return handlers.handleListApiKeys(request, env);
  }
  if (method === "POST" && url.pathname === "/api/api-keys") {
    return handlers.handleCreateApiKey(request, env);
  }
  const apiKeyId = matchPath(url.pathname, /^\/api\/api-keys\/([^/]+)$/)?.[0];
  if (method === "DELETE" && apiKeyId) {
    return handlers.handleDeleteApiKey(request, env, apiKeyId);
  }
  const apiKeyAction = matchPath(url.pathname, /^\/api\/api-keys\/([^/]+)\/(disable|enable)$/);
  if (method === "POST" && apiKeyAction) {
    const [id, action] = apiKeyAction;
    if (action === "disable") {
      return handlers.handleDisableApiKey(request, env, id);
    }
    return handlers.handleEnableApiKey(request, env, id);
  }

  if (method === "GET" && url.pathname === "/api/invoices") {
    return handlers.handleListInvoices(request, env);
  }
  if (method === "GET" && url.pathname === "/api/requests") {
    return handlers.handleListRequests(request, env);
  }
  if (method === "POST" && url.pathname === "/api/reconcile") {
    return handlers.handleReconcileRequests(request, env);
  }
  if (method === "POST" && url.pathname === "/api/refund") {
    return handlers.handleRefundRequest(request, env);
  }

  const invoiceAction = matchPath(
    url.pathname,
    /^\/api\/invoices\/([^/]+)\/pay\/(quote|settle|autopay\/start|autopay\/complete)$/,
  );
  if (method === "POST" && invoiceAction) {
    const [invoiceId, action] = invoiceAction;
    if (action === "quote") {
      return handlers.handleInvoicePayQuote(request, env, invoiceId);
    }
    if (action === "settle") {
      return handlers.handleInvoicePaySettle(request, env, invoiceId);
    }
    if (action === "autopay/start") {
      return handlers.handleInvoiceAutopayStart(request, env, invoiceId);
    }
    return handlers.handleInvoiceAutopayComplete(request, env, invoiceId);
  }

  return null;
}

async function dispatchAutopayRoute(
  request: Request,
  env: Env,
  url: URL,
  handlers: RouteHandlers,
): Promise<Response | null> {
  const { method } = request;

  if (method === "GET" && url.pathname === "/api/autopay/capabilities") {
    return handlers.handleListAutopayCapabilities(request, env);
  }
  if (method === "POST" && url.pathname === "/api/autopay/capabilities") {
    return handlers.handleCreateAutopayCapability(request, env);
  }

  const capability = matchPath(
    url.pathname,
    /^\/api\/autopay\/capabilities\/([^/]+)(?:\/(complete))?$/,
  );
  if (!capability) return null;

  const [capabilityId, action] = capability;
  if (method === "DELETE" && !action) {
    return handlers.handleRevokeAutopayCapability(request, env, capabilityId);
  }
  if (method === "POST" && action === "complete") {
    return handlers.handleCompleteAutopayCapability(request, env, capabilityId);
  }

  return null;
}

async function dispatchAdminRoute(
  request: Request,
  env: Env,
  url: URL,
  handlers: RouteHandlers,
): Promise<Response | null> {
  const { method } = request;
  const pathname = url.pathname;

  if (!pathname.startsWith("/api/admin/")) return null;

  if (method === "GET" && pathname === "/api/admin/stats") {
    return handlers.handleAdminStats(request, env);
  }
  if (method === "POST" && pathname === "/api/admin/accounts") {
    return handlers.handleAdminCreateAccount(request, env);
  }
  if (method === "GET" && pathname === "/api/admin/accounts") {
    return handlers.handleAdminListAccounts(request, env);
  }
  if (method === "GET" && pathname === "/api/admin/api-keys") {
    return handlers.handleAdminListApiKeys(request, env);
  }
  if (method === "GET" && pathname === "/api/admin/deposits") {
    return handlers.handleAdminListDeposits(request, env);
  }
  if (method === "GET" && pathname === "/api/admin/invoices") {
    return handlers.handleAdminListInvoices(request, env);
  }
  if (method === "GET" && pathname === "/api/admin/requests") {
    return handlers.handleAdminListRequests(request, env);
  }
  if (method === "GET" && pathname === "/api/admin/settings") {
    return handlers.handleAdminListSettings(request, env);
  }
  if (method === "PATCH" && pathname === "/api/admin/settings") {
    return handlers.handleAdminUpdateSettings(request, env);
  }

  return null;
}

function matchGatewayProviderRoute(
  pathname: string,
): { provider: string; endpoint: string } | null {
  for (const route of GATEWAY_PROVIDER_ROUTES) {
    if (pathname === route.publicPrefix || pathname.startsWith(`${route.publicPrefix}/`)) {
      const endpoint = pathname.slice(route.publicPrefix.length).replace(/^\/+/, "");
      if (!endpoint) return null;
      return {
        provider: route.gatewayProvider,
        endpoint,
      };
    }
  }
  return null;
}

function matchPath(pathname: string, regex: RegExp): string[] | null {
  const match = regex.exec(pathname);
  return match ? match.slice(1) : null;
}
