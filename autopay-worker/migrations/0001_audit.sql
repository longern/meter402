CREATE TABLE autopay_authorizations (
  id TEXT PRIMARY KEY,
  request_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('payment', 'login')),
  owner TEXT,
  worker_origin TEXT NOT NULL,
  policy_network TEXT,
  policy_asset TEXT,
  policy_max_single_amount TEXT,
  policy_valid_before TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'denied', 'expired')),
  created_at TEXT NOT NULL,
  approved_at TEXT,
  expires_at TEXT NOT NULL,
  capability_hash TEXT
);

CREATE INDEX idx_autopay_authorizations_owner ON autopay_authorizations(owner);
CREATE INDEX idx_autopay_authorizations_status ON autopay_authorizations(status);
CREATE INDEX idx_autopay_authorizations_created ON autopay_authorizations(created_at);
CREATE INDEX idx_autopay_authorizations_capability ON autopay_authorizations(capability_hash);

CREATE TABLE autopay_payments (
  id TEXT PRIMARY KEY,
  authorization_id TEXT,
  capability_hash TEXT,
  owner TEXT NOT NULL,
  network TEXT,
  asset TEXT,
  pay_to TEXT,
  amount TEXT NOT NULL,
  amount_decimal TEXT,
  currency TEXT DEFAULT 'USD',
  resource_url TEXT,
  requester_account TEXT,
  requester_nonce TEXT,
  requester_proof_expires_at TEXT,
  requester_signature TEXT,
  tx_hash TEXT,
  status TEXT NOT NULL DEFAULT 'created' CHECK (status IN ('created', 'submitted', 'confirmed', 'failed')),
  error_message TEXT,
  created_at TEXT NOT NULL,
  settled_at TEXT
);

CREATE INDEX idx_autopay_payments_owner ON autopay_payments(owner);
CREATE INDEX idx_autopay_payments_authz ON autopay_payments(authorization_id);
CREATE INDEX idx_autopay_payments_created ON autopay_payments(created_at);
CREATE INDEX idx_autopay_payments_capability ON autopay_payments(capability_hash);
CREATE UNIQUE INDEX idx_autopay_payments_requester_nonce
  ON autopay_payments(requester_account, requester_nonce);

CREATE TABLE autopay_sessions (
  id TEXT PRIMARY KEY,
  owner TEXT NOT NULL,
  token TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  revoked_at TEXT
);

CREATE INDEX idx_autopay_sessions_token ON autopay_sessions(token);
CREATE INDEX idx_autopay_sessions_owner ON autopay_sessions(owner);

CREATE TABLE autopay_capability_budgets (
  capability_hash TEXT PRIMARY KEY,
  owner TEXT NOT NULL,
  total_budget TEXT NOT NULL,
  max_single_amount TEXT NOT NULL,
  spent_amount TEXT NOT NULL DEFAULT '0',
  valid_before TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX idx_autopay_capability_budgets_owner ON autopay_capability_budgets(owner);
CREATE INDEX idx_autopay_capability_budgets_valid_before ON autopay_capability_budgets(valid_before);
