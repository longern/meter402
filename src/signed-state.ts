import { normalizeAutopayUrl } from "./autopay";
import { base64UrlDecodeBytes, base64UrlDecodeText, base64UrlEncodeBytes, base64UrlEncodeText, canonicalJson } from "./crypto";
import { HttpError, requireString } from "./http";
import type { DepositAutopayState, DepositIntentState, DepositQuoteState, Env, LoginChallengeState, OwnerRebindChallengeState, PaymentRequirement, SessionState } from "./types";

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

export async function signDepositIntent(env: Env, state: DepositIntentState): Promise<string> {
  const payload = compactDepositIntent(state);
  const signature = await hmacSha256Base64Url(requireLoginStateSecret(env), payload);
  return `c3.${payload}.${signature}`;
}

export async function verifyDepositIntent(env: Env, token: string): Promise<DepositIntentState> {
  const state = token.startsWith("c1.") || token.startsWith("c2.") || token.startsWith("c3.")
    ? await verifyCompactDepositIntent(env, token)
    : normalizeDepositIntent(await verifySignedJson(env, token, "deposit_intent"));
  if (state.expires_at <= Date.now()) {
    throw new HttpError(410, "deposit_intent_expired", "Deposit intent has expired.");
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

export async function signLoginChallengeState(env: Env, state: LoginChallengeState): Promise<string> {
  const payload = base64UrlEncodeText(canonicalJson(state));
  const signature = await hmacSha256Base64Url(requireLoginStateSecret(env), payload);
  return `${payload}.${signature}`;
}

export async function verifyLoginChallengeState(env: Env, token: string): Promise<LoginChallengeState> {
  const parsed = await verifySignedJson(env, token, "login_challenge");
  const state = normalizeLoginChallengeState(parsed);
  if (state.expires_at <= Date.now()) {
    throw new HttpError(410, "login_challenge_expired", "Login challenge has expired.");
  }
  return state;
}

export async function signOwnerRebindChallengeState(env: Env, state: OwnerRebindChallengeState): Promise<string> {
  const payload = base64UrlEncodeText(canonicalJson(state));
  const signature = await hmacSha256Base64Url(requireLoginStateSecret(env), payload);
  return `${payload}.${signature}`;
}

export async function verifyOwnerRebindChallengeState(env: Env, token: string): Promise<OwnerRebindChallengeState> {
  const parsed = await verifySignedJson(env, token, "owner_rebind_challenge");
  const state = normalizeOwnerRebindChallengeState(parsed);
  if (state.expires_at <= Date.now()) {
    throw new HttpError(410, "owner_rebind_challenge_expired", "Owner rebind challenge has expired.");
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
    expires_at: expiresAt,
  };
}

function normalizeLoginChallengeState(value: unknown): LoginChallengeState {
  if (!value || typeof value !== "object") {
    throw new HttpError(400, "invalid_login_challenge", "Login challenge must be an object.");
  }
  const state = value as Record<string, unknown>;
  const expiresAt = typeof state.expires_at === "number" ? state.expires_at : 0;
  const chainId = typeof state.chain_id === "number" ? state.chain_id : 0;
  if (!Number.isFinite(expiresAt) || expiresAt <= 0) {
    throw new HttpError(400, "invalid_login_challenge", "Login challenge expiration is invalid.");
  }
  if (!Number.isSafeInteger(chainId) || chainId <= 0) {
    throw new HttpError(400, "invalid_login_challenge", "Login challenge chain ID is invalid.");
  }
  return {
    address: requireString(state.address, "address"),
    request_id: typeof state.request_id === "string" && state.request_id.trim() ? state.request_id : undefined,
    nonce: requireString(state.nonce, "nonce"),
    domain: requireString(state.domain, "domain"),
    uri: requireString(state.uri, "uri"),
    chain_id: chainId,
    issued_at: requireString(state.issued_at, "issued_at"),
    expires_at: expiresAt,
  };
}

function normalizeOwnerRebindChallengeState(value: unknown): OwnerRebindChallengeState {
  if (!value || typeof value !== "object") {
    throw new HttpError(400, "invalid_owner_rebind_challenge", "Owner rebind challenge must be an object.");
  }
  const state = value as Record<string, unknown>;
  const expiresAt = typeof state.expires_at === "number" ? state.expires_at : 0;
  const chainId = typeof state.chain_id === "number" ? state.chain_id : 0;
  if (!Number.isFinite(expiresAt) || expiresAt <= 0) {
    throw new HttpError(400, "invalid_owner_rebind_challenge", "Owner rebind challenge expiration is invalid.");
  }
  if (!Number.isSafeInteger(chainId) || chainId <= 0) {
    throw new HttpError(400, "invalid_owner_rebind_challenge", "Owner rebind chain ID is invalid.");
  }
  return {
    account_id: requireString(state.account_id, "account_id"),
    old_owner: requireString(state.old_owner, "old_owner"),
    new_owner: requireString(state.new_owner, "new_owner"),
    nonce: requireString(state.nonce, "nonce"),
    domain: requireString(state.domain, "domain"),
    uri: requireString(state.uri, "uri"),
    chain_id: chainId,
    issued_at: requireString(state.issued_at, "issued_at"),
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
  if (
    state.kind !== "deposit" ||
    typeof state.currency !== "string" ||
    !state.currency.trim()
  ) {
    throw new HttpError(400, "invalid_deposit_quote", "Deposit quote kind is invalid.");
  }
  if (requirementKind !== "deposit" || requirementId !== paymentId) {
    throw new HttpError(400, "invalid_deposit_quote", "Deposit quote payment requirement is invalid.");
  }
  return {
    payment_id: paymentId,
    kind: "deposit",
    amount,
    currency: state.currency.trim().toUpperCase(),
    owner_address: requireString(state.owner_address, "owner_address"),
    autopay_url:
      typeof state.autopay_url === "string" && state.autopay_url.trim()
        ? normalizeAutopayUrl(state.autopay_url)
        : "",
    payment_requirement: requirement,
    authorization: {
      nonce: requireString(state.authorization && typeof state.authorization === "object" ? (state.authorization as Record<string, unknown>).nonce : undefined, "authorization.nonce"),
      valid_after: requireString(state.authorization && typeof state.authorization === "object" ? (state.authorization as Record<string, unknown>).valid_after : undefined, "authorization.valid_after"),
      valid_before: requireString(state.authorization && typeof state.authorization === "object" ? (state.authorization as Record<string, unknown>).valid_before : undefined, "authorization.valid_before"),
    },
    expires_at: expiresAt,
  };
}

function compactDepositIntent(state: DepositIntentState): string {
  return [
    state.payment_id,
    state.amount.toString(36),
    Number(state.valid_before).toString(36),
    state.owner_address,
    base64UrlEncodeText(state.autopay_url || ""),
  ].join("~");
}

async function verifyCompactDepositIntent(env: Env, token: string): Promise<DepositIntentState> {
  const [version, payload, signature, extra] = token.split(".");
  if ((version !== "c1" && version !== "c2" && version !== "c3") || !payload || !signature || extra != null) {
    throw new HttpError(400, "invalid_deposit_intent", "Deposit intent is invalid.");
  }
  const expected = await hmacSha256Base64Url(requireLoginStateSecret(env), payload);
  if (!constantTimeEqual(signature, expected)) {
    throw new HttpError(403, "invalid_deposit_intent_signature", "Deposit intent signature is invalid.");
  }
  const parts = payload.split("~");
  if (version === "c1") {
    const [paymentId, amount, nonce, validAfter, validBefore, expiresAt, extraField] = parts;
    if (!paymentId || !amount || !nonce || !validAfter || !validBefore || !expiresAt || extraField != null) {
      throw new HttpError(400, "invalid_deposit_intent", "Deposit intent payload is invalid.");
    }
    return {
      payment_id: paymentId,
      amount: numberFromBase36(amount, "amount"),
      owner_address: "",
      autopay_url: "",
      token_amount: "",
      currency: "",
      network: "",
      asset: "",
      pay_to: "",
      nonce: nonceBase64UrlToHex(nonce),
      valid_after: String(numberFromBase36(validAfter, "valid_after")),
      valid_before: String(numberFromBase36(validBefore, "valid_before")),
      expires_at: numberFromBase36(expiresAt, "expires_at"),
    };
  }

  if (version === "c3") {
    const [paymentId, amount, validBefore, ownerAddress, autopayUrl, extraField] = parts;
    if (!paymentId || !amount || !validBefore || !ownerAddress || autopayUrl == null || extraField != null) {
      throw new HttpError(400, "invalid_deposit_intent", "Deposit intent payload is invalid.");
    }
    const validBeforeSeconds = numberFromBase36(validBefore, "valid_before");
    const decodedAutopayUrl = base64UrlDecodeText(autopayUrl);
    return {
      payment_id: paymentId,
      amount: numberFromBase36(amount, "amount"),
      owner_address: ownerAddress,
      autopay_url: decodedAutopayUrl.trim() ? normalizeAutopayUrl(decodedAutopayUrl) : "",
      token_amount: "",
      currency: "",
      network: "",
      asset: "",
      pay_to: "",
      nonce: await nonceFromCompactIntent(payload, signature),
      valid_after: String(validBeforeSeconds - 360),
      valid_before: String(validBeforeSeconds),
      expires_at: validBeforeSeconds * 1000,
    };
  }

  const [paymentId, amount, validBefore, extraField] = parts;
  if (!paymentId || !amount || !validBefore || extraField != null) {
    throw new HttpError(400, "invalid_deposit_intent", "Deposit intent payload is invalid.");
  }
  const validBeforeSeconds = numberFromBase36(validBefore, "valid_before");
  return {
    payment_id: paymentId,
    amount: numberFromBase36(amount, "amount"),
    owner_address: "",
    autopay_url: "",
    token_amount: "",
    currency: "",
    network: "",
    asset: "",
    pay_to: "",
    nonce: await nonceFromCompactIntent(payload, signature),
    valid_after: String(validBeforeSeconds - 360),
    valid_before: String(validBeforeSeconds),
    expires_at: validBeforeSeconds * 1000,
  };
}

function normalizeDepositIntent(value: unknown): DepositIntentState {
  if (!value || typeof value !== "object") {
    throw new HttpError(400, "invalid_deposit_intent", "Deposit intent must be an object.");
  }
  const state = value as Record<string, unknown>;
  const amount = typeof state.a === "number" ? state.a : 0;
  const expiresAt = typeof state.e === "number" ? state.e : 0;
  if (!Number.isInteger(amount) || amount <= 0) {
    throw new HttpError(400, "invalid_deposit_intent", "Deposit intent amount is invalid.");
  }
  if (!Number.isFinite(expiresAt) || expiresAt <= 0) {
    throw new HttpError(400, "invalid_deposit_intent", "Deposit intent expiration is invalid.");
  }
  return {
    payment_id: requireString(state.p, "payment_id"),
    amount,
    owner_address: requireString(state.w ?? state.owner_address, "owner_address"),
    autopay_url:
      typeof (state.u ?? state.autopay_url) === "string" &&
      String(state.u ?? state.autopay_url).trim()
        ? normalizeAutopayUrl(state.u ?? state.autopay_url)
        : "",
    token_amount: requireString(state.x, "token_amount"),
    currency: requireString(state.c, "currency").trim().toUpperCase(),
    network: requireString(state.n, "network"),
    asset: requireString(state.t, "asset"),
    pay_to: requireString(state.r, "pay_to"),
    nonce: requireString(state.o, "nonce"),
    valid_after: requireString(state.va, "valid_after"),
    valid_before: requireString(state.vb, "valid_before"),
    expires_at: expiresAt,
  };
}

function numberFromBase36(value: string, field: string): number {
  if (!/^[0-9a-z]+$/.test(value)) {
    throw new HttpError(400, "invalid_deposit_intent", `Deposit intent ${field} is invalid.`);
  }
  const parsed = parseInt(value, 36);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new HttpError(400, "invalid_deposit_intent", `Deposit intent ${field} is invalid.`);
  }
  return parsed;
}

function nonceHexToBase64Url(value: string): string {
  const hex = value.startsWith("0x") ? value.slice(2) : value;
  if (!/^[0-9a-fA-F]{64}$/.test(hex)) {
    throw new HttpError(500, "invalid_deposit_intent", "Deposit intent nonce is invalid.");
  }
  const bytes = new Uint8Array(32);
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = parseInt(hex.slice(index * 2, index * 2 + 2), 16);
  }
  return base64UrlEncodeBytes(bytes);
}

function nonceBase64UrlToHex(value: string): string {
  const bytes = base64UrlDecodeBytes(value);
  if (bytes.length !== 32) {
    throw new HttpError(400, "invalid_deposit_intent", "Deposit intent nonce is invalid.");
  }
  return `0x${[...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

async function nonceFromCompactIntent(payload: string, signature: string): Promise<string> {
  const input = new TextEncoder().encode(`deposit-intent-nonce:${payload}.${signature}`);
  const digest = await crypto.subtle.digest("SHA-256", input);
  return `0x${[...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("")}`;
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
  const recipientPrivateKey = env.X402_RECIPIENT_PRIVATE_KEY?.trim();
  if (!recipientPrivateKey) {
    throw new HttpError(500, "missing_recipient_private_key", "X402_RECIPIENT_PRIVATE_KEY must be configured.");
  }
  if (!/^0x[0-9a-fA-F]{64}$/.test(recipientPrivateKey)) {
    throw new HttpError(500, "invalid_recipient_private_key", "X402_RECIPIENT_PRIVATE_KEY must be a valid EVM private key.");
  }
  return `meteria402:signed-state:v1:${recipientPrivateKey}`;
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
