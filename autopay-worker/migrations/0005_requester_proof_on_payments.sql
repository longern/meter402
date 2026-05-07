ALTER TABLE autopay_payments ADD COLUMN requester_account TEXT;
ALTER TABLE autopay_payments ADD COLUMN requester_nonce TEXT;
ALTER TABLE autopay_payments ADD COLUMN requester_proof_expires_at TEXT;
ALTER TABLE autopay_payments ADD COLUMN requester_signature TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS idx_autopay_payments_requester_nonce
  ON autopay_payments(requester_account, requester_nonce);
