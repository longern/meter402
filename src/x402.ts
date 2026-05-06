import {
  BASE_MAINNET,
  BASE_USDC,
  DEFAULT_X402_FACILITATOR_URL,
  JSON_HEADERS,
} from "./constants";
import { makeId } from "./crypto";
import { HttpError } from "./http";
import {
  formatMoney,
  parsePositiveInt,
} from "./money";
import type { Env, PaymentRequirement } from "./types";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function verifyPayment(
  env: Env,
  paymentRequirementJson: string,
  paymentPayload: unknown,
  devProof?: string,
): Promise<
  | { ok: true; txHash?: string; payerAddress?: string; raw?: unknown }
  | { ok: false; message: string; facilitatorStatus?: number; raw?: unknown }
> {
  if (env.ALLOW_DEV_PAYMENTS === "true" && devProof === "dev-paid") {
    return { ok: true, txHash: `dev:${makeId("tx")}`, raw: { dev: true } };
  }

  if (!paymentPayload) {
    return {
      ok: false,
      message: "Payment payload is required.",
    };
  }

  const facilitatorHeaders = new Headers({
    "content-type": "application/json",
  });
  const cdpKeyId = (env as unknown as Record<string, string | undefined>)
    .CDP_API_KEY_ID;
  const cdpSecret = (env as unknown as Record<string, string | undefined>)
    .CDP_API_KEY_SECRET;
  if (cdpKeyId && cdpSecret) {
    const jwt = await generateCDPJWT(
      cdpKeyId,
      cdpSecret,
      "POST",
      "api.cdp.coinbase.com",
      "/platform/v2/x402/settle",
    );
    facilitatorHeaders.set("authorization", `Bearer ${jwt}`);
  } else if (env.X402_FACILITATOR_AUTH_TOKEN) {
    facilitatorHeaders.set(
      "authorization",
      `Bearer ${env.X402_FACILITATOR_AUTH_TOKEN}`,
    );
  }

  const facilitatorUrl =
    env.X402_FACILITATOR_URL?.trim() || DEFAULT_X402_FACILITATOR_URL;
  const response = await fetch(facilitatorEndpoint(facilitatorUrl, "settle"), {
    method: "POST",
    headers: facilitatorHeaders,
    body: JSON.stringify(
      facilitatorSettleBody(paymentRequirementJson, paymentPayload),
    ),
  });

  const text = await response.text();
  console.warn(
    "[x402 settle] status:",
    response.status,
    "body:",
    text.substring(0, 2000),
  );
  let json: Record<string, unknown> = {};
  try {
    json = text ? (JSON.parse(text) as Record<string, unknown>) : {};
  } catch {
    json = { raw: text };
  }

  if (!response.ok || json.success === false || json.ok === false) {
    return {
      ok: false,
      message: facilitatorErrorMessage(json),
      facilitatorStatus: response.status,
      raw: json,
    };
  }

  return {
    ok: true,
    txHash:
      typeof json.tx_hash === "string"
        ? json.tx_hash
        : typeof json.transaction === "string"
          ? json.transaction
          : undefined,
    payerAddress:
      typeof json.payer === "string"
        ? json.payer
        : typeof json.from === "string"
          ? json.from
          : undefined,
    raw: json,
  };
}

export function settlementErrorExtra(settlement: {
  facilitatorStatus?: number;
  raw?: unknown;
}): Record<string, unknown> {
  return {
    facilitator_status: settlement.facilitatorStatus,
    facilitator_response: settlement.raw ?? null,
  };
}

export function createPaymentRequirement(
  request: Request,
  env: Env,
  input: { kind: string; id: string; amount: number; description: string },
): PaymentRequirement {
  const url = new URL(request.url);
  return createPaymentRequirementFromValues(env, {
    resource: `${url.origin}/api/payments/${input.id}`,
    ...input,
  });
}

export function createPaymentRequirementFromValues(
  env: Env,
  input: {
    resource: string;
    kind: string;
    id: string;
    amount: number;
    description: string;
  },
): PaymentRequirement {
  return {
    x402Version: 2,
    resource: {
      url: input.resource,
    },
    accepts: [
      {
        scheme: "exact",
        network: env.X402_NETWORK || BASE_MAINNET,
        asset: env.X402_ASSET || BASE_USDC,
        amount: x402AmountFromMicroUsd(input.amount, env),
        payTo: requireRecipientAddress(env),
        maxTimeoutSeconds: 300,
        extra: {
          name: getX402AssetDomainName(env),
          version: getX402AssetDomainVersion(env),
          description: input.description,
          service: "meteria402",
          kind: input.kind,
          id: input.id,
          amount_decimal: formatMoney(input.amount),
          currency: "USDC",
        },
      },
    ],
  };
}

