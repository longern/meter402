import { DEFAULT_GATEWAY_PROVIDER } from "./gateway-providers";
import { numberFromUnknown } from "./money";
import type { Env,Usage } from "./types";

export function buildAiGatewayRequest(
  env: Env,
  provider: string,
  body: BodyInit | null,
  endpoint: string,
  contentType: string | null,
  method = "POST",
  search = "",
  requestId?: string,
  sourceHeaders?: Headers,
): Request {
  const upstreamUrl = env.UPSTREAM_BASE_URL;
  if (upstreamUrl) {
    const url = `${formatUpstreamBaseUrl(upstreamUrl, provider)}/${endpoint}${search}`;
    const headers = buildUpstreamHeaders(
      env,
      provider,
      contentType,
      sourceHeaders,
    );
    addAiGatewayAuthHeaders(headers, env);
    addAiGatewayLogHeaders(headers, requestId);
    return new Request(url, {
      method,
      headers,
      ...(body == null ? {} : { body }),
    });
  }

  const gatewayId = env.AI_GATEWAY_ID || "default";
  const gatewayProvider = provider || DEFAULT_GATEWAY_PROVIDER;
  const url = `https://gateway.ai.cloudflare.com/v1/${encodeURIComponent(env.CLOUDFLARE_ACCOUNT_ID || "")}/${encodeURIComponent(gatewayId)}/${encodeURIComponent(gatewayProvider)}/${endpoint}${search}`;
  const headers = buildUpstreamHeaders(
    env,
    gatewayProvider,
    contentType,
    sourceHeaders,
  );
  addAiGatewayAuthHeaders(headers, env);
  addAiGatewayLogHeaders(headers, requestId);
  return new Request(url, {
    method,
    headers,
    ...(body == null ? {} : { body }),
  });
}

export function getAiGatewayLogId(headers: Headers): string | null {
  return headers.get("cf-aig-log-id") ?? headers.get("cf-ai-gateway-log-id");
}

export async function fetchAiGatewayLogCost(
  env: Env,
  logId: string,
): Promise<{ id: string; cost: number; usage?: Usage } | null> {
  const lookup = aiGatewayLogLookupConfig(env);
  if (!lookup) {
    console.warn("AI Gateway log lookup skipped", logLookupWarning(env, logId));
    return null;
  }

  const url =
    `${lookup.baseUrl}` +
    `/logs/${encodeURIComponent(logId)}`;
  let response: Response | null = null;
  for (const token of lookup.tokens) {
    response = await fetch(url, {
      headers: { authorization: `Bearer ${token}` },
    });
    if (response.ok || response.status === 404) break;
    if (response.status !== 401 && response.status !== 403) break;
  }
  if (!response || response.status === 404) return null;
  if (!response.ok) {
    console.error("AI Gateway log lookup failed", {
      status: response.status,
      logId,
    });
    return null;
  }

  const body = (await response.json().catch(() => null)) as
    | { result?: unknown }
    | null;
  const result =
    body && typeof body.result === "object" && body.result
      ? (body.result as Record<string, unknown>)
      : null;
  if (!result) {
    console.warn("AI Gateway log lookup returned no result", { logId, body });
    return null;
  }

  const dollarCost =
    typeof result.cost === "number"
      ? result.cost
      : typeof result.cost === "string"
        ? Number(result.cost)
        : null;
  if (dollarCost == null || !Number.isFinite(dollarCost)) {
    console.warn("AI Gateway log lookup returned no cost", {
      logId,
      cost: result.cost,
      tokens_in: result.tokens_in,
      tokens_out: result.tokens_out,
    });
    return null;
  }

  const cost = applyBillingCostMultiplier(
    env,
    Math.max(1, Math.ceil(dollarCost * 1_000_000)),
  );
  return {
    id: logId,
    cost,
    usage: usageFromAiGatewayLog(result),
  };
}

