CREATE TABLE IF NOT EXISTS meteria402_accounts (
  id TEXT PRIMARY KEY,
  status TEXT NOT NULL DEFAULT 'active',
  owner_address TEXT UNIQUE,
  autopay_url TEXT,
  deposit_balance INTEGER NOT NULL DEFAULT 0,
  unpaid_invoice_total INTEGER NOT NULL DEFAULT 0,
  active_request_count INTEGER NOT NULL DEFAULT 0,
  concurrency_limit INTEGER NOT NULL DEFAULT 1,
  min_deposit_required INTEGER NOT NULL DEFAULT 0,
  refund_address TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS meteria402_api_keys (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES meteria402_accounts(id) ON DELETE CASCADE,
  key_hash TEXT NOT NULL UNIQUE,
  key_prefix TEXT NOT NULL,
  key_suffix TEXT NOT NULL,
  name TEXT,
  expires_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  revoked_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_meteria402_api_keys_account_id ON meteria402_api_keys(account_id);
CREATE INDEX IF NOT EXISTS idx_meteria402_api_keys_expires_at ON meteria402_api_keys(expires_at);

CREATE TABLE IF NOT EXISTS meteria402_requests (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES meteria402_accounts(id) ON DELETE CASCADE,
  status TEXT NOT NULL,
  model TEXT,
  stream INTEGER NOT NULL DEFAULT 0,
  ai_gateway_log_id TEXT,
  input_tokens INTEGER,
  output_tokens INTEGER,
  total_tokens INTEGER,
  estimated_cost INTEGER,
  final_cost INTEGER,
  error_code TEXT,
  started_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  completed_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_meteria402_requests_account_id ON meteria402_requests(account_id);
CREATE INDEX IF NOT EXISTS idx_meteria402_requests_status ON meteria402_requests(status);

CREATE TABLE IF NOT EXISTS meteria402_invoices (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES meteria402_accounts(id) ON DELETE CASCADE,
  request_id TEXT REFERENCES meteria402_requests(id) ON DELETE SET NULL,
  status TEXT NOT NULL,
  amount_due INTEGER NOT NULL,
  currency TEXT NOT NULL DEFAULT 'USD',
  payment_requirement_json TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  paid_at TEXT,
  voided_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_meteria402_invoices_account_id ON meteria402_invoices(account_id);
CREATE INDEX IF NOT EXISTS idx_meteria402_invoices_status ON meteria402_invoices(status);

CREATE TABLE IF NOT EXISTS meteria402_payments (
  id TEXT PRIMARY KEY,
  account_id TEXT REFERENCES meteria402_accounts(id) ON DELETE SET NULL,
  invoice_id TEXT REFERENCES meteria402_invoices(id) ON DELETE SET NULL,
  kind TEXT NOT NULL,
  amount INTEGER NOT NULL,
  currency TEXT NOT NULL DEFAULT 'USD',
  status TEXT NOT NULL,
  x402_payload_hash TEXT,
  tx_hash TEXT,
  payment_requirement_json TEXT,
  response_json TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  settled_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_meteria402_payments_account_id ON meteria402_payments(account_id);
CREATE INDEX IF NOT EXISTS idx_meteria402_payments_invoice_id ON meteria402_payments(invoice_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_meteria402_payments_payload_hash
  ON meteria402_payments(x402_payload_hash)
  WHERE x402_payload_hash IS NOT NULL;

CREATE TABLE IF NOT EXISTS meteria402_autopay_requests (
  id TEXT PRIMARY KEY,
  payment_id TEXT NOT NULL REFERENCES meteria402_payments(id) ON DELETE CASCADE,
  account_id TEXT REFERENCES meteria402_accounts(id) ON DELETE CASCADE,
  invoice_id TEXT REFERENCES meteria402_invoices(id) ON DELETE SET NULL,
  autopay_url TEXT NOT NULL,
  autopay_request_id TEXT NOT NULL,
  poll_token TEXT NOT NULL,
  status TEXT NOT NULL,
  verification_uri_complete TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  approved_at TEXT,
  settled_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_meteria402_autopay_requests_payment_id ON meteria402_autopay_requests(payment_id);
CREATE INDEX IF NOT EXISTS idx_meteria402_autopay_requests_account_id ON meteria402_autopay_requests(account_id);
CREATE INDEX IF NOT EXISTS idx_meteria402_autopay_requests_status ON meteria402_autopay_requests(status);

CREATE TABLE IF NOT EXISTS meteria402_ledger_entries (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES meteria402_accounts(id) ON DELETE CASCADE,
  type TEXT NOT NULL,
  amount INTEGER NOT NULL,
  currency TEXT NOT NULL DEFAULT 'USD',
  related_request_id TEXT,
  related_invoice_id TEXT,
  related_payment_id TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_meteria402_ledger_entries_account_id ON meteria402_ledger_entries(account_id);
CREATE INDEX IF NOT EXISTS idx_meteria402_ledger_entries_type ON meteria402_ledger_entries(type);