export function getRpcUrl(env: Env): string {
  if (env.X402_RPC_URL?.trim()) return env.X402_RPC_URL.trim();
  if ((env.X402_NETWORK || BASE_MAINNET) === BASE_MAINNET)
    return "https://mainnet.base.org";
  throw new HttpError(
    500,
    "missing_rpc_url",
    "X402_RPC_URL must be configured for this network.",
  );
}

export function normalizeEvmAddress(value: unknown): string {
  if (typeof value !== "string" || !/^0x[a-fA-F0-9]{40}$/.test(value)) {
    throw new HttpError(
      400,
      "invalid_address",
      "A valid EVM address is required.",
    );
  }
  return value;
}

export async function verifyTxHash(
  env: Env,
  txHash: string,
  expectedRequirement: PaymentRequirement,
): Promise<
  | { ok: true; txHash: string; payerAddress: string; raw?: unknown }
  | { ok: false; message: string }
> {
  const rpcUrl = getRpcUrl(env);
  const accept = expectedRequirement.accepts[0];
  if (!accept)
    return {
      ok: false,
      message: "Payment requirement is missing accept details.",
    };

  const expectedToken = accept.asset.toLowerCase();
  const expectedRecipient = accept.payTo.toLowerCase();
  const expectedAmount = accept.amount;
  const maxRetries = 15;
  const baseDelay = 1000;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const receipt = await rpcCall<Record<string, unknown> | null>(
        rpcUrl,
        "eth_getTransactionReceipt",
        [txHash],
      );
      if (!receipt) {
        if (attempt < maxRetries) {
          await sleep(baseDelay * (attempt + 1));
          continue;
        }
        return {
          ok: false,
          message: "Transaction not found on chain after multiple attempts.",
        };
      }
      if (receipt.status === "0x0" || receipt.status === false) {
        return { ok: false, message: "Transaction failed on chain." };
      }

      const tx = await rpcCall<Record<string, string> | null>(
        rpcUrl,
        "eth_getTransactionByHash",
        [txHash],
      );
      if (!tx) {
        return { ok: false, message: "Transaction not found." };
      }

      if (tx.to?.toLowerCase() !== expectedToken) {
        return {
          ok: false,
          message: "Transaction is not for the expected USDC contract.",
        };
      }

      const input = tx.input;
      if (!input || !input.startsWith("0xa9059cbb")) {
        return { ok: false, message: "Transaction is not an ERC-20 transfer." };
      }

      const recipientHex = input.slice(34, 74).toLowerCase();
      const recipient = `0x${recipientHex}`;
      const amountHex = input.slice(74, 138);
      const amount = BigInt(`0x${amountHex}`).toString();

      if (recipient !== expectedRecipient) {
        return {
          ok: false,
          message: "Transfer recipient does not match expected address.",
        };
      }

      if (amount !== expectedAmount) {
        return {
          ok: false,
          message: "Transfer amount does not match expected amount.",
        };
      }

      return {
        ok: true,
        txHash,
        payerAddress: tx.from,
        raw: { receipt, transaction: tx },
      };
    } catch (error) {
      if (attempt < maxRetries) {
        await sleep(baseDelay * (attempt + 1));
        continue;
      }
      const message =
        error instanceof HttpError
          ? error.message
          : "Transaction verification failed after multiple attempts.";
      return { ok: false, message };
    }
  }
  return { ok: false, message: "Transaction verification timed out." };
}

export async function readErc20Balance(
  rpcUrl: string,
  asset: string,
  owner: string,
): Promise<bigint> {
  const ownerSlot = owner.slice(2).toLowerCase().padStart(64, "0");
  const data = `0x70a08231${ownerSlot}`;
  const response = await fetch(rpcUrl, {
    method: "POST",
    headers: JSON_HEADERS,
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "eth_call",
      params: [{ to: asset, data }, "latest"],
    }),
  });
  const body = (await response.json().catch(() => null)) as {
    result?: unknown;
    error?: unknown;
  } | null;
  if (!response.ok || !body || typeof body.result !== "string") {
    throw new HttpError(
      502,
      "wallet_balance_lookup_failed",
      "Autopay wallet balance could not be loaded.",
      {
        rpc_status: response.status,
        rpc_error: body?.error ?? null,
      },
    );
  }
  return BigInt(body.result);
}