export async function fetchAiGatewayLogByEventId(
  env: Env,
  eventId: string,
): Promise<{ id: string; cost: number; usage?: Usage } | null> {
  const lookup = aiGatewayLogLookupConfig(env);
  if (!lookup) {
    console.warn("AI Gateway event lookup skipped", logLookupWarning(env, eventId));
    return null;
  }

  const urls = [
    buildAiGatewayEventFilterUrl(lookup.baseUrl, eventId),
    buildAiGatewayRecentLogsUrl(lookup.baseUrl),
  ];

  for (let index = 0; index < urls.length; index += 1) {
    const url = urls[index];
    for (const token of lookup.tokens) {
      const response = await fetch(url, {
        headers: { authorization: `Bearer ${token}` },
      });
      if (response.status === 401 || response.status === 403) continue;
      if (!response.ok) {
        console.error("AI Gateway event lookup failed", {
          status: response.status,
          eventId,
        });
        break;
      }

      const body = (await response.json().catch(() => null)) as
        | { result?: unknown }
        | null;
      const rows = Array.isArray(body?.result) ? body.result : [];
      for (const row of rows) {
        const log = normalizeAiGatewayLog(row);
        if (
          log &&
          (log.eventId === eventId || log.metadataRequestId === eventId)
        ) {
          return {
            ...log,
            cost: applyBillingCostMultiplier(env, log.cost),
          };
        }
      }
    }
  }

  return null;
}

function applyBillingCostMultiplier(env: Env, cost: number): number {
  const multiplier = billingCostMultiplier(env);
  return Math.max(1, Math.ceil(cost * multiplier));
}

function billingCostMultiplier(env: Env): number {
  const configured = env.BILLING_COST_MULTIPLIER?.trim();
  if (!configured) return 1.055;
  const value = Number(configured);
  return Number.isFinite(value) && value > 0 ? value : 1.055;
}

export function extractUsageFromText(text: string): Usage | null {
  try {
    const json = JSON.parse(text) as { usage?: unknown };
    return normalizeUsage(json.usage);
  } catch {
    return null;
  }
}

function formatUpstreamBaseUrl(upstreamUrl: string, provider: string): string {
  const base = upstreamUrl.replace(/\/$/, "");
  if (base.includes("{provider}")) {
    return base.replaceAll("{provider}", encodeURIComponent(provider));
  }
  return base;
}

function aiGatewayLogLookupConfig(
  env: Env,
): { baseUrl: string; tokens: string[] } | null {
  const tokens = [
    env.CLOUDFLARE_API_TOKEN,
    env.AI_GATEWAY_AUTH_TOKEN,
    env.AI_GATEWAY_API_KEY,
  ].filter((token): token is string => Boolean(token));
  const accountId = env.CLOUDFLARE_ACCOUNT_ID;
  if (tokens.length === 0 || !accountId) return null;
  const gatewayId = env.AI_GATEWAY_ID || "default";
  return {
    baseUrl:
      `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(accountId)}` +
      `/ai-gateway/gateways/${encodeURIComponent(gatewayId)}`,
    tokens,
  };
}

function logLookupWarning(env: Env, id: string): Record<string, unknown> {
  return {
    id,
    hasAccountId: Boolean(env.CLOUDFLARE_ACCOUNT_ID),
    hasCloudflareApiToken: Boolean(env.CLOUDFLARE_API_TOKEN),
    hasGatewayAuthToken: Boolean(env.AI_GATEWAY_AUTH_TOKEN),
    hasGatewayApiKey: Boolean(env.AI_GATEWAY_API_KEY),
  };
}

function buildAiGatewayEventFilterUrl(baseUrl: string, eventId: string): string {
  const url = new URL(`${baseUrl}/logs`);
  url.searchParams.set("per_page", "10");
  url.searchParams.set("order_by", "created_at");
  url.searchParams.set("order_by_direction", "desc");
  url.searchParams.set("filters[0][key]", "event_id");
  url.searchParams.set("filters[0][operator]", "eq");
  url.searchParams.set("filters[0][value][0]", eventId);
  return url.toString();
}

function buildAiGatewayRecentLogsUrl(baseUrl: string): string {
  const url = new URL(`${baseUrl}/logs`);
  url.searchParams.set("per_page", "50");
  url.searchParams.set("order_by", "created_at");
  url.searchParams.set("order_by_direction", "desc");
  return url.toString();
}

