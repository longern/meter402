import { CORS_HEADERS, JSON_HEADERS } from "./constants";

export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly extra: Record<string, unknown> = {},
  ) {
    super(message);
  }
}

export function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body, null, 2), {
    ...init,
    headers: {
      ...JSON_HEADERS,
      ...CORS_HEADERS,
      ...(init.headers ?? {}),
    },
  });
}

export function errorResponse(status: number, code: string, message: string, extra: Record<string, unknown> = {}): Response {
  return jsonResponse({
    error: {
      type: status === 402 ? "payment_required" : "api_error",
      code,
      message,
      ...extra,
    },
  }, { status });
}

export function paymentRequiredResponse(code: string, message: string, extra: Record<string, unknown> = {}): Response {
  return errorResponse(402, code, message, extra);
}

export function cloneHeaders(headers: Headers): Headers {
  const output = new Headers(headers);
  output.set("access-control-allow-origin", "*");
  output.set("access-control-expose-headers", CORS_HEADERS["access-control-expose-headers"]);
  return output;
}

export function copyResponse(response: Response, extraHeaders: Record<string, string>): Response {
  const headers = cloneHeaders(response.headers);
  for (const [key, value] of Object.entries(extraHeaders)) {
    headers.set(key, value);
  }
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

export async function readJsonObject(request: Request): Promise<Record<string, unknown>> {
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

export async function readOptionalJsonObject(request: Request): Promise<Record<string, unknown>> {
  const text = await request.text();
  if (!text.trim()) return {};
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

export function requireString(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new HttpError(400, "missing_field", `${field} is required.`);
  }
  return value;
}

export function asHttpError(error: unknown): { status: number; code: string; message: string; extra?: Record<string, unknown> } | null {
  if (error instanceof HttpError) return error;
  if (!error || typeof error !== "object") return null;
  const candidate = error as Record<string, unknown>;
  if (
    typeof candidate.status === "number"
    && Number.isInteger(candidate.status)
    && candidate.status >= 400
    && candidate.status <= 599
    && typeof candidate.code === "string"
    && typeof candidate.message === "string"
  ) {
    return {
      status: candidate.status,
      code: candidate.code,
      message: candidate.message,
      extra: typeof candidate.extra === "object" && candidate.extra ? candidate.extra as Record<string, unknown> : undefined,
    };
  }
  return null;
}
