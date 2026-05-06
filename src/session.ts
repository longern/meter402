import { HttpError } from "./http";
import { verifySessionState } from "./signed-state";
import type { Env, SessionState } from "./types";
import { normalizeEvmAddress } from "./x402";

const SESSION_COOKIE_NAME = "meteria402_session";
const SESSION_TTL_SECONDS = 7 * 24 * 60 * 60;

export async function requireSession(
  request: Request,
  env: Env,
): Promise<SessionState> {
  const token = readCookie(request, SESSION_COOKIE_NAME);
  if (!token) {
    throw new HttpError(401, "missing_session", "Login is required.");
  }
  const session = await verifySessionState(env, token);
  return {
    ...session,
    owner: normalizeEvmAddress(session.owner),
  };
}

export async function readOptionalSession(
  request: Request,
  env: Env,
): Promise<SessionState | null> {
  const token = readCookie(request, SESSION_COOKIE_NAME);
  if (!token) return null;
  try {
    const session = await verifySessionState(env, token);
    return {
      ...session,
      owner: normalizeEvmAddress(session.owner),
    };
  } catch {
    return null;
  }
}

export function serializeSessionCookie(
  request: Request,
  token: string,
  expiresAt: number,
): string {
  const attributes = [
    `${SESSION_COOKIE_NAME}=${encodeURIComponent(token)}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${SESSION_TTL_SECONDS}`,
    `Expires=${new Date(expiresAt).toUTCString()}`,
  ];
  if (new URL(request.url).protocol === "https:") attributes.push("Secure");
  return attributes.join("; ");
}

export function serializeExpiredSessionCookie(request: Request): string {
  const attributes = [
    `${SESSION_COOKIE_NAME}=`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    "Max-Age=0",
    "Expires=Thu, 01 Jan 1970 00:00:00 GMT",
  ];
  if (new URL(request.url).protocol === "https:") attributes.push("Secure");
  return attributes.join("; ");
}

export function sessionExpiresAt(): number {
  return Date.now() + SESSION_TTL_SECONDS * 1000;
}

function readCookie(request: Request, name: string): string | null {
  const header = request.headers.get("cookie");
  if (!header) return null;
  for (const part of header.split(";")) {
    const index = part.indexOf("=");
    if (index < 0) continue;
    const key = part.slice(0, index).trim();
    if (key !== name) continue;
    return decodeURIComponent(part.slice(index + 1).trim());
  }
  return null;
}
