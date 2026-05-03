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
