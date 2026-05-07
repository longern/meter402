import { getAddress, verifyMessage, type Hex } from "viem";
import { JSON_HEADERS } from "./constants";
import { makeId, base64UrlRandom } from "./crypto";
import {
  errorResponse,
  HttpError,
  jsonResponse,
  readJsonObject,
  requireString,
} from "./http";
import {
  serializeSessionCookie,
  sessionExpiresAt,
} from "./session";
import {
  signLoginChallengeState,
  signSessionState,
  verifyLoginChallengeState,
} from "./signed-state";
import type { Env, LoginChallengeState } from "./types";

const LOGIN_TTL_SECONDS = 5 * 60;
const LOGIN_STATEMENT = "Sign in to Meteria402.";
const LOGIN_RESOURCE_PREFIX = "urn:meteria402:login:";

type LoginScanRecord = {
  requestId: string;
  eventToken: string;
  status: "pending" | "scanned" | "signing" | "approved" | "denied" | "expired";
  origin: string;
  domain: string;
  chainId: number;
  createdAt: string;
  expiresAt: number;
  owner?: string;
};

export async function handleLoginChallenge(
  request: Request,
  env: Env,
): Promise<Response> {
  const body = await readJsonObject(request);
  const challenge = await createLoginChallenge(
    request,
    env,
    requireString(body.address, "address"),
  );
  return jsonResponse(challenge, { status: 201 });
}

export async function handleLoginComplete(
  request: Request,
  env: Env,
): Promise<Response> {
  const body = await readJsonObject(request);
  const owner = await verifyLoginSignature(env, body);
  return createApprovedLoginResponse(request, env, owner);
}

export async function handleLoginScanStart(
  request: Request,
  env: Env,
): Promise<Response> {
  const publicOrigin = requestOrigin(request);
  const publicUrl = new URL(publicOrigin);
  const requestId = makeId("login");
  const eventToken = base64UrlRandom(24);
  const expiresAt = Date.now() + LOGIN_TTL_SECONDS * 1000;
  const record: LoginScanRecord = {
    requestId,
    eventToken,
    status: "pending",
    origin: publicUrl.origin,
    domain: publicUrl.host,
    chainId: chainIdFromEnv(env),
    createdAt: new Date().toISOString(),
    expiresAt,
  };

  const stub = loginSessionStub(env, requestId);
  await stub.fetch("https://login-session/init", {
    method: "POST",
    headers: JSON_HEADERS,
    body: JSON.stringify(record),
  });

  const verificationUrl = new URL("/login/wallet", publicUrl.origin);
  verificationUrl.searchParams.set("request_id", requestId);
  const eventsUrl = new URL(`/api/login/scan/${encodeURIComponent(requestId)}/events`, publicUrl.origin);
  eventsUrl.searchParams.set("event_token", eventToken);
  eventsUrl.protocol = publicUrl.protocol === "https:" ? "wss:" : "ws:";

  return jsonResponse(
    {
      request_id: requestId,
      status: "pending",
      verification_uri_complete: verificationUrl.toString(),
      websocket_uri_complete: eventsUrl.toString(),
      expires_in: LOGIN_TTL_SECONDS,
    },
    { status: 201 },
  );
}

export async function handleLoginScanRequest(
  request: Request,
  env: Env,
  requestId: string,
  action: string,
): Promise<Response> {
  const pathname =
    action === "events"
      ? `/events${new URL(request.url).search}`
      : `/${action}`;
  const response = await loginSessionStub(env, requestId).fetch(
    new Request(`https://login-session${pathname}`, request),
  );
  if ((action === "approve" || action === "complete") && response.ok) {
    const body = (await response.clone().json().catch(() => null)) as
      | { owner?: string }
      | null;
    if (body?.owner) {
      return createApprovedLoginResponse(request, env, body.owner);
    }
  }
  return response;
}

export class LoginSession implements DurableObject {
  constructor(
    private readonly ctx: DurableObjectState,
    private readonly env: Env,
  ) {}

