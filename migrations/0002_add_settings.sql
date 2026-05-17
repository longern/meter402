CREATE TABLE IF NOT EXISTS meteria402_settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

INSERT OR IGNORE INTO meteria402_settings (key, value) VALUES
  ('default_min_deposit', '5000000'),
  ('default_concurrency_limit', '8'),
  ('default_autopay_min_recharge', '5000000'),
  ('billing_cost_multiplier', '1.0');