export function formatTokenAmount(raw: bigint, decimals: number): string {
  const scale = 10n ** BigInt(decimals);
  const whole = raw / scale;
  const fraction = raw % scale;
  if (fraction === 0n) return whole.toString();
  const fractionText = fraction
    .toString()
    .padStart(decimals, "0")
    .replace(/0+$/g, "");
  return `${whole}.${fractionText}`;
}

function facilitatorErrorMessage(json: Record<string, unknown>): string {
  if (typeof json.message === "string" && json.message) return json.message;
  if (typeof json.errorMessage === "string" && json.errorMessage)
    return json.errorMessage;
  if (typeof json.errorReason === "string" && json.errorReason)
    return json.errorReason;
  const error = json.error;
  if (error && typeof error === "object") {
    const record = error as Record<string, unknown>;
    if (typeof record.message === "string" && record.message)
      return record.message;
    if (typeof record.reason === "string" && record.reason)
      return record.reason;
  }
  return "Payment could not be verified.";
}

function base64UrlEncode(str: string): string {
  return btoa(str).replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");
}

function derToRawP256(der: Uint8Array): Uint8Array {
  let idx = 2;
  if (der[0] !== 0x30) throw new Error("Invalid DER signature");

  if (der[idx] !== 0x02) throw new Error("Invalid DER r tag");
  const rLen = der[idx + 1];
  let r = der.slice(idx + 2, idx + 2 + rLen);
  idx += 2 + rLen;

  if (der[idx] !== 0x02) throw new Error("Invalid DER s tag");
  const sLen = der[idx + 1];
  let s = der.slice(idx + 2, idx + 2 + sLen);

  const result = new Uint8Array(64);
  result.set(r.slice(-32), Math.max(0, 32 - r.length));
  result.set(s.slice(-32), 32 + Math.max(0, 32 - s.length));
  return result;
}

function buildEd25519Pkcs8(seed: Uint8Array): Uint8Array {
  const version = [0x02, 0x01, 0x00];
  const algId = [0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70];
  const innerOctet = [0x04, 0x20, ...seed];
  const outerOctet = [0x04, innerOctet.length, ...innerOctet];
  const content = [...version, ...algId, ...outerOctet];
  return new Uint8Array([0x30, content.length, ...content]);
}