  async fetch(request: Request): Promise<Response> {
    try {
      const url = new URL(request.url);
      if (request.method === "POST" && url.pathname === "/init") {
        const record = (await readJsonObject(request)) as LoginScanRecord;
        await this.ctx.storage.put("record", record);
        await this.ctx.storage.setAlarm(record.expiresAt);
        return jsonResponse({ ok: true });
      }

      const record = await this.readRecord();
      if (isExpired(record) && isActiveRecord(record)) {
        record.status = "expired";
        await this.saveAndBroadcast(record, { clearStorage: true });
      }

      if (request.method === "GET" && url.pathname === "/details") {
        if (record.status === "pending") {
          record.status = "scanned";
          await this.saveAndBroadcast(record);
        }
        return jsonResponse(publicScanRecord(record));
      }
      if (request.method === "POST" && url.pathname === "/challenge") {
        if (!isActiveRecord(record)) {
          throw new HttpError(409, "login_not_pending", "Login request is no longer pending.");
        }
        const body = await readJsonObject(request);
        const challenge = await createLoginChallenge(
          new Request(record.origin),
          this.env,
          requireString(body.address, "address"),
          record.requestId,
        );
        if (record.status === "pending" || record.status === "scanned") {
          record.status = "signing";
          await this.saveAndBroadcast(record);
        }
        return jsonResponse(challenge, { status: 201 });
      }
      if (request.method === "POST" && url.pathname === "/approve") {
        if (!isActiveRecord(record)) {
          throw new HttpError(409, "login_not_pending", "Login request is no longer pending.");
        }
        const body = await readJsonObject(request);
        const owner = await verifyLoginSignature(this.env, body, record.requestId);
        record.status = "approved";
        record.owner = owner;
        await this.saveAndBroadcast(record);
        return jsonResponse({ status: "approved", owner });
      }
      if (request.method === "POST" && url.pathname === "/deny") {
        if (isActiveRecord(record)) {
          record.status = "denied";
          await this.saveAndBroadcast(record, { clearStorage: true });
        }
        return jsonResponse({ status: record.status });
      }
      if (request.method === "POST" && url.pathname === "/complete") {
        if (record.status !== "approved" || !record.owner) {
          return jsonResponse(publicScanRecord(record));
        }
        const owner = record.owner;
        await this.clearStorage();
        return jsonResponse({ status: "approved", owner });
      }
      if (request.method === "GET" && url.pathname === "/events") {
        if (request.headers.get("Upgrade") !== "websocket") {
          throw new HttpError(426, "websocket_required", "WebSocket upgrade is required.");
        }
        if (url.searchParams.get("event_token") !== record.eventToken) {
          throw new HttpError(403, "invalid_event_token", "Login event token is invalid.");
        }
        const pair = new WebSocketPair();
        const [client, server] = Object.values(pair);
        this.ctx.acceptWebSocket(server);
        server.send(JSON.stringify(publicScanRecord(record)));
        if (isTerminalRecord(record)) server.close(1000, record.status);
        return new Response(null, { status: 101, webSocket: client });
      }
      return errorResponse(404, "not_found", "No login session route matches this request.");
    } catch (error) {
      if (error instanceof HttpError) {
        return errorResponse(error.status, error.code, error.message, error.extra);
      }
      console.error("Login session failed", error);
      return errorResponse(500, "internal_error", "Login session failed.");
    }
  }

  async alarm(): Promise<void> {
    const record = await this.readRecord().catch(() => null);
    if (!record) return;
    if (!isActiveRecord(record)) {
      await this.clearStorage();
      return;
    }
    record.status = "expired";
    await this.saveAndBroadcast(record, { clearStorage: true });
  }

  webSocketMessage(): void {
    // The socket is server-to-client only; client messages are ignored.
  }

  private async readRecord(): Promise<LoginScanRecord> {
    const record = await this.ctx.storage.get<LoginScanRecord>("record");
    if (!record) {
      throw new HttpError(404, "login_request_not_found", "Login request was not found.");
    }
    return record;
  }

  private async saveAndBroadcast(
    record: LoginScanRecord,
    options: { clearStorage?: boolean } = {},
  ): Promise<void> {
    if (options.clearStorage) {
      await this.ctx.storage.delete("record");
      await this.ctx.storage.deleteAlarm();
    } else {
      await this.ctx.storage.put("record", record);
    }
    const payload = JSON.stringify(publicScanRecord(record));
    for (const socket of this.ctx.getWebSockets()) {
      try {
        socket.send(payload);
        if (isTerminalRecord(record)) socket.close(1000, record.status);
      } catch {
        socket.close(1011, "send_failed");
      }
    }
  }

  private async clearStorage(): Promise<void> {
    await this.ctx.storage.delete("record");
    await this.ctx.storage.deleteAlarm();
  }
}

async function createLoginChallenge(
  request: Request,
  env: Env,
  address: string,
  requestId?: string,
): Promise<Record<string, unknown>> {
  const origin = requestOrigin(request);
  const originUrl = new URL(origin);
  const issuedAt = new Date().toISOString();
  const expiresAt = Date.now() + LOGIN_TTL_SECONDS * 1000;
  const state: LoginChallengeState = {
    address: getAddress(address),
    request_id: requestId,
    nonce: base64UrlRandom(12),
    domain: originUrl.host,
    uri: originUrl.origin,
    chain_id: chainIdFromEnv(env),
    issued_at: issuedAt,
    expires_at: expiresAt,
  };
  const challengeToken = await signLoginChallengeState(env, state);
  return {
    challenge_token: challengeToken,
    message: buildLoginMessage(state),
    expires_at: new Date(expiresAt).toISOString(),
  };
}

