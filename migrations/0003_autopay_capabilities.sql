CREATE TABLE IF NOT EXISTS meteria402_autopay_capabilities (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES meteria402_accounts(id) ON DELETE CASCADE,
  owner_address TEXT NOT NULL,
  autopay_url TEXT NOT NULL,
  siwe_message TEXT NOT NULL,
  siwe_signature TEXT NOT NULL,
  capability_json TEXT NOT NULL,
  max_single_amount INTEGER NOT NULL,
  total_budget INTEGER NOT NULL,
  spent_amount INTEGER NOT NULL DEFAULT 0,
  valid_before TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  revoked_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_meteria402_autopay_capabilities_account_id ON meteria402_autopay_capabilities(account_id);
CREATE INDEX IF NOT EXISTS idx_meteria402_autopay_capabilities_valid_before ON meteria402_autopay_capabilities(valid_before);
CREATE INDEX IF NOT EXISTS idx_meteria402_autopay_capabilities_revoked_at ON meteria402_autopay_capabilities(revoked_at);
