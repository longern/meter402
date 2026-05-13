CREATE TABLE IF NOT EXISTS meteria402_accounts (
  id TEXT PRIMARY KEY,
  status TEXT NOT NULL DEFAULT 'active',
  owner_address TEXT UNIQUE,
  autopay_url TEXT,
  deposit_balance INTEGER NOT NULL DEFAULT 0,
  unpaid_invoice_total INTEGER NOT NULL DEFAULT 0,
  concurrency_limit INTEGER NOT NULL DEFAULT 8,
  min_deposit_required INTEGER NOT NULL DEFAULT 0,
  autopay_min_recharge_amount INTEGER NOT NULL DEFAULT 10000,
  refund_address TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_meteria402_accounts_owner_lower
  ON meteria402_accounts(lower(owner_address));

CREATE TABLE IF NOT EXISTS meteria402_api_keys (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES meteria402_accounts(id) ON DELETE CASCADE,
  key_hash TEXT NOT NULL UNIQUE,
  key_prefix TEXT NOT NULL,
  key_suffix TEXT NOT NULL,
  name TEXT,
  expires_at TEXT,
  spend_limit INTEGER,
  spent_amount INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  revoked_at TEXT,
  deleted_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_meteria402_api_keys_account_deleted_created
  ON meteria402_api_keys(account_id, deleted_at, created_at DESC);

CREATE TABLE IF NOT EXISTS meteria402_requests (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES meteria402_accounts(id) ON DELETE CASCADE,
  api_key_id TEXT REFERENCES meteria402_api_keys(id) ON DELETE SET NULL,
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

CREATE INDEX IF NOT EXISTS idx_meteria402_requests_api_key_id ON meteria402_requests(api_key_id);
CREATE INDEX IF NOT EXISTS idx_meteria402_requests_account_started
  ON meteria402_requests(account_id, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_meteria402_requests_account_status_completed
  ON meteria402_requests(account_id, status, completed_at ASC);
CREATE INDEX IF NOT EXISTS idx_meteria402_requests_status_completed
  ON meteria402_requests(status, completed_at ASC);

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

CREATE INDEX IF NOT EXISTS idx_meteria402_invoices_request_id
  ON meteria402_invoices(request_id);
CREATE INDEX IF NOT EXISTS idx_meteria402_invoices_account_unpaid_created
  ON meteria402_invoices(
    account_id,
    CASE WHEN status = 'unpaid' THEN 0 ELSE 1 END,
    created_at DESC
  );

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

CREATE INDEX IF NOT EXISTS idx_meteria402_payments_invoice_id ON meteria402_payments(invoice_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_meteria402_payments_payload_hash
  ON meteria402_payments(x402_payload_hash)
  WHERE x402_payload_hash IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_meteria402_payments_account_kind_settled
  ON meteria402_payments(account_id, kind, settled_at DESC);

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

CREATE INDEX IF NOT EXISTS idx_meteria402_autopay_requests_payment_created
  ON meteria402_autopay_requests(payment_id, created_at DESC);

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

CREATE INDEX IF NOT EXISTS idx_meteria402_autopay_capabilities_account_created
  ON meteria402_autopay_capabilities(account_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_meteria402_autopay_capabilities_active_account_created
  ON meteria402_autopay_capabilities(account_id, created_at DESC)
  WHERE revoked_at IS NULL;

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