async function verifyLoginSignature(
  env: Env,
  body: Record<string, unknown>,
  requestId?: string,
): Promise<string> {
  const challengeToken = requireString(body.challenge_token ?? body.challengeToken, "challenge_token");
  const message = requireString(body.message ?? body.siwe_message, "message");
  const signature = requireString(body.signature ?? body.siwe_signature, "signature") as Hex;
  const state = await verifyLoginChallengeState(env, challengeToken);
  if ((state.request_id ?? "") !== (requestId ?? "")) {
    throw new HttpError(403, "login_request_mismatch", "Login signature is not bound to this request.");
  }
  if (message !== buildLoginMessage(state)) {
    throw new HttpError(403, "login_message_mismatch", "Login message does not match the challenge.");
  }
  const valid = await verifyMessage({
    address: getAddress(state.address),
    message,
    signature,
  });
  if (!valid) {
    throw new HttpError(403, "invalid_signature", "Login signature is invalid.");
  }
  return getAddress(state.address);
}

async function createApprovedLoginResponse(
  request: Request,
  env: Env,
  owner: string,
): Promise<Response> {
  const normalizedOwner = getAddress(owner);
  const autopayUrl = await readAccountAutopayUrl(env, normalizedOwner);
  const expiresAt = sessionExpiresAt();
  const sessionToken = await signSessionState(env, {
    owner: normalizedOwner,
    autopay_url: autopayUrl,
    expires_at: expiresAt,
  });
  return jsonResponse(
    {
      status: "approved",
      owner: normalizedOwner,
      autopay_url: autopayUrl,
      expires_at: new Date(expiresAt).toISOString(),
    },
    {
      headers: {
        "set-cookie": serializeSessionCookie(request, sessionToken, expiresAt),
      },
    },
  );
}

async function readAccountAutopayUrl(env: Env, owner: string): Promise<string> {
  try {
    const row = await env.DB.prepare(
      `SELECT autopay_url FROM meteria402_accounts WHERE lower(owner_address) = lower(?) LIMIT 1`,
    )
      .bind(owner)
      .first<{ autopay_url: string | null }>();
    return row?.autopay_url || "";
  } catch (error) {
    console.warn("Login account autopay lookup skipped", error);
    return "";
  }
}

function buildLoginMessage(state: LoginChallengeState): string {
  const resources = [`${LOGIN_RESOURCE_PREFIX}${state.request_id || state.nonce}`];
  return [
    `${state.domain} wants you to sign in with your Ethereum account:`,
    state.address,
    "",
    LOGIN_STATEMENT,
    "",
    `URI: ${state.uri}`,
    "Version: 1",
    `Chain ID: ${state.chain_id}`,
    `Nonce: ${state.nonce}`,
    `Issued At: ${state.issued_at}`,
    `Expiration Time: ${new Date(state.expires_at).toISOString()}`,
    "Resources:",
    ...resources.map((resource) => `- ${resource}`),
  ].join("\n");
}

function publicScanRecord(record: LoginScanRecord): Record<string, unknown> {
  return {
    request_id: record.requestId,
    status: record.status,
    owner: record.owner,
    expires_at: new Date(record.expiresAt).toISOString(),
  };
}

function isExpired(record: LoginScanRecord): boolean {
  return record.expiresAt <= Date.now();
}

function isActiveRecord(record: LoginScanRecord): boolean {
  return record.status === "pending" || record.status === "scanned" || record.status === "signing";
}

function isTerminalRecord(record: LoginScanRecord): boolean {
  return record.status === "approved" || record.status === "denied" || record.status === "expired";
}

function loginSessionStub(env: Env, requestId: string): DurableObjectStub {
  return env.LOGIN_SESSIONS.get(env.LOGIN_SESSIONS.idFromName(requestId));
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
    const protocol = request.headers.get("x-forwarded-proto") || url.protocol.replace(":", "");
    return `${protocol === "https" ? "https" : "http"}://${host}`;
  }
  return url.origin;
}

function chainIdFromEnv(env: Env): number {
  const network = env.X402_NETWORK || "eip155:8453";
  const chainId = Number(network.split(":")[1] || "8453");
  if (!Number.isSafeInteger(chainId) || chainId <= 0) {
    throw new HttpError(500, "invalid_login_network", "X402_NETWORK must include an EVM chain ID.");
  }
  return chainId;
}
