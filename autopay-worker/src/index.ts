import { x402Client, x402HTTPClient } from "@x402/core/client";
import type { Network, PaymentRequired, PaymentRequirements } from "@x402/core/types";
import { registerExactEvmScheme } from "@x402/evm/exact/client";
import { SiweMessage } from "siwe";
import { getAddress, verifyMessage, verifyTypedData, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";

type Env = {
  DB: D1Database;
  AUTOPAY_ADMIN_PRIVATE_KEY?: string;
  AUTOPAY_ADMIN_OWNER?: string;
  AUTOPAY_SECRET?: string;
  AUTOPAY_AUTH_SESSIONS: DurableObjectNamespace;
};

type PayerWallet = {
  privateKey: Hex;
};

type AccountWallet = {
  owner: Address;
  autopayWalletAddress: Address;
  encryptedPrivateKey: string;
  createdAt: string;
  updatedAt: string;
};

type AutopayCapability = {
  requester?: RequesterBinding;
  allowedOrigins: string[];
  allowedPayTo: Address[];
  network: Network;
  asset: Address;
  maxSingleAmount: string;
  totalBudget: string;
  validBefore: string;
};

type RequesterBinding = {
  name?: string;
  origin: string;
  account: string;
};

type RequesterProof = {
  account: string;
  nonce: string;
  issuedAt: number;
  expiresAt: number;
  signature: Hex;
};

type AuthorizationInput = {
  siweMessage?: unknown;
  siwe_message?: unknown;
  siweSignature?: unknown;
  siwe_signature?: unknown;
};

type ProxyBody = AuthorizationInput & {
  url?: unknown;
  method?: unknown;
  headers?: unknown;
  body?: unknown;
};

type AuthRequestRecord = {
  requestId: string;
  pollToken: string;
  eventToken: string;
  status: "pending" | "approved" | "denied";
  kind: "payment" | "login";
  authOrigin: string;
  policy?: AutopayCapability;
  paymentRequirementHash?: string;
  returnOrigin?: string;
  network?: Network;
  nonce: string;
  createdAt: string;
  expiresAt: string;
  approvedAt?: string;
  siweMessage?: string;
  siweSignature?: string;
  owner?: Address;
};

const JSON_HEADERS = {
  "content-type": "application/json; charset=utf-8",
};

const CORS_HEADERS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET,POST,OPTIONS",
  "access-control-allow-headers": "authorization,content-type,x-autopay-poll-token,x-requester-account,x-requester-nonce,x-requester-issued-at,x-requester-expires-at,x-requester-signature,x-requester-origin",
  "access-control-expose-headers": "x-payment-response",
};

const CAPABILITY_PREFIX = "urn:meteria402:autopay:v1:";
const AUTH_REQUEST_PREFIX = "urn:meteria402:auth-request:";
const PAYMENT_REQUIREMENT_PREFIX = "urn:meteria402:payment-requirement:";
const LOGIN_PREFIX = "urn:meteria402:login:";
const DEFAULT_AUTH_TTL_SECONDS = 5 * 60;
const MAX_AUTH_TTL_SECONDS = 30 * 60;
const DEFAULT_NETWORK = "eip155:8453" as Network;
const REQUESTER_PROOF_DOMAIN_NAME = "Meteria402 Autopay Requester";
const REQUESTER_PROOF_VERSION = "1";
const REQUESTER_PROOF_TYPES = {
  AutopayPaymentRequest: [
    { name: "worker", type: "string" },
    { name: "path", type: "string" },
    { name: "bodyHash", type: "bytes32" },
    { name: "capabilityHash", type: "bytes32" },
    { name: "nonce", type: "string" },
    { name: "issuedAt", type: "uint256" },
    { name: "expiresAt", type: "uint256" },
  ],
} as const;

export class AutopayAuthSession implements DurableObject {
  constructor(
    private readonly ctx: DurableObjectState,
    private readonly env: Env,
  ) {}

  async fetch(request: Request): Promise<Response> {
    try {
      const url = new URL(request.url);
      if (request.method === "POST" && url.pathname === "/init") {
        const record = await readJsonObject(request) as AuthRequestRecord;
        await this.ctx.storage.put("record", record);
        await this.ctx.storage.setAlarm(new Date(record.expiresAt));
        return jsonResponse({ ok: true });
      }

      const record = await this.getRecord();
      if (isExpired(record)) {
        return errorResponse(410, "auth_request_expired", "Authorization request has expired.");
      }

      if (request.method === "GET" && url.pathname === "/details") {
        return jsonResponse(publicAuthRecord(record));
      }

      if (request.method === "GET" && url.pathname === "/poll") {
        const pollToken = request.headers.get("x-autopay-poll-token") || url.searchParams.get("poll_token") || "";
        if (!pollToken || pollToken !== record.pollToken) {
          throw new HttpError(403, "invalid_poll_token", "Poll token is invalid.");
        }

        if (record.status !== "approved") {
          return jsonResponse({
            status: record.status,
            expires_at: record.expiresAt,
          });
        }

        return jsonResponse({
          status: "approved",
          expires_at: record.expiresAt,
          authorization: {
            siwe_message: record.siweMessage,
            siwe_signature: record.siweSignature,
            owner: record.owner,
            capability: record.policy,
            kind: record.kind,
          },
        });
      }

      if (request.method === "GET" && url.pathname === "/events") {
        if (request.headers.get("Upgrade") !== "websocket") {
          throw new HttpError(426, "websocket_required", "WebSocket upgrade is required.");
        }
        const eventToken = url.searchParams.get("event_token") || "";
        if (!eventToken || eventToken !== record.eventToken) {
          throw new HttpError(403, "invalid_event_token", "Event token is invalid.");
        }

        const pair = new WebSocketPair();
        const [client, server] = Object.values(pair);
        this.ctx.acceptWebSocket(server);
        server.send(JSON.stringify(authRequestEvent(record)));
        if (record.status !== "pending") {
          server.close(1000, record.status);
        }
        return new Response(null, { status: 101, webSocket: client });
      }

      if (request.method === "POST" && url.pathname === "/deny") {
        record.status = "denied";
        await this.ctx.storage.put("record", record);
        this.broadcastEvent(record);
        return jsonResponse({ status: record.status });
      }

      if (request.method === "POST" && url.pathname === "/approve") {
        if (record.status === "denied") {
          throw new HttpError(409, "auth_request_denied", "Authorization request has already been denied.");
        }
        const body = await readJsonObject(request);
        const authorization = await verifyAuthorization(request, this.env, body, {
          expectedOrigin: record.authOrigin,
          requireCapability: record.kind === "payment",
        });
        if (authorization.authRequestId !== record.requestId) {
          throw new HttpError(403, "auth_request_mismatch", "SIWE authorization is not bound to this request.");
        }
        if (record.kind === "login") {
          if (authorization.loginRequestId !== record.requestId) {
            throw new HttpError(403, "login_request_mismatch", "SIWE authorization is not bound to this login request.");
          }
          if (chainIdFromNetwork(record.network ?? DEFAULT_NETWORK) !== authorization.siwe.chainId) {
            throw new HttpError(403, "siwe_chain_mismatch", "SIWE chain ID does not match the requested login network.");
          }
        }
        if (record.kind === "payment" && record.paymentRequirementHash && authorization.paymentRequirementHash !== record.paymentRequirementHash) {
          throw new HttpError(403, "payment_requirement_hash_mismatch", "SIWE authorization is not bound to the requested payment requirement.");
        }
        if (record.kind === "payment" && (!authorization.capability || !record.policy || !sameCapability(authorization.capability, record.policy))) {
          throw new HttpError(403, "policy_mismatch", "SIWE authorization does not match the requested policy.");
        }
        if (authorization.siwe.nonce !== record.nonce) {
          throw new HttpError(403, "nonce_mismatch", "SIWE nonce does not match the authorization request.");
        }

        record.status = "approved";
        record.approvedAt = new Date().toISOString();
        record.siweMessage = requireString(body.siweMessage ?? body.siwe_message, "siwe_message");
        record.siweSignature = requireString(body.siweSignature ?? body.siwe_signature, "siwe_signature");
        record.owner = authorization.owner;
        await this.ctx.storage.put("record", record);
        this.broadcastEvent(record);

        let capabilityHash: string | null = null;
        if (authorization.capability) {
          capabilityHash = await hashCapability(authorization.capability);
        }
        try {
          await this.env.DB.prepare(
            `INSERT INTO autopay_authorizations
             (id, request_id, kind, owner, requester_origin, policy_network, policy_asset, policy_max_single_amount, policy_total_budget, policy_valid_before, reserved_amount, status, created_at, approved_at, expires_at, capability_hash)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '0', 'approved', ?, ?, ?, ?)`
          ).bind(
            record.requestId,
            record.requestId,
            record.kind,
            record.owner,
            authorization.capability?.requester?.origin ?? null,
            record.policy?.network ?? null,
            record.policy?.asset ?? null,
            record.policy?.maxSingleAmount ?? null,
            authorization.capability?.totalBudget ?? null,
            record.policy?.validBefore ?? null,
            record.createdAt,
            record.approvedAt,
            record.expiresAt,
            capabilityHash,
          ).run();
        } catch (err) {
          console.error("Failed to insert autopay_authorizations approved", err);
        }

        return jsonResponse({
          status: record.status,
          owner: record.owner,
        });
      }

      return errorResponse(404, "not_found", "No session route matches this request.");
    } catch (error) {
      if (error instanceof HttpError) {
        return errorResponse(error.status, error.code, error.message);
      }
      console.error("Unhandled auth session error", error);
      return errorResponse(500, "internal_error", "An internal error occurred.");
    }
  }

