import { base64UrlRandom, makeId } from "./crypto";
import { HttpError } from "./http";

export async function createApiKey(): Promise<{ id: string; secret: string; prefix: string; keySuffix: string }> {
  const id = makeId("key");
  const token = base64UrlRandom(32);
  const secret = `mia2_${token}`;
  return {
    id,
    secret,
    prefix: "mia2",
    keySuffix: secret.slice(-4),
  };
}

export function normalizeApiKeyName(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) return randomApiKeyName();
  const trimmed = value.trim();
  if (trimmed.length > 80) {
    throw new HttpError(400, "invalid_api_key_name", "API key name must be 80 characters or fewer.");
  }
  return trimmed;
}

export function randomApiKeyName(): string {
  return `key-${base64UrlRandom(5)}`;
}

export function normalizeApiKeyExpiresAt(value: unknown): string | null {
  if (value == null || value === "") return null;
  if (typeof value !== "string") {
    throw new HttpError(400, "invalid_api_key_expiration", "API key expiration must be an ISO timestamp.");
  }
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) {
    throw new HttpError(400, "invalid_api_key_expiration", "API key expiration must be a valid timestamp.");
  }
  if (date.getTime() <= Date.now()) {
    throw new HttpError(400, "invalid_api_key_expiration", "API key expiration must be in the future.");
  }
  return date.toISOString();
}

export function keyStatus(revokedAt: string | null, expiresAt: string | null): string {
  if (revokedAt) return "revoked";
  if (expiresAt && Date.parse(expiresAt) <= Date.now()) return "expired";
  return "active";
}
