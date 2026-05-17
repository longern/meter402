import type { Env } from "./types";

const DEFAULT_SETTINGS: Record<string, string> = {
  default_min_deposit: "5000000",
  default_concurrency_limit: "8",
  default_autopay_min_recharge: "5000000",
  billing_cost_multiplier: "1.055",
};

export async function ensureSettingsDefaults(db: D1Database): Promise<void> {
  for (const [key, value] of Object.entries(DEFAULT_SETTINGS)) {
    await db
      .prepare(
        `INSERT OR IGNORE INTO meteria402_settings (key, value) VALUES (?, ?)`
      )
      .bind(key, value)
      .run();
  }
}

export async function getSetting(
  db: D1Database,
  key: string,
): Promise<string | null> {
  const row = await db
    .prepare(`SELECT value FROM meteria402_settings WHERE key = ?`)
    .bind(key)
    .first<{ value: string }>();
  return row?.value ?? null;
}

export async function getSettingWithFallback(
  db: D1Database,
  key: string,
  envValue?: string,
): Promise<string> {
  const dbValue = await getSetting(db, key);
  if (dbValue !== null) return dbValue;
  if (envValue !== undefined) return envValue;
  const fallback = DEFAULT_SETTINGS[key];
  if (fallback !== undefined) return fallback;
  throw new Error(`Missing setting: ${key}`);
}

export async function setSetting(
  db: D1Database,
  key: string,
  value: string,
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO meteria402_settings (key, value, updated_at)
       VALUES (?, ?, datetime('now'))
       ON CONFLICT(key) DO UPDATE SET
         value = excluded.value,
         updated_at = excluded.updated_at`
    )
    .bind(key, value)
    .run();
}

export async function listSettings(db: D1Database): Promise<Record<string, string>> {
  const rows = await db
    .prepare(`SELECT key, value FROM meteria402_settings`)
    .all<{ key: string; value: string }>();
  const result: Record<string, string> = {};
  for (const row of rows.results ?? []) {
    result[row.key] = row.value;
  }
  return result;
}