  async alarm(): Promise<void> {
    const record = await this.ctx.storage.get<AuthRequestRecord>("record");
    if (record && record.status === "pending") {
      this.broadcastEvent(record, "expired");
    }
    await this.ctx.storage.deleteAll();
  }

  private async getRecord(): Promise<AuthRequestRecord> {
    const record = await this.ctx.storage.get<AuthRequestRecord>("record");
    if (!record) {
      throw new HttpError(404, "auth_request_not_found", "Authorization request was not found.");
    }
    return record;
  }

  private broadcastEvent(record: AuthRequestRecord, status: "pending" | "approved" | "denied" | "expired" = record.status): void {
    const message = JSON.stringify(authRequestEvent(record, status));
    for (const ws of this.ctx.getWebSockets()) {
      try {
        ws.send(message);
        if (status !== "pending") {
          ws.close(1000, status);
        }
      } catch (error) {
        console.warn("Failed to send auth request event", error);
      }
    }
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    try {
      if (request.method === "OPTIONS") {
        return new Response(null, { status: 204, headers: CORS_HEADERS });
      }

      const url = new URL(request.url);
      if (request.method === "GET" && url.pathname === "/api/health") {
        return jsonResponse({ ok: true, service: "meteria402-autopay-worker" });
      }

      if ((request.method === "GET" || request.method === "HEAD") && url.pathname === "/authorize") {
        const next = new URL("/", url.origin);
        for (const [key, value] of url.searchParams.entries()) {
          next.searchParams.set(key, value);
        }
        return Response.redirect(next.toString(), 302);
      }

      if (request.method === "GET" && url.pathname === "/api/capabilities") {
        const requestedOwner = parseOptionalAddress(url.searchParams.get("owner"));
        const payerWallet = requestedOwner ? await getPayerWalletForOwner(env, requestedOwner) : getDefaultPayerWallet(env);
        return jsonResponse({
          authorization: "siwe_device_flow",
          capability_resource_prefix: CAPABILITY_PREFIX,
          auth_request_resource_prefix: AUTH_REQUEST_PREFIX,
          payment_requirement_resource_prefix: PAYMENT_REQUIREMENT_PREFIX,
          login_resource_prefix: LOGIN_PREFIX,
          x402_networks: ["eip155:8453"],
          payer_address: payerWallet ? privateKeyToAccount(payerWallet.privateKey).address : null,
          storage: "durable_object",
        });
      }

      if (request.method === "POST" && url.pathname === "/api/auth/requests") {
        return await handleCreateAuthRequest(request, env);
      }

      const authRequestMatch = url.pathname.match(/^\/api\/auth\/requests\/([^/]+)(?:\/(details|poll|events|approve|deny))?$/);
      if (authRequestMatch) {
        const requestId = authRequestMatch[1];
        const action = authRequestMatch[2] ?? "details";
        return await forwardAuthSession(env, requestId, action, request);
      }

      if (request.method === "POST" && url.pathname === "/api/pay") {
        return await handlePay(request, env);
      }

      if (request.method === "GET" && url.pathname === "/api/auth/challenge") {
        return await handleAuthChallenge(request, env);
      }

      if (request.method === "POST" && url.pathname === "/api/auth/login") {
        return await handleAuthLogin(request, env);
      }

      if (request.method === "POST" && url.pathname === "/api/auth/logout") {
        return await handleAuthLogout(request, env);
      }

      if (request.method === "GET" && url.pathname === "/api/auth/me") {
        return await handleAuthMe(request, env);
      }

      if (url.pathname === "/api/account" && request.method === "GET") {
        return await handleAccountGet(request, env);
      }

      if (url.pathname === "/api/account/autopay-wallet" && request.method === "PUT") {
        return await handleAccountAutopayWalletUpdate(request, env);
      }

      if (url.pathname === "/api/admin/accounts" && request.method === "GET") {
        return await handleAdminAccountsList(request, env);
      }

      if (url.pathname === "/api/admin/accounts" && request.method === "POST") {
        return await handleAdminAccountCreate(request, env);
      }

      if (request.method === "GET" && url.pathname === "/api/audit/authorizations") {
        return await handleAuditAuthorizations(request, env);
      }

      if (request.method === "GET" && url.pathname === "/api/audit/payments") {
        return await handleAuditPayments(request, env);
      }

      if (request.method === "POST" && url.pathname === "/api/proxy") {
        return await handleProxy(request, env);
      }

      return errorResponse(404, "not_found", "No route matches this request.");
    } catch (error) {
      if (error instanceof HttpError) {
        return errorResponse(error.status, error.code, error.message);
      }
      console.error("Unhandled request error", error);
      return errorResponse(500, "internal_error", "An internal error occurred.");
    }
  },
};

async function handleCreateAuthRequest(request: Request, env: Env): Promise<Response> {
  const body = await readJsonObject(request);
  const requestUrl = new URL(request.url);
  const publicOrigin = requestUrl.origin;
  const kind = body.kind === "login" || body.purpose === "login" ? "login" : "payment";
  const paymentRequiredInput = body.paymentRequired ?? body.payment_required;
  const paymentRequired = paymentRequiredInput == null ? undefined : normalizePaymentRequired(paymentRequiredInput);
  const paymentRequirementHash = kind === "payment" && typeof body.paymentRequirementHash === "string"
    ? normalizeHash(body.paymentRequirementHash)
    : kind === "payment" && typeof body.payment_requirement_hash === "string"
      ? normalizeHash(body.payment_requirement_hash)
      : paymentRequired
        ? await hashJson(paymentRequired)
        : undefined;

  const returnOrigin = normalizeOptionalOrigin(body.returnOrigin ?? body.return_origin);
  const ttlSeconds = normalizeTtlSeconds(body.ttlSeconds ?? body.ttl_seconds);
  const sessionId = env.AUTOPAY_AUTH_SESSIONS.newUniqueId();
  const requestId = encodeDurableObjectId(sessionId.toString());
  const pollToken = randomToken(32);
  const eventToken = randomToken(32);
  const now = new Date();
  const expiresAt = new Date(now.getTime() + ttlSeconds * 1000);
  const policyValidBefore = normalizeValidBefore(body.policyValidBefore ?? body.policy_valid_before ?? body.validBefore ?? body.valid_before, expiresAt);
  const requester = kind === "payment" ? normalizeRequester(body.requester) : undefined;

  const policy = kind === "payment"
    ? normalizeCapability(body.policy ?? inferPolicyFromPaymentRequirement(env, paymentRequired, policyValidBefore), policyValidBefore, requester)
    : undefined;
  if (kind === "payment" && paymentRequirementHash) {
    if (!policy) {
      throw new HttpError(400, "missing_policy", "Payment authorization requires a policy.");
    }
    validateCapabilityAllowsPayment(policy, paymentRequired);
  }

  const record: AuthRequestRecord = {
    requestId,
    pollToken,
    eventToken,
    status: "pending",
    kind,
    authOrigin: publicOrigin,
    policy,
    paymentRequirementHash,
    returnOrigin,
    network: kind === "login" ? normalizeNetwork(body.network) : undefined,
    nonce: randomSiweNonce(),
    createdAt: now.toISOString(),
    expiresAt: expiresAt.toISOString(),
  };

  const stub = env.AUTOPAY_AUTH_SESSIONS.get(sessionId);
  await stub.fetch("https://session/init", {
    method: "POST",
    headers: JSON_HEADERS,
    body: JSON.stringify(record),
  });

  const verification = new URL("/authorize", publicOrigin);
  verification.searchParams.set("request_id", requestId);
  const websocket = new URL(`/api/auth/requests/${encodeURIComponent(requestId)}/events`, publicOrigin);
  websocket.protocol = websocket.protocol === "https:" ? "wss:" : "ws:";
  websocket.searchParams.set("event_token", eventToken);

  return jsonResponse({
    request_id: requestId,
    poll_token: pollToken,
    websocket_uri_complete: websocket.toString(),
    verification_uri: `${publicOrigin}/authorize`,
    verification_uri_complete: verification.toString(),
    expires_in: ttlSeconds,
    interval: 2,
    kind,
    payment_requirement_hash: paymentRequirementHash,
  }, { status: 201 });
}

