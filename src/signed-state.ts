import { normalizeAutopayUrl } from "./autopay";
import { base64UrlDecodeText, base64UrlEncodeBytes, base64UrlEncodeText, canonicalJson } from "./crypto";
import { HttpError, requireString } from "./http";
import type { DepositAutopayState, DepositQuoteState, Env, LoginState, PaymentRequirement, SessionState } from "./types";

export async function signDepositQuote(env: Env, state: DepositQuoteState): Promise<string> {
  const payload = base64UrlEncodeText(canonicalJson(state));
  const signature = await hmacSha256Base64Url(requireLoginStateSecret(env), payload);
  return `${payload}.${signature}`;
}

export async function verifyDepositQuote(env: Env, token: string): Promise<DepositQuoteState> {
  const parsed = await verifySignedJson(env, token, "deposit_quote");
  const state = normalizeDepositQuote(parsed);
  if (state.expires_at <= Date.now()) {
    throw new HttpError(410, "deposit_quote_expired", "Deposit quote has expired.");
  }
  return state;
}

export async function signDepositAutopayState(env: Env, state: DepositAutopayState): Promise<string> {
  const payload = base64UrlEncodeText(canonicalJson(state));
  const signature = await hmacSha256Base64Url(requireLoginStateSecret(env), payload);
  return `${payload}.${signature}`;
}

export async function verifyDepositAutopayState(env: Env, token: string): Promise<DepositAutopayState> {
  const parsed = await verifySignedJson(env, token, "deposit_autopay_state");
  const state = normalizeDepositAutopayState(parsed);
  if (state.expires_at <= Date.now()) {
    throw new HttpError(410, "deposit_autopay_state_expired", "Deposit autopay state has expired.");
  }
  return state;
}

export async function signLoginState(env: Env, state: LoginState): Promise<string> {
  const payload = base64UrlEncodeText(canonicalJson(state));
  const signature = await hmacSha256Base64Url(requireLoginStateSecret(env), payload);
  return `${payload}.${signature}`;
}

export async function verifyLoginState(env: Env, token: string): Promise<LoginState> {
  const parsed = await verifySignedJson(env, token, "login_state");
  const state = normalizeLoginState(parsed);
  if (state.expires_at <= Date.now()) {
    throw new HttpError(410, "login_state_expired", "Login state has expired.");
  }
  return state;
}

export async function signSessionState(env: Env, state: SessionState): Promise<string> {
  const payload = base64UrlEncodeText(canonicalJson(state));
  const signature = await hmacSha256Base64Url(requireLoginStateSecret(env), payload);
  return `${payload}.${signature}`;
}

export async function verifySessionState(env: Env, token: string): Promise<SessionState> {
  const parsed = await verifySignedJson(env, token, "session");
  const state = normalizeSessionState(parsed);
  if (state.expires_at <= Date.now()) {
    throw new HttpError(401, "session_expired", "Session has expired.");
  }
  return state;
}

async function verifySignedJson(env: Env, token: string, label: string): Promise<unknown> {
  const [payload, signature, extra] = token.split(".");
  if (!payload || !signature || extra != null) {
    throw new HttpError(400, `invalid_${label}`, "Signed token is invalid.");
  }
  const expected = await hmacSha256Base64Url(requireLoginStateSecret(env), payload);
  if (!constantTimeEqual(signature, expected)) {
    throw new HttpError(403, `invalid_${label}_signature`, "Signed token signature is invalid.");
  }
  try {
    return JSON.parse(base64UrlDecodeText(payload));
  } catch {
    throw new HttpError(400, `invalid_${label}`, "Signed token payload is invalid.");
  }
}

function normalizeSessionState(value: unknown): SessionState {
  if (!value || typeof value !== "object") {
    throw new HttpError(401, "invalid_session", "Session is invalid.");
  }
  const state = value as Record<string, unknown>;
  const expiresAt = typeof state.expires_at === "number" ? state.expires_at : 0;
  if (!Number.isFinite(expiresAt) || expiresAt <= 0) {
    throw new HttpError(401, "invalid_session", "Session expiration is invalid.");
  }
  if (typeof state.owner !== "string" || !state.owner.trim()) {
    throw new HttpError(401, "invalid_session", "Session owner is invalid.");
  }
  return {
    owner: state.owner,
    autopay_url: normalizeAutopayUrl(state.autopay_url),
    expires_at: expiresAt,
  };
}

