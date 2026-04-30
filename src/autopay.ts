import { HttpError, requireString } from "./http";

export function normalizeAutopayUrl(value: unknown): string {
  const raw = requireString(value, "autopay_url");
  const url = new URL(raw);
  if (url.protocol !== "https:" && url.hostname !== "localhost" && url.hostname !== "127.0.0.1") {
    throw new HttpError(400, "invalid_autopay_url", "Autopay URL must use HTTPS.");
  }
  url.pathname = url.pathname.replace(/\/+$/g, "");
  url.search = "";
  url.hash = "";
  return url.toString().replace(/\/+$/g, "");
}