async function forwardAuthSession(env: Env, requestId: string, action: string, request: Request): Promise<Response> {
  const url = new URL(request.url);
  const sessionUrl = new URL(`https://session/${action}`);
  sessionUrl.search = url.search;
  const forwarded = new Request(sessionUrl, request);
  return sessionStub(env, requestId).fetch(forwarded);
}

function authRequestEvent(record: AuthRequestRecord, status: "pending" | "approved" | "denied" | "expired" = record.status): Record<string, unknown> {
  return {
    type: "auth_request.status",
    request_id: record.requestId,
    status,
    kind: record.kind,
    expires_at: record.expiresAt,
    approved_at: record.approvedAt,
    owner: record.status === "approved" ? record.owner : undefined,
  };
}

function sessionStub(env: Env, requestId: string): DurableObjectStub {
  let id: DurableObjectId;
  try {
    id = env.AUTOPAY_AUTH_SESSIONS.idFromString(decodeDurableObjectId(requestId));
  } catch {
    throw new HttpError(400, "invalid_auth_request_id", "Authorization request ID is invalid.");
  }
  return env.AUTOPAY_AUTH_SESSIONS.get(id);
}

function encodeDurableObjectId(value: string): string {
  if (!/^[0-9a-f]{64}$/i.test(value)) {
    throw new HttpError(500, "invalid_durable_object_id", "Durable Object ID is invalid.");
  }
  let binary = "";
  for (let index = 0; index < value.length; index += 2) {
    binary += String.fromCharCode(Number.parseInt(value.slice(index, index + 2), 16));
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function decodeDurableObjectId(value: string): string {
  if (!/^[A-Za-z0-9_-]{43}$/.test(value)) {
    throw new HttpError(400, "invalid_auth_request_id", "Authorization request ID is invalid.");
  }
  const padded = value.replace(/-/g, "+").replace(/_/g, "/").padEnd(44, "=");
  const binary = atob(padded);
  let hex = "";
  for (let index = 0; index < binary.length; index += 1) {
    hex += binary.charCodeAt(index).toString(16).padStart(2, "0");
  }
  return hex;
}

async function handlePay(request: Request, env: Env): Promise<Response> {
  const bodyText = await request.text();
  const body = parseJsonObject(bodyText);
  const paymentRequired = normalizePaymentRequired(body.paymentRequired ?? body.payment_required ?? body);
  const authorization = await verifyAuthorization(request, env, body);

  if (!authorization.capability) {
    throw new HttpError(403, "missing_capability", "Payment authorization requires a capability.");
  }

  const capabilityHash = await hashCapability(authorization.capability);
  const selectedRequirement = selectRequirement(paymentRequired, authorization.capability);
  const requesterProof = await verifyRequesterProof(request, authorization.capability, bodyText, capabilityHash);

  // ─── Budget check: atomic reserved_amount + amount <= total_budget ───
  const budgetRow = await env.DB.prepare(
    `SELECT policy_total_budget, reserved_amount
     FROM autopay_authorizations
     WHERE capability_hash = ? AND status = 'approved'`
  ).bind(capabilityHash).first<{ policy_total_budget: string | null; reserved_amount: string }>();

  if (!budgetRow || !budgetRow.policy_total_budget) {
    throw new HttpError(403, "capability_not_registered", "Capability budget is not registered.");
  }

  const newReserved = BigInt(budgetRow.reserved_amount) + BigInt(selectedRequirement.amount);
  const totalBudget = BigInt(budgetRow.policy_total_budget);
  if (newReserved > totalBudget) {
    throw new HttpError(402, "budget_exceeded", "This payment would exceed the autopay capability total budget.");
  }

  const paymentId = crypto.randomUUID();
  const resourceUrl = paymentRequired.resource?.url ?? "";
  const amountDecimal = (() => {
    try {
      const amt = BigInt(selectedRequirement.amount);
      return (Number(amt) / 1_000_000).toFixed(6);
    } catch {
      return null;
    }
  })();
  await insertPaymentAudit(env, {
    paymentId,
    authorizationId: authorization.authRequestId ?? null,
    capabilityHash,
    owner: authorization.owner,
    selectedRequirement,
    amountDecimal,
    resourceUrl,
    requesterProof,
  });

  const { headers, paymentPayload } = await createPayment(env, paymentRequired, authorization, selectedRequirement);

  // ─── Atomic budget reservation ───
  const updateResult = await env.DB.prepare(
    `UPDATE autopay_authorizations
     SET reserved_amount = ?
     WHERE capability_hash = ? AND status = 'approved' AND reserved_amount = ?`
  ).bind(newReserved.toString(), capabilityHash, budgetRow.reserved_amount).run();

  if (updateResult.meta.changes === 0) {
    throw new HttpError(409, "budget_race", "Capability budget was modified concurrently. Please retry.");
  }

  return jsonResponse({
    headers,
    payment_payload: paymentPayload,
    selected_requirement: selectedRequirement,
    authorized_by: authorization.owner,
    auth_request_id: authorization.authRequestId,
    capability_hash: capabilityHash,
  });
}

async function handleProxy(request: Request, env: Env): Promise<Response> {
  const bodyText = await request.text();
  const body = parseJsonObject(bodyText) as ProxyBody;
  const authorization = await verifyAuthorization(request, env, body);
  const capabilityHash = authorization.capability ? await hashCapability(authorization.capability) : "";
  const requesterProof = authorization.capability
    ? await verifyRequesterProof(request, authorization.capability, bodyText, capabilityHash)
    : undefined;
  const targetUrl = requireString(body.url, "url");
  const method = typeof body.method === "string" ? body.method : "GET";
  const headers = normalizeProxyHeaders(body.headers);
  const requestBody = typeof body.body === "string" ? body.body : body.body == null ? undefined : JSON.stringify(body.body);

  const first = await fetch(targetUrl, {
    method,
    headers,
    body: requestBody,
  });

  if (first.status !== 402) {
    return copyResponse(first);
  }

  const paymentRequired = await parsePaymentRequiredResponse(first);
  const selectedRequirement = authorization.capability ? selectRequirement(paymentRequired, authorization.capability) : undefined;
  if (authorization.capability && selectedRequirement && requesterProof) {
    await insertPaymentAudit(env, {
      paymentId: crypto.randomUUID(),
      authorizationId: authorization.authRequestId ?? null,
      capabilityHash,
      owner: authorization.owner,
      selectedRequirement,
      amountDecimal: null,
      resourceUrl: paymentRequired.resource?.url ?? targetUrl,
      requesterProof,
    });
  }
  const payment = await createPayment(env, paymentRequired, authorization, selectedRequirement);
  const retryHeaders = new Headers(headers);
  for (const [key, value] of Object.entries(payment.headers)) {
    retryHeaders.set(key, value);
  }

  const retry = await fetch(targetUrl, {
    method,
    headers: retryHeaders,
    body: requestBody,
  });

  return copyResponse(retry);
}

async function createPayment(
  env: Env,
  paymentRequired: PaymentRequired,
  authorization: VerifiedAuthorization,
  preselectedRequirement?: PaymentRequirements,
): Promise<{
  headers: Record<string, string>;
  paymentPayload: unknown;
}> {
  if (authorization.paymentRequirementHash) {
    const actualHash = await hashJson(paymentRequired);
    if (actualHash !== authorization.paymentRequirementHash) {
      throw new HttpError(403, "payment_requirement_hash_mismatch", "Payment requirement does not match the SIWE authorization.");
    }
  }
  if (!authorization.capability) {
    throw new HttpError(403, "missing_autopay_capability", "Payment authorization must include an autopay capability.");
  }

  const payerWallet = await getPayerWalletForOwner(env, authorization.owner);
  const selectedRequirement = preselectedRequirement ?? selectRequirement(paymentRequired, authorization.capability);
  const filteredPaymentRequired: PaymentRequired = {
    ...paymentRequired,
    accepts: [selectedRequirement],
  };

  const signer = privateKeyToAccount(payerWallet.privateKey);
  const client = new x402Client();
  registerExactEvmScheme(client, {
    signer,
    networks: [authorization.capability.network],
  });
  const httpClient = new x402HTTPClient(client);
  let paymentPayload: Awaited<ReturnType<x402HTTPClient["createPaymentPayload"]>>;
  try {
    paymentPayload = await httpClient.createPaymentPayload(filteredPaymentRequired);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Payment payload could not be created.";
    throw new HttpError(400, "payment_payload_creation_failed", message);
  }
  const headers = httpClient.encodePaymentSignatureHeader(paymentPayload);

  return {
    headers,
    paymentPayload,
  };
}

type VerifiedAuthorization = {
  owner: Address;
  siwe: SiweMessage;
  capability?: AutopayCapability;
  authRequestId?: string;
  paymentRequirementHash?: string;
  loginRequestId?: string;
};

type VerifyAuthorizationOptions = {
  expectedOrigin?: string;
  requireCapability?: boolean;
};

async function verifyAuthorization(
  request: Request,
  env: Env,
  input: AuthorizationInput,
  options: VerifyAuthorizationOptions = {},
): Promise<VerifiedAuthorization> {
  const siweMessage = requireString(input.siweMessage ?? input.siwe_message, "siwe_message");
  const siweSignature = requireString(input.siweSignature ?? input.siwe_signature, "siwe_signature") as Hex;
  let parsed: SiweMessage;
  try {
    parsed = new SiweMessage(siweMessage);
  } catch {
    throw new HttpError(400, "invalid_siwe_message", "SIWE message is invalid. It must use the standard multi-line SIWE format.");
  }
  const now = new Date();

  const requestUrl = new URL(options.expectedOrigin ?? request.url);
  if (parsed.domain !== requestUrl.host) {
    throw new HttpError(403, "siwe_domain_mismatch", "SIWE domain does not match this worker.");
  }

  const siweUri = new URL(parsed.uri);
  if (siweUri.origin !== requestUrl.origin) {
    throw new HttpError(403, "siwe_uri_mismatch", "SIWE URI does not match this worker.");
  }

  if (!parsed.expirationTime) {
    throw new HttpError(403, "siwe_expiration_required", "SIWE message must include an expiration time.");
  }
  if (new Date(parsed.expirationTime) <= now) {
    throw new HttpError(403, "siwe_expired", "SIWE authorization has expired.");
  }
  if (parsed.notBefore && new Date(parsed.notBefore) > now) {
    throw new HttpError(403, "siwe_not_yet_valid", "SIWE authorization is not valid yet.");
  }

  const owner = getAddress(parsed.address);
  if (!(await isKnownOwner(env, owner))) {
    throw new HttpError(403, "owner_not_allowed", "SIWE signer is not allowed to authorize this worker.");
  }

  const signatureValid = await verifyMessage({
    address: owner,
    message: siweMessage,
    signature: siweSignature,
  });
  if (!signatureValid) {
    throw new HttpError(403, "invalid_siwe_signature", "SIWE signature is invalid.");
  }

  const capability = options.requireCapability === false ? extractOptionalCapability(parsed) : extractCapability(parsed);
  if (capability) {
    validateCapabilityTime(capability, now);
    const expectedChainId = chainIdFromNetwork(capability.network);
    if (expectedChainId !== parsed.chainId) {
      throw new HttpError(403, "siwe_chain_mismatch", "SIWE chain ID does not match the capability network.");
    }
  }

  return {
    owner,
    siwe: parsed,
    capability,
    authRequestId: extractResourceValue(parsed, AUTH_REQUEST_PREFIX),
    paymentRequirementHash: extractResourceValue(parsed, PAYMENT_REQUIREMENT_PREFIX),
    loginRequestId: extractResourceValue(parsed, LOGIN_PREFIX),
  };
}

function extractCapability(siwe: SiweMessage): AutopayCapability {
  const resource = (siwe.resources ?? []).find((item) => item.startsWith(CAPABILITY_PREFIX));
  if (!resource) {
    throw new HttpError(403, "missing_autopay_capability", "SIWE message does not include an autopay capability resource.");
  }

  const encoded = resource.slice(CAPABILITY_PREFIX.length);
  let parsed: unknown;
  try {
    parsed = JSON.parse(base64UrlDecode(encoded));
  } catch {
    throw new HttpError(400, "invalid_autopay_capability", "Autopay capability resource is not valid base64url JSON.");
  }

  return normalizeCapability(parsed);
}

function extractOptionalCapability(siwe: SiweMessage): AutopayCapability | undefined {
  return (siwe.resources ?? []).some((item) => item.startsWith(CAPABILITY_PREFIX))
    ? extractCapability(siwe)
    : undefined;
}

function normalizeCapability(value: unknown, defaultValidBefore?: string, requester?: RequesterBinding): AutopayCapability {
  if (!value || typeof value !== "object") {
    throw new HttpError(400, "invalid_autopay_capability", "Autopay capability must be a JSON object.");
  }
  const input = value as Partial<AutopayCapability>;
  const validBefore = normalizeValidBefore(input.validBefore, defaultValidBefore ? new Date(defaultValidBefore) : undefined);
  const requesterBinding = requester ?? (input.requester ? normalizeRequester(input.requester) : undefined);
  return {
    ...(requesterBinding ? { requester: requesterBinding } : {}),
    allowedOrigins: requireStringArray(input.allowedOrigins, "allowedOrigins").map((origin) => new URL(origin).origin),
    allowedPayTo: requireStringArray(input.allowedPayTo, "allowedPayTo").map((address) => getAddress(address)),
    network: requireString(input.network, "network") as Network,
    asset: getAddress(requireString(input.asset, "asset")),
    maxSingleAmount: requireUintString(input.maxSingleAmount, "maxSingleAmount"),
    totalBudget: requireUintString(input.totalBudget, "totalBudget"),
    validBefore,
  };
}

function normalizeRequester(value: unknown): RequesterBinding {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new HttpError(400, "missing_requester", "Payment authorization requires requester wallet metadata.");
  }
  const input = value as Partial<RequesterBinding> & { client_id?: unknown };
  const origin = new URL(requireString(input.origin, "requester.origin")).origin;
  const account = requireString(input.account, "requester.account");
  parseRequesterAccount(account);
  return {
    name: typeof input.name === "string" && input.name.trim() ? input.name.trim().slice(0, 80) : undefined,
    origin,
    account,
  };
}

function canonicalRequester(requester: RequesterBinding): Record<string, unknown> {
  return {
    name: requester.name,
    origin: requester.origin,
    account: requester.account,
  };
}

/** Compute a canonical SHA-256 hash of an AutopayCapability. */
async function hashCapability(capability: AutopayCapability): Promise<string> {
  const canonical = canonicalJson({
    requester: capability.requester ? canonicalRequester(capability.requester) : undefined,
    allowedOrigins: capability.allowedOrigins.slice().sort(),
    allowedPayTo: capability.allowedPayTo.map(normalizeAddress).sort(),
    network: capability.network,
    asset: normalizeAddress(capability.asset),
    maxSingleAmount: capability.maxSingleAmount,
    totalBudget: capability.totalBudget,
    validBefore: capability.validBefore,
  });
  const encoder = new TextEncoder();
  const data = encoder.encode(canonical);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

async function verifyRequesterProof(
  request: Request,
  capability: AutopayCapability,
  bodyText: string,
  capabilityHash: string,
): Promise<RequesterProof> {
  if (!capability.requester) {
    throw new HttpError(403, "missing_requester", "Autopay capability is not bound to a requester wallet.");
  }
  const requester = capability.requester;
  const accountHeader = requireHeader(request, "x-requester-account");
  if (accountHeader !== requester.account) {
    throw new HttpError(403, "requester_mismatch", "Requester account does not match the autopay capability.");
  }
  const { network, address } = parseRequesterAccount(requester.account);
  const issuedAt = requireUintHeader(request, "x-requester-issued-at");
  const expiresAt = requireUintHeader(request, "x-requester-expires-at");
  const now = Math.floor(Date.now() / 1000);
  if (issuedAt > now + 60) {
    throw new HttpError(403, "requester_proof_not_yet_valid", "Requester proof issuedAt is in the future.");
  }
  if (expiresAt <= now) {
    throw new HttpError(403, "requester_proof_expired", "Requester proof has expired.");
  }
  if (expiresAt - issuedAt > 300) {
    throw new HttpError(403, "requester_proof_ttl_too_long", "Requester proof expiration is too far in the future.");
  }

  const url = new URL(request.url);
  const nonce = requireHeader(request, "x-requester-nonce");
  const valid = await verifyTypedData({
    address,
    domain: {
      name: REQUESTER_PROOF_DOMAIN_NAME,
      version: REQUESTER_PROOF_VERSION,
      chainId: chainIdFromNetwork(network as Network),
    },
    types: REQUESTER_PROOF_TYPES,
    primaryType: "AutopayPaymentRequest",
    message: {
      worker: url.origin,
      path: url.pathname,
      bodyHash: `0x${await sha256Hex(bodyText)}` as Hex,
      capabilityHash: `0x${capabilityHash}` as Hex,
      nonce,
      issuedAt: BigInt(issuedAt),
      expiresAt: BigInt(expiresAt),
    },
    signature: requireHeader(request, "x-requester-signature") as Hex,
  });
  if (!valid) {
    throw new HttpError(403, "invalid_requester_signature", "Requester EIP-712 signature is invalid.");
  }
  return {
    account: requester.account,
    nonce,
    issuedAt,
    expiresAt,
    signature: requireHeader(request, "x-requester-signature") as Hex,
  };
}

async function insertPaymentAudit(
  env: Env,
  input: {
    paymentId: string;
    authorizationId: string | null;
    capabilityHash: string;
    owner: Address;
    selectedRequirement: PaymentRequirements;
    amountDecimal: string | null;
    resourceUrl: string;
    requesterProof: RequesterProof;
  },
): Promise<void> {
  try {
    await env.DB.prepare(
      `INSERT INTO autopay_payments
       (id, authorization_id, capability_hash, owner, network, asset, pay_to, amount, amount_decimal, currency, resource_url, requester_account, requester_nonce, requester_proof_expires_at, requester_signature, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(
      input.paymentId,
      input.authorizationId,
      input.capabilityHash,
      input.owner,
      input.selectedRequirement.network,
      input.selectedRequirement.asset,
      input.selectedRequirement.payTo,
      input.selectedRequirement.amount,
      input.amountDecimal,
      paymentRequirementCurrency(input.selectedRequirement),
      input.resourceUrl,
      input.requesterProof.account,
      input.requesterProof.nonce,
      new Date(input.requesterProof.expiresAt * 1000).toISOString(),
      input.requesterProof.signature,
      "created",
      new Date().toISOString(),
    ).run();
  } catch (err) {
    console.error("Failed to insert autopay_payments", err);
    throw new HttpError(409, "requester_proof_replayed", "Requester proof nonce has already been used.");
  }
}

function paymentRequirementCurrency(requirement: PaymentRequirements): string {
  const extraCurrency = (requirement as { extra?: Record<string, unknown> })
    .extra?.currency;
  if (typeof extraCurrency === "string" && extraCurrency.trim()) {
    return extraCurrency.trim().toUpperCase();
  }
  if (
    requirement.network === "eip155:8453" &&
    requirement.asset.toLowerCase() ===
      "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913"
  ) {
    return "USDC";
  }
  if (
    requirement.network === "eip155:8453" &&
    requirement.asset.toLowerCase() ===
      "0xfde4c96c8593536e31f229ea8f37b2adac255bb2"
  ) {
    return "USDT";
  }
  return "TOKEN";
}

function inferPolicyFromPaymentRequirement(env: Env, paymentRequired: PaymentRequired | undefined, validBefore: string): AutopayCapability {
  if (!paymentRequired) {
    throw new HttpError(400, "missing_policy", "policy is required when paymentRequired is not provided.");
  }
  const requirement = selectCheapestExactRequirement(paymentRequired);
  return {
    allowedOrigins: [],
    allowedPayTo: [getAddress(requirement.payTo)],
    network: requirement.network as Network,
    asset: getAddress(requirement.asset),
    maxSingleAmount: requireUintString(requirement.amount, "amount"),
    totalBudget: requireUintString(requirement.amount, "amount"),
    validBefore,
  };
}

function selectRequirement(paymentRequired: PaymentRequired, capability: AutopayCapability): PaymentRequirements {
  const matches = paymentRequired.accepts.filter((requirement) => requirementAllowed(requirement, capability));
  if (matches.length === 0) {
    throw new HttpError(402, "payment_not_allowed", "No payment requirement is allowed by SIWE capability.");
  }

  return matches.sort((a, b) => bigintCompare(BigInt(a.amount), BigInt(b.amount)))[0];
}

function selectCheapestExactRequirement(paymentRequired: PaymentRequired): PaymentRequirements {
  const matches = paymentRequired.accepts.filter((requirement) => requirement.scheme === "exact");
  if (matches.length === 0) {
    throw new HttpError(400, "unsupported_payment_requirement", "Payment requirement must include an exact EVM option.");
  }
  return matches.sort((a, b) => bigintCompare(BigInt(a.amount), BigInt(b.amount)))[0];
}

function validateCapabilityAllowsPayment(capability: AutopayCapability, paymentRequired?: PaymentRequired): void {
  if (!paymentRequired) return;
  validateCapabilityTime(capability, new Date());
  selectRequirement(paymentRequired, capability);
}

function validateCapabilityTime(capability: AutopayCapability, now: Date): void {
  if (new Date(capability.validBefore).getTime() <= now.getTime()) {
    throw new HttpError(403, "autopay_policy_expired", "Autopay policy has expired.");
  }
}

function requirementAllowed(requirement: PaymentRequirements, capability: AutopayCapability): boolean {
  if (requirement.scheme !== "exact") return false;
  if (requirement.network !== capability.network) return false;
  if (normalizeAddress(requirement.asset) !== normalizeAddress(capability.asset)) return false;
  if (!capability.allowedPayTo.map(normalizeAddress).includes(normalizeAddress(requirement.payTo))) return false;
  if (BigInt(requirement.amount) > BigInt(capability.maxSingleAmount)) return false;
  return true;
}

function normalizePaymentRequired(value: unknown): PaymentRequired {
  if (!value || typeof value !== "object") {
    throw new HttpError(400, "invalid_payment_required", "Payment required body must be an object.");
  }
  const candidate = value as Partial<PaymentRequired>;
  if (typeof candidate.x402Version !== "number") {
    throw new HttpError(400, "invalid_payment_required", "x402Version is required.");
  }
  if (!candidate.resource || typeof candidate.resource !== "object" || typeof candidate.resource.url !== "string") {
    throw new HttpError(400, "invalid_payment_required", "resource.url is required.");
  }
  if (!Array.isArray(candidate.accepts)) {
    throw new HttpError(400, "invalid_payment_required", "accepts must be an array.");
  }
  return candidate as PaymentRequired;
}

async function parsePaymentRequiredResponse(response: Response): Promise<PaymentRequired> {
  const text = await response.text();
  let body: unknown = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    throw new HttpError(400, "invalid_402_response", "402 response body is not valid JSON.");
  }
  return normalizePaymentRequired((body as Record<string, unknown>)?.paymentRequired ?? (body as Record<string, unknown>)?.payment_required ?? body);
}

function getAdminOwner(env: Env): Address | null {
  return env.AUTOPAY_ADMIN_OWNER?.trim()
    ? getAddress(env.AUTOPAY_ADMIN_OWNER.trim())
    : null;
}

function isAdminOwner(env: Env, owner: string): boolean {
  const adminOwner = getAdminOwner(env);
  return Boolean(adminOwner && normalizeAddress(adminOwner) === normalizeAddress(owner));
}

async function isKnownOwner(env: Env, owner: Address): Promise<boolean> {
  return isAdminOwner(env, owner) || Boolean(await getAccountWallet(env, owner));
}

function normalizeProxyHeaders(value: unknown): Headers {
  const headers = new Headers();
  if (!value) return headers;
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new HttpError(400, "invalid_headers", "headers must be an object.");
  }
  for (const [key, raw] of Object.entries(value)) {
    if (typeof raw !== "string") {
      throw new HttpError(400, "invalid_headers", "header values must be strings.");
    }
    const lower = key.toLowerCase();
    if (lower === "host" || lower === "content-length" || lower === "authorization") continue;
    headers.set(key, raw);
  }
  return headers;
}

function sameCapability(a: AutopayCapability, b: AutopayCapability): boolean {
  return a.network === b.network
    && normalizeAddress(a.asset) === normalizeAddress(b.asset)
    && a.maxSingleAmount === b.maxSingleAmount
    && a.totalBudget === b.totalBudget
    && a.validBefore === b.validBefore
    && sameRequester(a.requester, b.requester)
    && sameStringSet(a.allowedOrigins, b.allowedOrigins)
    && sameStringSet(a.allowedPayTo.map(normalizeAddress), b.allowedPayTo.map(normalizeAddress));
}

function sameRequester(a: RequesterBinding | undefined, b: RequesterBinding | undefined): boolean {
  if (!a || !b) return a === b;
  return a.origin === b.origin && a.account === b.account && (a.name ?? "") === (b.name ?? "");
}

function sameStringSet(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const right = new Set(b);
  return a.every((item) => right.has(item));
}

function publicAuthRecord(record: AuthRequestRecord): Record<string, unknown> {
  return {
    request_id: record.requestId,
    status: record.status,
    kind: record.kind,
    policy: record.policy,
    payment_requirement_hash: record.paymentRequirementHash,
    return_origin: record.returnOrigin,
    network: record.network,
    nonce: record.nonce,
    created_at: record.createdAt,
    expires_at: record.expiresAt,
    resources: resourcesForRecord(record),
  };
}

function resourcesForRecord(record: AuthRequestRecord): string[] {
  const resources = [AUTH_REQUEST_PREFIX + record.requestId];
  if (record.kind === "login") {
    resources.unshift(LOGIN_PREFIX + record.requestId);
    return resources;
  }
  if (!record.policy) {
    throw new HttpError(500, "invalid_auth_record", "Payment authorization record is missing policy.");
  }
  resources.unshift(CAPABILITY_PREFIX + base64UrlEncode(JSON.stringify(record.policy)));
  if (record.paymentRequirementHash) {
    resources.push(PAYMENT_REQUIREMENT_PREFIX + record.paymentRequirementHash);
  }
  return resources;
}

function normalizeNetwork(value: unknown): Network {
  if (value == null || value === "") return DEFAULT_NETWORK;
  const network = requireString(value, "network") as Network;
  chainIdFromNetwork(network);
  return network;
}

function normalizeOptionalOrigin(value: unknown): string | undefined {
  if (value == null || value === "") return undefined;
  return new URL(requireString(value, "return_origin")).origin;
}

function normalizeTtlSeconds(value: unknown): number {
  if (value == null || value === "") return DEFAULT_AUTH_TTL_SECONDS;
  const ttl = typeof value === "number" ? value : Number(requireString(value, "ttl_seconds"));
  if (!Number.isSafeInteger(ttl) || ttl <= 0 || ttl > MAX_AUTH_TTL_SECONDS) {
    throw new HttpError(400, "invalid_ttl", `ttl_seconds must be an integer between 1 and ${MAX_AUTH_TTL_SECONDS}.`);
  }
  return ttl;
}

function normalizeValidBefore(value: unknown, fallback?: Date): string {
  if (value == null || value === "") {
    if (!fallback) {
      throw new HttpError(400, "missing_valid_before", "Autopay policy validBefore is required.");
    }
    return fallback.toISOString();
  }
  const text = requireString(value, "validBefore");
  const date = new Date(text);
  if (!Number.isFinite(date.getTime())) {
    throw new HttpError(400, "invalid_valid_before", "validBefore must be an ISO timestamp.");
  }
  if (date.getTime() <= Date.now()) {
    throw new HttpError(400, "invalid_valid_before", "validBefore must be in the future.");
  }
  return date.toISOString();
}

function normalizeHash(value: string): string {
  const text = value.trim().toLowerCase();
  if (!/^0x[0-9a-f]{64}$/.test(text)) {
    throw new HttpError(400, "invalid_payment_requirement_hash", "paymentRequirementHash must be a 32-byte hex string.");
  }
  return text;
}

function normalizeAddress(value: string): string {
  try {
    return getAddress(value).toLowerCase();
  } catch {
    return value.toLowerCase();
  }
}

function parseRequesterAccount(account: string): { network: string; address: Address } {
  const parts = account.split(":");
  if (parts.length !== 3 || parts[0] !== "eip155") {
    throw new HttpError(400, "invalid_requester_account", "requester.account must be a CAIP-10 EIP-155 account.");
  }
  const network = `${parts[0]}:${parts[1]}`;
  chainIdFromNetwork(network as Network);
  return {
    network,
    address: getAddress(parts[2]),
  };
}

function chainIdFromNetwork(network: Network): number {
  const [namespace, reference] = network.split(":");
  if (namespace !== "eip155") {
    throw new HttpError(400, "unsupported_network", "Only EVM eip155 networks are supported.");
  }
  const chainId = Number(reference);
  if (!Number.isSafeInteger(chainId) || chainId <= 0) {
    throw new HttpError(400, "invalid_network", "Network must include a valid EIP-155 chain ID.");
  }
  return chainId;
}

function extractResourceValue(siwe: SiweMessage, prefix: string): string | undefined {
  const resource = (siwe.resources ?? []).find((item) => item.startsWith(prefix));
  return resource ? resource.slice(prefix.length) : undefined;
}

function base64UrlEncode(value: string): string {
  return base64UrlEncodeBytes(new TextEncoder().encode(value));
}

function base64UrlEncodeBytes(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function base64UrlDecode(value: string): string {
  return new TextDecoder().decode(base64UrlDecodeBytes(value));
}

function base64UrlDecodeText(value: string): string {
  return new TextDecoder().decode(base64UrlDecodeBytes(value));
}

function base64UrlDecodeBytes(value: string): Uint8Array {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized.padEnd(normalized.length + ((4 - normalized.length % 4) % 4), "=");
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

function bigintCompare(a: bigint, b: bigint): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

function isExpired(record: AuthRequestRecord): boolean {
  return new Date(record.expiresAt).getTime() <= Date.now();
}

function randomSiweNonce(): string {
  return randomToken(12).replace(/[^a-zA-Z0-9]/g, "").slice(0, 16).padEnd(8, "0");
}

function randomToken(byteLength: number): string {
  const bytes = new Uint8Array(byteLength);
  crypto.getRandomValues(bytes);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

async function hashJson(value: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(canonicalJson(value));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return `0x${Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

async function sha256Hex(value: string): Promise<string> {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function canonicalJson(value: unknown): string {
  if (value == null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, item]) => item !== undefined)
    .sort(([a], [b]) => a.localeCompare(b));
  return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(",")}}`;
}

async function readJsonObject(request: Request): Promise<Record<string, unknown>> {
  try {
    const value = await request.json();
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new HttpError(400, "invalid_json", "Request body must be a JSON object.");
    }
    return value as Record<string, unknown>;
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw new HttpError(400, "invalid_json", "Request body must be valid JSON.");
  }
}

function parseJsonObject(text: string): Record<string, unknown> {
  try {
    const value = JSON.parse(text);
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new HttpError(400, "invalid_json", "Request body must be a JSON object.");
    }
    return value as Record<string, unknown>;
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw new HttpError(400, "invalid_json", "Request body must be valid JSON.");
  }
}

function requirePrivateKey(env: Env): Hex {
  const key = env.AUTOPAY_ADMIN_PRIVATE_KEY;
  if (!key || !/^0x[0-9a-fA-F]{64}$/.test(key)) {
    throw new HttpError(500, "missing_private_key", "AUTOPAY_ADMIN_PRIVATE_KEY is not configured.");
  }
  return key as Hex;
}

async function getPayerWalletForOwner(env: Env, owner: Address): Promise<PayerWallet> {
  const accountWallet = await getAccountWallet(env, owner);
  if (accountWallet) {
    return {
      privateKey: await decryptPrivateKey(env, accountWallet.encryptedPrivateKey),
    };
  }

  if (isAdminOwner(env, owner)) {
    return { privateKey: requirePrivateKey(env) };
  }
  throw new HttpError(403, "payer_wallet_not_found", "No payer wallet is configured for this owner.");
}

function getDefaultPayerWallet(env: Env): PayerWallet | null {
  try {
    return { privateKey: requirePrivateKey(env) };
  } catch (error) {
    if (error instanceof HttpError && error.code === "missing_private_key") return null;
    throw error;
  }
}

function parsePrivateKey(value: unknown, field: string): Hex {
  if (typeof value !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(value)) {
    throw new HttpError(400, "invalid_private_key", `${field} must be a valid EVM private key.`);
  }
  return value as Hex;
}

function parseOptionalAddress(value: unknown): Address | null {
  if (value == null || value === "") return null;
  return parseAddress(value, "owner");
}

function parseAddress(value: unknown, field: string): Address {
  if (typeof value !== "string" || !/^0x[a-fA-F0-9]{40}$/.test(value)) {
    throw new HttpError(400, "invalid_address", `${field} must be a valid EVM address.`);
  }
  return getAddress(value);
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new HttpError(400, "missing_field", `${field} is required.`);
  }
  return value.trim();
}

function requireHeader(request: Request, name: string): string {
  const value = request.headers.get(name);
  if (!value || !value.trim()) {
    throw new HttpError(403, "missing_requester_proof", `${name} header is required.`);
  }
  return value.trim();
}

function requireUintHeader(request: Request, name: string): number {
  const value = Number(requireHeader(request, name));
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new HttpError(403, "invalid_requester_proof", `${name} must be a positive integer.`);
  }
  return value;
}

function requireStringArray(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || !item.trim())) {
    throw new HttpError(400, "missing_field", `${field} must be a string array.`);
  }
  return value.map((item) => item.trim());
}

function requireUintString(value: unknown, field: string): string {
  const text = requireString(value, field);
  if (!/^\d+$/.test(text)) {
    throw new HttpError(400, "invalid_field", `${field} must be an unsigned integer string.`);
  }
  return text;
}

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body, null, 2), {
    ...init,
    headers: {
      ...JSON_HEADERS,
      ...CORS_HEADERS,
      ...(init.headers ?? {}),
    },
  });
}

function errorResponse(status: number, code: string, message: string): Response {
  return jsonResponse({
    error: {
      code,
      message,
      details: {},
    },
  }, { status });
}

function copyResponse(response: Response): Response {
  const headers = new Headers(response.headers);
  headers.set("access-control-allow-origin", "*");
  headers.set("access-control-expose-headers", "x-payment-response");
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

/* ─── Session helpers ─── */

const SESSION_COOKIE_NAME = "autopay_session";
const SESSION_TTL_SECONDS = 24 * 60 * 60;

type DashboardSession = {
  owner: Address;
  expires_at: number;
};

function parseCookieHeader(request: Request): Record<string, string> {
  const cookie = request.headers.get("cookie");
  if (!cookie) return {};
  const entries: Record<string, string> = {};
  for (const part of cookie.split(";")) {
    const [name, ...rest] = part.trim().split("=");
    if (name && rest.length > 0) {
      entries[decodeURIComponent(name.trim())] = decodeURIComponent(rest.join("=").trim());
    }
  }
  return entries;
}

async function getSessionOwner(request: Request, env: Env): Promise<string | null> {
  const cookies = parseCookieHeader(request);
  const token = cookies[SESSION_COOKIE_NAME];
  if (!token) return null;
  try {
    const session = await verifyDashboardSession(env, token);
    return session.owner;
  } catch (error) {
    if (error instanceof HttpError && error.status >= 500) throw error;
    return null;
  }
}

async function requireSession(request: Request, env: Env): Promise<string> {
  const owner = await getSessionOwner(request, env);
  if (!owner) {
    throw new HttpError(401, "session_required", "Sign in to access this resource.");
  }
  return owner;
}

function setSessionCookie(token: string, maxAgeSeconds = SESSION_TTL_SECONDS): string {
  const parts = [
    `${encodeURIComponent(SESSION_COOKIE_NAME)}=${encodeURIComponent(token)}`,
    "Path=/",
    `Max-Age=${maxAgeSeconds}`,
    "HttpOnly",
    "Secure",
    "SameSite=Lax",
  ];
  return parts.join("; ");
}

function clearSessionCookie(): string {
  const parts = [
    `${encodeURIComponent(SESSION_COOKIE_NAME)}=`,
    "Path=/",
    "Max-Age=0",
    "HttpOnly",
    "Secure",
    "SameSite=Lax",
  ];
  return parts.join("; ");
}

async function createSession(env: Env, owner: string): Promise<string> {
  return signDashboardSession(env, {
    owner: getAddress(owner),
    expires_at: Date.now() + SESSION_TTL_SECONDS * 1000,
  });
}

async function signDashboardSession(env: Env, state: DashboardSession): Promise<string> {
  const payload = base64UrlEncode(canonicalJson(state));
  const signature = await hmacSha256Base64Url(requireSessionSecret(env), payload);
  return `${payload}.${signature}`;
}

async function verifyDashboardSession(env: Env, token: string): Promise<DashboardSession> {
  const [payload, signature, extra] = token.split(".");
  if (!payload || !signature || extra != null) {
    throw new HttpError(401, "invalid_session", "Session is invalid.");
  }
  const expected = await hmacSha256Base64Url(requireSessionSecret(env), payload);
  if (!constantTimeEqual(signature, expected)) {
    throw new HttpError(401, "invalid_session_signature", "Session signature is invalid.");
  }
  const parsed = JSON.parse(base64UrlDecodeText(payload)) as Record<string, unknown>;
  const expiresAt = typeof parsed.expires_at === "number" ? parsed.expires_at : 0;
  if (!Number.isFinite(expiresAt) || expiresAt <= Date.now()) {
    throw new HttpError(401, "session_expired", "Session has expired.");
  }
  return {
    owner: parseAddress(parsed.owner, "owner"),
    expires_at: expiresAt,
  };
}

function requireSessionSecret(env: Env): string {
  return requireAutopaySecret(env);
}

async function hmacSha256Base64Url(secret: string, value: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(value));
  return base64UrlEncodeBytes(new Uint8Array(signature));
}

function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let index = 0; index < a.length; index += 1) {
    diff |= a.charCodeAt(index) ^ b.charCodeAt(index);
  }
  return diff === 0;
}

async function ensureAccountTable(env: Env): Promise<void> {
  await env.DB.prepare(`
    CREATE TABLE IF NOT EXISTS autopay_accounts (
      owner TEXT PRIMARY KEY,
      autopay_wallet_address TEXT NOT NULL,
      encrypted_autopay_private_key TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `).run();
}

async function getAccountWallet(env: Env, owner: Address): Promise<AccountWallet | null> {
  await ensureAccountTable(env);
  const row = await env.DB.prepare(
    `SELECT owner, autopay_wallet_address, encrypted_autopay_private_key, created_at, updated_at
     FROM autopay_accounts
     WHERE owner = ?`
  ).bind(getAddress(owner)).first<{
    owner: string;
    autopay_wallet_address: string;
    encrypted_autopay_private_key: string;
    created_at: string;
    updated_at: string;
  }>();
  if (!row) return null;
  return {
    owner: getAddress(row.owner),
    autopayWalletAddress: getAddress(row.autopay_wallet_address),
    encryptedPrivateKey: row.encrypted_autopay_private_key,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

async function listAccountWallets(env: Env): Promise<Array<{
  owner: Address;
  autopay_wallet_address: Address;
  created_at: string;
  updated_at: string;
}>> {
  await ensureAccountTable(env);
  const { results } = await env.DB.prepare(
    `SELECT owner, autopay_wallet_address, created_at, updated_at
     FROM autopay_accounts
     ORDER BY updated_at DESC`
  ).all<{
    owner: string;
    autopay_wallet_address: string;
    created_at: string;
    updated_at: string;
  }>();
  return (results ?? []).map((row) => ({
    owner: getAddress(row.owner),
    autopay_wallet_address: getAddress(row.autopay_wallet_address),
    created_at: row.created_at,
    updated_at: row.updated_at,
  }));
}

async function saveAccountWallet(env: Env, owner: Address, privateKey: Hex): Promise<AccountWallet> {
  await ensureAccountTable(env);
  const autopayWalletAddress = privateKeyToAccount(privateKey).address;
  const encryptedPrivateKey = await encryptPrivateKey(env, privateKey);
  const now = new Date().toISOString();
  await env.DB.prepare(
    `INSERT INTO autopay_accounts
      (owner, autopay_wallet_address, encrypted_autopay_private_key, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(owner) DO UPDATE SET
      autopay_wallet_address = excluded.autopay_wallet_address,
      encrypted_autopay_private_key = excluded.encrypted_autopay_private_key,
      updated_at = excluded.updated_at`
  ).bind(getAddress(owner), autopayWalletAddress, encryptedPrivateKey, now, now).run();
  return {
    owner: getAddress(owner),
    autopayWalletAddress,
    encryptedPrivateKey,
    createdAt: now,
    updatedAt: now,
  };
}

async function encryptPrivateKey(env: Env, privateKey: Hex): Promise<string> {
  const iv = new Uint8Array(12);
  crypto.getRandomValues(iv);
  const key = await getAccountCryptoKey(env);
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    key,
    new TextEncoder().encode(privateKey),
  );
  return `v1.${base64UrlEncodeBytes(iv)}.${base64UrlEncodeBytes(new Uint8Array(ciphertext))}`;
}

async function decryptPrivateKey(env: Env, encryptedPrivateKey: string): Promise<Hex> {
  const [version, ivEncoded, ciphertextEncoded, extra] = encryptedPrivateKey.split(".");
  if (version !== "v1" || !ivEncoded || !ciphertextEncoded || extra != null) {
    throw new HttpError(500, "invalid_encrypted_private_key", "Stored autopay wallet key is invalid.");
  }
  const key = await getAccountCryptoKey(env);
  const iv = base64UrlDecodeBytes(ivEncoded);
  const ciphertext = base64UrlDecodeBytes(ciphertextEncoded);
  const plaintext = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: bytesToArrayBuffer(iv) },
    key,
    bytesToArrayBuffer(ciphertext),
  );
  return parsePrivateKey(new TextDecoder().decode(plaintext), "stored_private_key");
}

async function getAccountCryptoKey(env: Env): Promise<CryptoKey> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(requireAutopaySecret(env)));
  return crypto.subtle.importKey("raw", digest, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
}

function requireAutopaySecret(env: Env): string {
  const secret = env.AUTOPAY_SECRET;
  if (!secret || secret.length < 32) {
    throw new HttpError(500, "missing_autopay_secret", "AUTOPAY_SECRET must be configured with at least 32 characters.");
  }
  return secret;
}

function bytesToArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

/* ─── Auth endpoints ─── */

const LOGIN_STATEMENT = "Sign in to Meteria402 Autopay Dashboard";
const LOGIN_TTL_SECONDS = 300;

async function handleAuthChallenge(request: Request, _env: Env): Promise<Response> {
  const url = new URL(request.url);
  const nonce = randomSiweNonce();
  const issuedAt = new Date().toISOString();
  const expirationTime = new Date(Date.now() + LOGIN_TTL_SECONDS * 1000).toISOString();

  const siweMessage = new SiweMessage({
    domain: url.host,
    uri: url.origin,
    address: "0x0000000000000000000000000000000000000000",
    chainId: 8453,
    nonce,
    statement: LOGIN_STATEMENT,
    issuedAt,
    expirationTime,
    version: "1",
  }).prepareMessage();

  return jsonResponse({
    nonce,
    message: siweMessage,
    issued_at: issuedAt,
    expiration_time: expirationTime,
  });
}

async function handleAuthLogin(request: Request, env: Env): Promise<Response> {
  const body = await readJsonObject(request);
  const messageRaw = requireString(body.message ?? body.siwe_message, "message");
  const signatureRaw = requireString(body.signature ?? body.siwe_signature, "signature");

  let siwe: SiweMessage;
  try {
    siwe = new SiweMessage(messageRaw);
  } catch {
    throw new HttpError(400, "invalid_siwe", "Could not parse SIWE message.");
  }

  const url = new URL(request.url);
  if (siwe.domain !== url.host) {
    throw new HttpError(403, "domain_mismatch", "SIWE domain does not match this worker.");
  }
  if (siwe.uri !== url.origin) {
    throw new HttpError(403, "uri_mismatch", "SIWE URI does not match this worker.");
  }
  if (siwe.statement !== LOGIN_STATEMENT) {
    throw new HttpError(403, "statement_mismatch", "SIWE statement does not match expected login statement.");
  }
  if (siwe.expirationTime && new Date(siwe.expirationTime) < new Date()) {
    throw new HttpError(403, "challenge_expired", "Login challenge has expired. Please request a new one.");
  }

  const valid = await verifyMessage({
    address: getAddress(siwe.address),
    message: messageRaw,
    signature: signatureRaw as Hex,
  });
  if (!valid) {
    throw new HttpError(403, "invalid_signature", "SIWE signature is invalid.");
  }

  const owner = getAddress(siwe.address);
  if (!(await isKnownOwner(env, owner))) {
    throw new HttpError(403, "owner_not_allowed", "This wallet address is not configured.");
  }

  const token = await createSession(env, owner);
  const headers = new Headers(JSON_HEADERS);
  for (const [key, value] of Object.entries(CORS_HEADERS)) {
    headers.set(key, value);
  }
  headers.set("Set-Cookie", setSessionCookie(token));

  return new Response(JSON.stringify({
    ok: true,
    owner,
  }), { status: 200, headers });
}

async function handleAuthLogout(request: Request, env: Env): Promise<Response> {
  const headers = new Headers(JSON_HEADERS);
  for (const [key, value] of Object.entries(CORS_HEADERS)) {
    headers.set(key, value);
  }
  headers.set("Set-Cookie", clearSessionCookie());
  return new Response(JSON.stringify({ ok: true }), { status: 200, headers });
}

async function handleAuthMe(request: Request, env: Env): Promise<Response> {
  const owner = await getSessionOwner(request, env);
  return jsonResponse({
    authenticated: Boolean(owner),
    owner: owner ?? null,
    is_admin: owner ? isAdminOwner(env, owner) : false,
  });
}

async function handleAccountGet(request: Request, env: Env): Promise<Response> {
  const owner = getAddress(await requireSession(request, env));
  const account = await getAccountWallet(env, owner);
  return jsonResponse({
    owner,
    autopay_wallet_address: account?.autopayWalletAddress ?? null,
    autopay_wallet_configured: Boolean(account),
  });
}

async function handleAccountAutopayWalletUpdate(request: Request, env: Env): Promise<Response> {
  const owner = getAddress(await requireSession(request, env));
  const body = await readJsonObject(request);
  const privateKey = parsePrivateKey(body.privateKey ?? body.private_key, "private_key");
  const account = await saveAccountWallet(env, owner, privateKey);
  return jsonResponse({
    owner: account.owner,
    autopay_wallet_address: account.autopayWalletAddress,
    autopay_wallet_configured: true,
  });
}

async function requireAdminSession(request: Request, env: Env): Promise<Address> {
  const owner = getAddress(await requireSession(request, env));
  if (!isAdminOwner(env, owner)) {
    throw new HttpError(403, "admin_required", "Admin access is required.");
  }
  return owner;
}

async function handleAdminAccountsList(request: Request, env: Env): Promise<Response> {
  await requireAdminSession(request, env);
  return jsonResponse({
    accounts: await listAccountWallets(env),
  });
}

async function handleAdminAccountCreate(request: Request, env: Env): Promise<Response> {
  await requireAdminSession(request, env);
  const body = await readJsonObject(request);
  const owner = parseAddress(body.owner ?? body.owner_address ?? body.main_wallet_address, "owner");
  const privateKey = parsePrivateKey(body.privateKey ?? body.private_key ?? body.autopay_private_key, "autopay_private_key");
  const account = await saveAccountWallet(env, owner, privateKey);
  return jsonResponse({
    owner: account.owner,
    autopay_wallet_address: account.autopayWalletAddress,
    autopay_wallet_configured: true,
  }, { status: 201 });
}

/* ─── Audit endpoints (protected) ─── */

async function handleAuditAuthorizations(request: Request, env: Env): Promise<Response> {
  const sessionOwner = await requireSession(request, env);
  const url = new URL(request.url);
  const ownerParam = url.searchParams.get("owner");
  const statusParam = url.searchParams.get("status");
  const limit = Math.min(parseInt(url.searchParams.get("limit") ?? "50", 10), 200);
  const offset = parseInt(url.searchParams.get("offset") ?? "0", 10);

  const owner = ownerParam ?? sessionOwner;
  if (owner.toLowerCase() !== sessionOwner.toLowerCase()) {
    throw new HttpError(403, "access_denied", "You can only view your own authorization records.");
  }

  let sql = `SELECT * FROM autopay_authorizations WHERE owner = ?`;
  const params: (string | number)[] = [owner];
  if (statusParam) {
    sql += ` AND status = ?`;
    params.push(statusParam);
  }
  sql += ` ORDER BY created_at DESC LIMIT ? OFFSET ?`;
  params.push(limit, offset);

  const { results } = await env.DB.prepare(sql).bind(...params).all<{
    id: string;
    request_id: string;
    kind: string;
    owner: string | null;
    requester_origin: string | null;
    policy_network: string | null;
    policy_asset: string | null;
    policy_max_single_amount: string | null;
    policy_valid_before: string | null;
    status: string;
    created_at: string;
    approved_at: string | null;
    expires_at: string;
  }>();

  return jsonResponse({
    authorizations: results ?? [],
    limit,
    offset,
  });
}

async function handleAuditPayments(request: Request, env: Env): Promise<Response> {
  const sessionOwner = await requireSession(request, env);
  const url = new URL(request.url);
  const ownerParam = url.searchParams.get("owner");
  const statusParam = url.searchParams.get("status");
  const authorizationId = url.searchParams.get("authorization_id") ?? undefined;
  const limit = Math.min(parseInt(url.searchParams.get("limit") ?? "50", 10), 200);
  const offset = parseInt(url.searchParams.get("offset") ?? "0", 10);

  const owner = ownerParam ?? sessionOwner;
  if (owner.toLowerCase() !== sessionOwner.toLowerCase()) {
    throw new HttpError(403, "access_denied", "You can only view your own payment records.");
  }

  let sql = `SELECT p.*, a.requester_origin
             FROM autopay_payments p
             LEFT JOIN autopay_authorizations a
               ON a.id = p.authorization_id OR a.capability_hash = p.capability_hash
             WHERE p.owner = ?`;
  const params: (string | number)[] = [owner];
  if (statusParam) {
    sql += ` AND p.status = ?`;
    params.push(statusParam);
  }
  if (authorizationId) {
    sql += ` AND p.authorization_id = ?`;
    params.push(authorizationId);
  }
  sql += ` ORDER BY p.created_at DESC LIMIT ? OFFSET ?`;
  params.push(limit, offset);

  const { results } = await env.DB.prepare(sql).bind(...params).all<{
    id: string;
    authorization_id: string | null;
    owner: string;
    network: string | null;
    asset: string | null;
    pay_to: string | null;
    amount: string | null;
    amount_decimal: string | null;
    currency: string;
    resource_url: string | null;
    requester_origin: string | null;
    tx_hash: string | null;
    status: string;
    error_message: string | null;
    created_at: string;
    settled_at: string | null;
  }>();

  return jsonResponse({
    payments: results ?? [],
    limit,
    offset,
  });
}