function normalizeLoginState(value: unknown): LoginState {
  if (!value || typeof value !== "object") {
    throw new HttpError(400, "invalid_login_state", "Login state must be an object.");
  }
  const state = value as Record<string, unknown>;
  const expiresAt = typeof state.expires_at === "number" ? state.expires_at : 0;
  if (!Number.isFinite(expiresAt) || expiresAt <= 0) {
    throw new HttpError(400, "invalid_login_state", "Login state expiration is invalid.");
  }
  return {
    autopay_url: normalizeAutopayUrl(state.autopay_url),
    autopay_request_id: requireString(state.autopay_request_id, "autopay_request_id"),
    poll_token: requireString(state.poll_token, "poll_token"),
    verification_uri_complete: requireString(state.verification_uri_complete, "verification_uri_complete"),
    expires_at: expiresAt,
  };
}

function normalizeDepositQuote(value: unknown): DepositQuoteState {
  if (!value || typeof value !== "object") {
    throw new HttpError(400, "invalid_deposit_quote", "Deposit quote must be an object.");
  }
  const state = value as Record<string, unknown>;
  const expiresAt = typeof state.expires_at === "number" ? state.expires_at : 0;
  const amount = typeof state.amount === "number" ? state.amount : 0;
  const requirement = normalizePaymentRequirement(state.payment_requirement);
  const paymentId = requireString(state.payment_id, "payment_id");
  const requirementId = requirement.accepts[0]?.extra?.id;
  const requirementKind = requirement.accepts[0]?.extra?.kind;
  if (!Number.isInteger(amount) || amount <= 0) {
    throw new HttpError(400, "invalid_deposit_quote", "Deposit quote amount is invalid.");
  }
  if (!Number.isFinite(expiresAt) || expiresAt <= 0) {
    throw new HttpError(400, "invalid_deposit_quote", "Deposit quote expiration is invalid.");
  }
  if (state.kind !== "deposit" || state.currency !== "USD") {
    throw new HttpError(400, "invalid_deposit_quote", "Deposit quote kind is invalid.");
  }
  if (requirementKind !== "deposit" || requirementId !== paymentId) {
    throw new HttpError(400, "invalid_deposit_quote", "Deposit quote payment requirement is invalid.");
  }
  return {
    payment_id: paymentId,
    kind: "deposit",
    amount,
    currency: "USD",
    payment_requirement: requirement,
    expires_at: expiresAt,
  };
}

function normalizePaymentRequirement(value: unknown): PaymentRequirement {
  if (!value || typeof value !== "object") {
    throw new HttpError(400, "invalid_payment_requirement", "Payment requirement is invalid.");
  }
  const requirement = value as PaymentRequirement;
  if (!requirement.resource || typeof requirement.resource.url !== "string") {
    throw new HttpError(400, "invalid_payment_requirement", "Payment requirement resource is invalid.");
  }
  if (!Array.isArray(requirement.accepts) || requirement.accepts.length === 0) {
    throw new HttpError(400, "invalid_payment_requirement", "Payment requirement does not include accepted payments.");
  }
  return requirement;
}

function normalizeDepositAutopayState(value: unknown): DepositAutopayState {
  if (!value || typeof value !== "object") {
    throw new HttpError(400, "invalid_deposit_autopay_state", "Deposit autopay state must be an object.");
  }
  const state = value as Record<string, unknown>;
  const expiresAt = typeof state.expires_at === "number" ? state.expires_at : 0;
  if (!Number.isFinite(expiresAt) || expiresAt <= 0) {
    throw new HttpError(400, "invalid_deposit_autopay_state", "Deposit autopay state expiration is invalid.");
  }
  return {
    payment_id: requireString(state.payment_id, "payment_id"),
    quote_token: requireString(state.quote_token, "quote_token"),
    autopay_url: normalizeAutopayUrl(state.autopay_url),
    autopay_request_id: requireString(state.autopay_request_id, "autopay_request_id"),
    poll_token: requireString(state.poll_token, "poll_token"),
    verification_uri_complete: requireString(state.verification_uri_complete, "verification_uri_complete"),
    expires_at: expiresAt,
  };
}

function requireLoginStateSecret(env: Env): string {
  const secret = env.APP_SIGNING_SECRET?.trim();
  if (!secret || secret.length < 16) {
    throw new HttpError(500, "missing_app_signing_secret", "APP_SIGNING_SECRET must be configured with at least 16 characters.");
  }
  return secret;
}

async function hmacSha256Base64Url(secret: string, payload: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payload));
  return base64UrlEncodeBytes(new Uint8Array(signature));
}

function constantTimeEqual(a: string, b: string): boolean {
  const left = new TextEncoder().encode(a);
  const right = new TextEncoder().encode(b);
  const length = Math.max(left.length, right.length);
  let diff = left.length ^ right.length;
  for (let index = 0; index < length; index += 1) {
    diff |= (left[index] ?? 0) ^ (right[index] ?? 0);
  }
  return diff === 0;
}