async function generateCDPJWT(
  apiKeyId: string,
  apiKeySecret: string,
  method: string,
  host: string,
  path: string,
): Promise<string> {
  const trimmed = apiKeySecret.trim();
  const now = Math.floor(Date.now() / 1000);
  const nonce = Array.from(crypto.getRandomValues(new Uint8Array(16)))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");

  const claims = {
    iss: "cdp",
    sub: apiKeyId,
    aud: ["cdp"],
    iat: now,
    nbf: now,
    exp: now + 120,
    uris: [`${method} ${host}${path}`],
  };

  const headerB64 = base64UrlEncode(
    JSON.stringify({ alg: "EdDSA", typ: "JWT", kid: apiKeyId, nonce }),
  );
  const payloadB64 = base64UrlEncode(JSON.stringify(claims));
  const signingInput = new TextEncoder().encode(`${headerB64}.${payloadB64}`);

  if (trimmed.includes("BEGIN EC PRIVATE KEY")) {
    const base64 = trimmed
      .replace(/-----BEGIN EC PRIVATE KEY-----/g, "")
      .replace(/-----END EC PRIVATE KEY-----/g, "")
      .replace(/\s/g, "");
    const binary = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
    const privateKey = await crypto.subtle.importKey(
      "pkcs8",
      binary.buffer,
      { name: "ECDSA", namedCurve: "P-256" },
      false,
      ["sign"],
    );
    const ecHeaderB64 = base64UrlEncode(
      JSON.stringify({ alg: "ES256", typ: "JWT", kid: apiKeyId, nonce }),
    );
    const ecSigningInput = new TextEncoder().encode(
      `${ecHeaderB64}.${payloadB64}`,
    );
    const signature = await crypto.subtle.sign(
      { name: "ECDSA", hash: "SHA-256" },
      privateKey,
      ecSigningInput,
    );
    const rawSig = derToRawP256(new Uint8Array(signature));
    const sigB64 = base64UrlEncode(String.fromCharCode(...rawSig));
    return `${ecHeaderB64}.${payloadB64}.${sigB64}`;
  }

  const decoded = Uint8Array.from(atob(trimmed), (c) => c.charCodeAt(0));
  if (decoded.length !== 64) {
    throw new Error(
      `Invalid CDP API key secret length. Expected 64 bytes (base64 Ed25519) or PEM EC key. Got ${decoded.length} bytes.`,
    );
  }
  const seed = decoded.slice(0, 32);
  const pkcs8 = buildEd25519Pkcs8(seed);
  const privateKey = await crypto.subtle.importKey(
    "pkcs8",
    pkcs8.buffer as ArrayBuffer,
    "Ed25519",
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign(
    "Ed25519",
    privateKey,
    signingInput,
  );
  const sigB64 = base64UrlEncode(
    String.fromCharCode(...new Uint8Array(signature)),
  );
  return `${headerB64}.${payloadB64}.${sigB64}`;
}

function facilitatorEndpoint(
  baseUrl: string,
  action: "settle" | "verify",
): string {
  const trimmed = baseUrl.replace(/\/+$/g, "");
  if (trimmed.endsWith("/settle") || trimmed.endsWith("/verify")) {
    return trimmed;
  }
  return `${trimmed}/${action}`;
}

function facilitatorSettleBody(
  paymentRequirementJson: string,
  paymentPayload: unknown,
): Record<string, unknown> {
  const paymentRequired = JSON.parse(paymentRequirementJson) as Record<
    string,
    unknown
  >;
  const payload = paymentPayload as Record<string, unknown> | null;
  if (
    paymentRequired &&
    typeof paymentRequired === "object" &&
    Array.isArray(paymentRequired.accepts)
  ) {
    const accepted =
      payload &&
      typeof payload === "object" &&
      payload.accepted &&
      typeof payload.accepted === "object"
        ? payload.accepted
        : paymentRequired.accepts[0];
    return {
      x402Version:
        typeof payload?.x402Version === "number"
          ? payload.x402Version
          : paymentRequired.x402Version,
      paymentPayload,
      paymentRequirements: accepted,
    };
  }
  return {
    payment_payload: paymentPayload,
    payment_requirement: paymentRequired,
  };
}

function getX402AssetDomainName(env: Env): string {
  const configured = (
    env as { X402_ASSET_DOMAIN_NAME?: string }
  ).X402_ASSET_DOMAIN_NAME?.trim();
  if (configured) return configured;
  const network = env.X402_NETWORK || BASE_MAINNET;
  const asset = (env.X402_ASSET || BASE_USDC).toLowerCase();
  if (
    network === "eip155:84532" &&
    asset === "0x036cbd53842c5426634e7929541ec2318f3dcf7e"
  )
    return "USDC";
  if (network === BASE_MAINNET && asset === BASE_USDC.toLowerCase())
    return "USD Coin";
  return "USD Coin";
}

function getX402AssetDomainVersion(env: Env): string {
  return (
    (
      env as { X402_ASSET_DOMAIN_VERSION?: string }
    ).X402_ASSET_DOMAIN_VERSION?.trim() || "2"
  );
}

export function requireRecipientAddress(env: Env): string {
  const address = env.X402_RECIPIENT_ADDRESS?.trim();
  if (!address) {
    throw new HttpError(
      500,
      "missing_recipient_address",
      "X402_RECIPIENT_ADDRESS must be configured before creating payment quotes.",
    );
  }
  if (!/^0x[a-fA-F0-9]{40}$/.test(address)) {
    throw new HttpError(
      500,
      "invalid_recipient_address",
      "X402_RECIPIENT_ADDRESS must be a valid EVM address.",
    );
  }
  return address;
}

export function x402AmountFromMicroUsd(amount: number, env: Env): string {
  const decimals = parsePositiveInt(env.X402_ASSET_DECIMALS ?? "6", 6);
  if (decimals < 6) return String(Math.ceil(amount / 10 ** (6 - decimals)));
  return (BigInt(amount) * 10n ** BigInt(decimals - 6)).toString();
}

async function rpcCall<T = unknown>(
  rpcUrl: string,
  method: string,
  params: unknown[],
): Promise<T> {
  const response = await fetch(rpcUrl, {
    method: "POST",
    headers: JSON_HEADERS,
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const body = (await response.json().catch(() => null)) as {
    result?: T;
    error?: unknown;
  } | null;
  if (!response.ok || !body || body.error) {
    throw new HttpError(502, "rpc_error", `RPC call ${method} failed.`, {
      rpc_status: response.status,
      rpc_error: body?.error ?? null,
    });
  }
  return body.result!;
}
