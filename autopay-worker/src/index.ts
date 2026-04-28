import { x402Client, x402HTTPClient } from "@x402/core/client";
import type { Network, PaymentRequired, PaymentRequirements } from "@x402/core/types";
import { registerExactEvmScheme } from "@x402/evm/exact/client";
import { SiweMessage } from "siwe";
import { getAddress, verifyMessage, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";

type Env = {
  AUTOPAY_PRIVATE_KEY?: string;
  AUTOPAY_ALLOWED_OWNERS?: string;
  AUTOPAY_AUTH_SESSIONS: DurableObjectNamespace;
};

type AutopayCapability = {
  allowedOrigins: string[];
  allowedPayTo: Address[];
  network: Network;
  asset: Address;
  maxSingleAmount: string;
  validBefore: string;
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
  status: "pending" | "approved" | "denied";
  workerOrigin: string;
  policy: AutopayCapability;
  paymentRequirementHash?: string;
  returnOrigin?: string;
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
  "access-control-allow-headers": "authorization,content-type,x-autopay-poll-token",
  "access-control-expose-headers": "x-payment-response",
};

const CAPABILITY_PREFIX = "urn:meter402:autopay:v1:";
const AUTH_REQUEST_PREFIX = "urn:meter402:auth-request:";
const PAYMENT_REQUIREMENT_PREFIX = "urn:meter402:payment-requirement:";
const DEFAULT_AUTH_TTL_SECONDS = 5 * 60;
const MAX_AUTH_TTL_SECONDS = 30 * 60;

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
          },
        });
      }

      if (request.method === "POST" && url.pathname === "/deny") {
        record.status = "denied";
        await this.ctx.storage.put("record", record);
        return jsonResponse({ status: record.status });
      }

      if (request.method === "POST" && url.pathname === "/approve") {
        if (record.status === "denied") {
          throw new HttpError(409, "auth_request_denied", "Authorization request has already been denied.");
        }
        const body = await readJsonObject(request);
        const authorization = await verifyAuthorization(request, this.env, body, {
          expectedOrigin: record.workerOrigin,
        });
        if (authorization.authRequestId !== record.requestId) {
          throw new HttpError(403, "auth_request_mismatch", "SIWE authorization is not bound to this request.");
        }
        if (record.paymentRequirementHash && authorization.paymentRequirementHash !== record.paymentRequirementHash) {
          throw new HttpError(403, "payment_requirement_hash_mismatch", "SIWE authorization is not bound to the requested payment requirement.");
        }
        if (!sameCapability(authorization.capability, record.policy)) {
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
    await this.ctx.storage.deleteAll();
  }

  private async getRecord(): Promise<AuthRequestRecord> {
    const record = await this.ctx.storage.get<AuthRequestRecord>("record");
    if (!record) {
      throw new HttpError(404, "auth_request_not_found", "Authorization request was not found.");
    }
    return record;
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
        return jsonResponse({ ok: true, service: "meter402-autopay-worker" });
      }

      if ((request.method === "GET" || request.method === "HEAD") && url.pathname === "/authorize") {
        const next = new URL("/", url.origin);
        for (const [key, value] of url.searchParams.entries()) {
          next.searchParams.set(key, value);
        }
        return Response.redirect(next.toString(), 302);
      }

      if (request.method === "GET" && url.pathname === "/api/capabilities") {
        return jsonResponse({
          authorization: "siwe_device_flow",
          capability_resource_prefix: CAPABILITY_PREFIX,
          auth_request_resource_prefix: AUTH_REQUEST_PREFIX,
          payment_requirement_resource_prefix: PAYMENT_REQUIREMENT_PREFIX,
          x402_networks: ["eip155:8453"],
          allowed_owner_addresses: getAllowedOwners(env),
          payer_address: privateKeyToAccount(requirePrivateKey(env)).address,
          storage: "durable_object",
        });
      }

      if (request.method === "POST" && url.pathname === "/api/auth/requests") {
        return await handleCreateAuthRequest(request, env);
      }

      const authRequestMatch = url.pathname.match(/^\/api\/auth\/requests\/([^/]+)(?:\/(details|poll|approve|deny))?$/);
      if (authRequestMatch) {
        const requestId = authRequestMatch[1];
        const action = authRequestMatch[2] ?? "details";
        return await forwardAuthSession(env, requestId, action, request);
      }

      if (request.method === "POST" && url.pathname === "/api/pay") {
        return await handlePay(request, env);
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
  const paymentRequiredInput = body.paymentRequired ?? body.payment_required;
  const paymentRequired = paymentRequiredInput == null ? undefined : normalizePaymentRequired(paymentRequiredInput);
  const paymentRequirementHash = typeof body.paymentRequirementHash === "string"
    ? normalizeHash(body.paymentRequirementHash)
    : typeof body.payment_requirement_hash === "string"
      ? normalizeHash(body.payment_requirement_hash)
      : paymentRequired
        ? await hashJson(paymentRequired)
        : undefined;

  const returnOrigin = normalizeOptionalOrigin(body.returnOrigin ?? body.return_origin);
  const ttlSeconds = normalizeTtlSeconds(body.ttlSeconds ?? body.ttl_seconds);
  const requestId = env.AUTOPAY_AUTH_SESSIONS.newUniqueId().toString();
  const pollToken = randomToken(32);
  const now = new Date();
  const expiresAt = new Date(now.getTime() + ttlSeconds * 1000);
  const policyValidBefore = normalizeValidBefore(body.policyValidBefore ?? body.policy_valid_before ?? body.validBefore ?? body.valid_before, expiresAt);

  const policy = normalizeCapability(body.policy ?? inferPolicyFromPaymentRequirement(env, paymentRequired, policyValidBefore), policyValidBefore);
  if (paymentRequirementHash) {
    validateCapabilityAllowsPayment(policy, paymentRequired);
  }

  const record: AuthRequestRecord = {
    requestId,
    pollToken,
    status: "pending",
    workerOrigin: requestUrl.origin,
    policy,
    paymentRequirementHash,
    returnOrigin,
    nonce: randomSiweNonce(),
    createdAt: now.toISOString(),
    expiresAt: expiresAt.toISOString(),
  };

  const stub = sessionStub(env, requestId);
  await stub.fetch("https://session/init", {
    method: "POST",
    headers: JSON_HEADERS,
    body: JSON.stringify(record),
  });

  const verification = new URL("/authorize", requestUrl.origin);
  verification.searchParams.set("request_id", requestId);

  return jsonResponse({
    request_id: requestId,
    poll_token: pollToken,
    verification_uri: `${requestUrl.origin}/authorize`,
    verification_uri_complete: verification.toString(),
    expires_in: ttlSeconds,
    interval: 2,
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

function sessionStub(env: Env, requestId: string): DurableObjectStub {
  let id: DurableObjectId;
  try {
    id = env.AUTOPAY_AUTH_SESSIONS.idFromString(requestId);
  } catch {
    throw new HttpError(400, "invalid_auth_request_id", "Authorization request ID is invalid.");
  }
  return env.AUTOPAY_AUTH_SESSIONS.get(id);
}

async function handlePay(request: Request, env: Env): Promise<Response> {
  const body = await readJsonObject(request);
  const paymentRequired = normalizePaymentRequired(body.paymentRequired ?? body.payment_required ?? body);
  const authorization = await verifyAuthorization(request, env, body);
  const { headers, paymentPayload, selectedRequirement } = await createPayment(env, paymentRequired, authorization);

  return jsonResponse({
    headers,
    payment_payload: paymentPayload,
    selected_requirement: selectedRequirement,
    authorized_by: authorization.owner,
    auth_request_id: authorization.authRequestId,
  });
}

async function handleProxy(request: Request, env: Env): Promise<Response> {
  const body = await readJsonObject(request) as ProxyBody;
  const authorization = await verifyAuthorization(request, env, body);
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
  const payment = await createPayment(env, paymentRequired, authorization);
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
): Promise<{
  headers: Record<string, string>;
  paymentPayload: unknown;
  selectedRequirement: PaymentRequirements;
}> {
  if (authorization.paymentRequirementHash) {
    const actualHash = await hashJson(paymentRequired);
    if (actualHash !== authorization.paymentRequirementHash) {
      throw new HttpError(403, "payment_requirement_hash_mismatch", "Payment requirement does not match the SIWE authorization.");
    }
  }

  const privateKey = requirePrivateKey(env);
  const selectedRequirement = selectRequirement(paymentRequired, authorization.capability);
  const filteredPaymentRequired: PaymentRequired = {
    ...paymentRequired,
    accepts: [selectedRequirement],
  };

  const signer = privateKeyToAccount(privateKey);
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
    selectedRequirement,
  };
}

type VerifiedAuthorization = {
  owner: Address;
  siwe: SiweMessage;
  capability: AutopayCapability;
  authRequestId?: string;
  paymentRequirementHash?: string;
};

type VerifyAuthorizationOptions = {
  expectedOrigin?: string;
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
  const allowedOwners = getAllowedOwners(env);
  if (allowedOwners.length > 0 && !allowedOwners.map(normalizeAddress).includes(normalizeAddress(owner))) {
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

  const capability = extractCapability(parsed);
  validateCapabilityTime(capability, now);

  const expectedChainId = chainIdFromNetwork(capability.network);
  if (expectedChainId !== parsed.chainId) {
    throw new HttpError(403, "siwe_chain_mismatch", "SIWE chain ID does not match the capability network.");
  }

  return {
    owner,
    siwe: parsed,
    capability,
    authRequestId: extractResourceValue(parsed, AUTH_REQUEST_PREFIX),
    paymentRequirementHash: extractResourceValue(parsed, PAYMENT_REQUIREMENT_PREFIX),
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

function normalizeCapability(value: unknown, defaultValidBefore?: string): AutopayCapability {
  if (!value || typeof value !== "object") {
    throw new HttpError(400, "invalid_autopay_capability", "Autopay capability must be a JSON object.");
  }
  const input = value as Partial<AutopayCapability>;
  const validBefore = normalizeValidBefore(input.validBefore, defaultValidBefore ? new Date(defaultValidBefore) : undefined);
  return {
    allowedOrigins: requireStringArray(input.allowedOrigins, "allowedOrigins").map((origin) => new URL(origin).origin),
    allowedPayTo: requireStringArray(input.allowedPayTo, "allowedPayTo").map((address) => getAddress(address)),
    network: requireString(input.network, "network") as Network,
    asset: getAddress(requireString(input.asset, "asset")),
    maxSingleAmount: requireUintString(input.maxSingleAmount, "maxSingleAmount"),
    validBefore,
  };
}

function inferPolicyFromPaymentRequirement(env: Env, paymentRequired: PaymentRequired | undefined, validBefore: string): AutopayCapability {
  if (!paymentRequired) {
    throw new HttpError(400, "missing_policy", "policy is required when paymentRequired is not provided.");
  }
  const requirement = selectCheapestExactRequirement(paymentRequired);
  return {
    allowedOrigins: [getResourceOrigin(paymentRequired)],
    allowedPayTo: [getAddress(requirement.payTo)],
    network: requirement.network as Network,
    asset: getAddress(requirement.asset),
    maxSingleAmount: requireUintString(requirement.amount, "amount"),
    validBefore,
  };
}

function selectRequirement(paymentRequired: PaymentRequired, capability: AutopayCapability): PaymentRequirements {
  const matches = paymentRequired.accepts.filter((requirement) => requirementAllowed(paymentRequired, requirement, capability));
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

function requirementAllowed(paymentRequired: PaymentRequired, requirement: PaymentRequirements, capability: AutopayCapability): boolean {
  if (requirement.scheme !== "exact") return false;
  if (requirement.network !== capability.network) return false;
  if (normalizeAddress(requirement.asset) !== normalizeAddress(capability.asset)) return false;
  if (!capability.allowedOrigins.includes(getResourceOrigin(paymentRequired))) return false;
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

function getResourceOrigin(paymentRequired: PaymentRequired): string {
  try {
    return new URL(paymentRequired.resource.url).origin;
  } catch {
    throw new HttpError(400, "invalid_resource_url", "Payment resource URL is invalid.");
  }
}

function getAllowedOwners(env: Env): Address[] {
  if (!env.AUTOPAY_ALLOWED_OWNERS?.trim()) return [];
  return env.AUTOPAY_ALLOWED_OWNERS.split(",")
    .map((item) => item.trim())
    .filter(Boolean)
    .map((address) => getAddress(address));
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
    && a.validBefore === b.validBefore
    && sameStringSet(a.allowedOrigins, b.allowedOrigins)
    && sameStringSet(a.allowedPayTo.map(normalizeAddress), b.allowedPayTo.map(normalizeAddress));
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
    policy: record.policy,
    payment_requirement_hash: record.paymentRequirementHash,
    return_origin: record.returnOrigin,
    nonce: record.nonce,
    created_at: record.createdAt,
    expires_at: record.expiresAt,
    resources: resourcesForRecord(record),
  };
}

function resourcesForRecord(record: AuthRequestRecord): string[] {
  const resources = [
    CAPABILITY_PREFIX + base64UrlEncode(JSON.stringify(record.policy)),
    AUTH_REQUEST_PREFIX + record.requestId,
  ];
  if (record.paymentRequirementHash) {
    resources.push(PAYMENT_REQUIREMENT_PREFIX + record.paymentRequirementHash);
  }
  return resources;
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
  const bytes = new TextEncoder().encode(value);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function base64UrlDecode(value: string): string {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized.padEnd(normalized.length + ((4 - normalized.length % 4) % 4), "=");
  return atob(padded);
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

function requirePrivateKey(env: Env): Hex {
  const key = env.AUTOPAY_PRIVATE_KEY;
  if (!key || !/^0x[0-9a-fA-F]{64}$/.test(key)) {
    throw new HttpError(500, "missing_private_key", "AUTOPAY_PRIVATE_KEY is not configured.");
  }
  return key as Hex;
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new HttpError(400, "missing_field", `${field} is required.`);
  }
  return value.trim();
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
      type: status === 402 ? "payment_required" : "api_error",
      code,
      message,
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