function normalizeAiGatewayLog(
  value: unknown,
): {
  id: string;
  eventId?: string;
  metadataRequestId?: string;
  cost: number;
  usage?: Usage;
} | null {
  if (!value || typeof value !== "object") return null;
  const log = value as Record<string, unknown>;
  const id = typeof log.id === "string" ? log.id : "";
  if (!id) return null;
  const eventId =
    typeof log.event_id === "string"
      ? log.event_id
      : typeof log.eventId === "string"
        ? log.eventId
        : undefined;
  const dollarCost =
    typeof log.cost === "number"
      ? log.cost
      : typeof log.cost === "string"
        ? Number(log.cost)
        : null;
  if (dollarCost == null || !Number.isFinite(dollarCost)) return null;
  return {
    id,
    eventId,
    metadataRequestId: requestIdFromLogMetadata(log.metadata),
    cost: Math.max(1, Math.ceil(dollarCost * 1_000_000)),
    usage: usageFromAiGatewayLog(log),
  };
}

function requestIdFromLogMetadata(metadata: unknown): string | undefined {
  let parsed = metadata;
  if (typeof metadata === "string") {
    try {
      parsed = JSON.parse(metadata) as unknown;
    } catch {
      return undefined;
    }
  }
  if (!parsed || typeof parsed !== "object") return undefined;
  const requestId = (parsed as Record<string, unknown>).request_id;
  return typeof requestId === "string" ? requestId : undefined;
}

function buildUpstreamHeaders(
  env: Env,
  provider: string,
  contentType: string | null,
  sourceHeaders?: Headers,
): Headers {
  const headers = new Headers();
  if (contentType) {
    headers.set("content-type", contentType);
  }
  copyProviderHeaders(headers, provider, sourceHeaders);
  addProviderApiKeyHeaders(headers, env, provider);
  return headers;
}

function copyProviderHeaders(
  headers: Headers,
  provider: string,
  sourceHeaders?: Headers,
): void {
  if (!sourceHeaders) return;

  const allowlist = new Set([
    "accept",
    "anthropic-beta",
    "anthropic-version",
    "openai-organization",
    "openai-project",
    "x-goog-api-client",
  ]);

  if (provider === "openrouter") {
    allowlist.add("http-referer");
    allowlist.add("x-title");
  }

  for (const name of allowlist) {
    const value = sourceHeaders.get(name);
    if (value) headers.set(name, value);
  }
}

function addProviderApiKeyHeaders(
  headers: Headers,
  env: Env,
  provider: string,
): void {
  if (!env.AI_GATEWAY_API_KEY) return;
  if (provider === "anthropic") {
    headers.set("x-api-key", env.AI_GATEWAY_API_KEY);
    return;
  }
  if (provider === "google-ai-studio") {
    headers.set("x-goog-api-key", env.AI_GATEWAY_API_KEY);
    return;
  }
  headers.set("authorization", `Bearer ${env.AI_GATEWAY_API_KEY}`);
}

function addAiGatewayLogHeaders(headers: Headers, requestId?: string): void {
  if (!requestId) return;
  headers.set("cf-aig-collect-log-payload", "false");
  headers.set("cf-aig-metadata", JSON.stringify({ request_id: requestId }));
}

function addAiGatewayAuthHeaders(headers: Headers, env: Env): void {
  if (env.AI_GATEWAY_AUTH_TOKEN) {
    headers.set("cf-aig-authorization", `Bearer ${env.AI_GATEWAY_AUTH_TOKEN}`);
  }
}

function usageFromAiGatewayLog(log: Record<string, unknown>): Usage | undefined {
  const inputTokens = numberFromUnknown(log.tokens_in);
  const outputTokens = numberFromUnknown(log.tokens_out);
  if (inputTokens == null && outputTokens == null) return undefined;
  const input = inputTokens ?? 0;
  const output = outputTokens ?? 0;
  const total = numberFromUnknown(log.total_tokens) ?? input + output;
  return { inputTokens: input, outputTokens: output, totalTokens: total };
}

function normalizeUsage(value: unknown): Usage | null {
  if (!value || typeof value !== "object") return null;
  const usage = value as Record<string, unknown>;
  const input = numberFromUnknown(usage.prompt_tokens ?? usage.input_tokens);
  const output = numberFromUnknown(
    usage.completion_tokens ?? usage.output_tokens,
  );
  const total =
    numberFromUnknown(usage.total_tokens) ?? (input ?? 0) + (output ?? 0);
  if (input == null && output == null && total === 0) return null;
  return {
    inputTokens: input ?? Math.max(0, total - (output ?? 0)),
    outputTokens: output ?? Math.max(0, total - (input ?? 0)),
    totalTokens: total,
  };
}
