import { privateKeyToAccount } from "viem/accounts";
import { getAddress, type Hex } from "viem";
import { BASE_MAINNET } from "./constants";
import { canonicalJson, sha256Hex } from "./crypto";
import { HttpError } from "./http";
import type { Env } from "./types";

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

export function requesterMetadata(env: Env, request: Request): Record<string, unknown> {
  const account = requesterAccount(env);
  const origin = requesterOrigin(env, request);
  return {
    name: env.AUTOPAY_REQUESTER_NAME?.trim() || "Meteria402",
    origin,
    account: requesterAccountId(env, account.address),
  };
}

export async function signedAutopayHeaders(
  env: Env,
  request: Request | null,
  targetUrl: string,
  bodyText: string,
  capabilityHash: string,
): Promise<Headers> {
  const account = requesterAccount(env);
  const now = Math.floor(Date.now() / 1000);
  const expiresAt = now + 60;
  const url = new URL(targetUrl);
  const message = {
    worker: url.origin,
    path: url.pathname,
    bodyHash: `0x${await sha256Hex(bodyText)}` as Hex,
    capabilityHash: normalizeBytes32(capabilityHash, "capability_hash"),
    nonce: crypto.randomUUID(),
    issuedAt: BigInt(now),
    expiresAt: BigInt(expiresAt),
  };
  const signature = await account.signTypedData({
    domain: requesterProofDomain(env),
    types: REQUESTER_PROOF_TYPES,
    primaryType: "AutopayPaymentRequest",
    message,
  });
  const headers = new Headers({
    "x-requester-account": requesterAccountId(env, account.address),
    "x-requester-nonce": message.nonce,
    "x-requester-issued-at": String(now),
    "x-requester-expires-at": String(expiresAt),
    "x-requester-signature": signature,
  });
  if (request) {
    headers.set("x-requester-origin", requesterOrigin(env, request));
  }
  return headers;
}

export async function hashAutopayCapability(capability: unknown): Promise<string> {
  if (!capability || typeof capability !== "object") {
    throw new HttpError(500, "invalid_autopay_capability", "Autopay capability is missing.");
  }
  const input = capability as Record<string, unknown>;
  const requester = input.requester && typeof input.requester === "object"
    ? input.requester as Record<string, unknown>
    : undefined;
  const canonical = {
    requester: requester
      ? {
          name: typeof requester.name === "string" ? requester.name : undefined,
          origin: typeof requester.origin === "string" ? new URL(requester.origin).origin : undefined,
          account: typeof requester.account === "string" ? requester.account : undefined,
        }
      : undefined,
    allowedOrigins: stringArray(input.allowedOrigins).map((origin) => new URL(origin).origin).sort(),
    allowedPayTo: stringArray(input.allowedPayTo).map((address) => address.toLowerCase()).sort(),
    network: stringField(input.network, "network"),
    asset: stringField(input.asset, "asset").toLowerCase(),
    maxSingleAmount: stringField(input.maxSingleAmount, "maxSingleAmount"),
    totalBudget: stringField(input.totalBudget, "totalBudget"),
    validBefore: stringField(input.validBefore, "validBefore"),
  };
  return sha256Hex(canonicalJson(canonical));
}

function requesterAccount(env: Env) {
  const key = env.X402_RECIPIENT_PRIVATE_KEY?.trim();
  if (!key || !/^0x[0-9a-fA-F]{64}$/.test(key)) {
    throw new HttpError(500, "missing_recipient_private_key", "X402_RECIPIENT_PRIVATE_KEY must be configured.");
  }
  const account = privateKeyToAccount(key as Hex);
  const recipient = env.X402_RECIPIENT_ADDRESS?.trim();
  if (recipient && getAddress(recipient) !== account.address) {
    throw new HttpError(500, "recipient_private_key_mismatch", "X402_RECIPIENT_PRIVATE_KEY must match X402_RECIPIENT_ADDRESS.");
  }
  return account;
}

function requesterOrigin(env: Env, request: Request | null): string {
  if (request) return new URL(request.url).origin;
  const origin = env.AUTOPAY_REQUESTER_ORIGIN?.trim();
  if (!origin) {
    throw new HttpError(500, "missing_requester_origin", "AUTOPAY_REQUESTER_ORIGIN must be configured for background autopay.");
  }
  return new URL(origin).origin;
}

function requesterAccountId(env: Env, address: string): string {
  return `${env.X402_NETWORK || BASE_MAINNET}:${address}`;
}

function requesterProofDomain(env: Env) {
  return {
    name: REQUESTER_PROOF_DOMAIN_NAME,
    version: REQUESTER_PROOF_VERSION,
    chainId: chainIdFromNetwork(env.X402_NETWORK || BASE_MAINNET),
  };
}

function chainIdFromNetwork(network: string): number {
  const [namespace, reference] = network.split(":");
  if (namespace !== "eip155") {
    throw new HttpError(400, "unsupported_requester_network", "Requester proof only supports EIP-155 accounts.");
  }
  const chainId = Number(reference);
  if (!Number.isSafeInteger(chainId) || chainId <= 0) {
    throw new HttpError(400, "invalid_requester_network", "Requester network must include a valid EIP-155 chain ID.");
  }
  return chainId;
}

function normalizeBytes32(value: string, field: string): Hex {
  const text = value.startsWith("0x") ? value : `0x${value}`;
  if (!/^0x[0-9a-fA-F]{64}$/.test(text)) {
    throw new HttpError(500, "invalid_requester_proof_input", `${field} must be a 32-byte hex string.`);
  }
  return text as Hex;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function stringField(value: unknown, field: string): string {
  if (typeof value !== "string" || !value) {
    throw new HttpError(500, "invalid_autopay_capability", `Autopay capability ${field} is missing.`);
  }
  return value;
}
