import { HttpError } from "./http";

export function parseMoney(value: string): number {
  const trimmed = value.trim();
  if (!/^\d+(\.\d{1,6})?$/.test(trimmed)) {
    throw new HttpError(400, "invalid_amount", "Amount must be a positive decimal with up to six fractional digits.");
  }
  const [whole, fraction = ""] = trimmed.split(".");
  return Number(whole) * 1_000_000 + Number(fraction.padEnd(6, "0"));
}

export function parseMoneyLikeNumber(value: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) return 0;
  return parsed;
}

export function formatMoney(microUsd: number): string {
  const sign = microUsd < 0 ? "-" : "";
  const abs = Math.abs(Math.round(microUsd));
  const whole = Math.floor(abs / 1_000_000);
  const fraction = String(abs % 1_000_000).padStart(6, "0").replace(/0+$/g, "");
  return `${sign}${whole}${fraction ? `.${fraction}` : ".00"}`;
}

export function parsePositiveInt(value: string, fallback: number): number {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export function numberFromUnknown(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return Math.max(0, Math.floor(value));
}
