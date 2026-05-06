ALTER TABLE autopay_authorizations ADD COLUMN capability_hash TEXT;
ALTER TABLE autopay_payments ADD COLUMN capability_hash TEXT;

CREATE INDEX idx_autopay_authorizations_capability ON autopay_authorizations(capability_hash);
CREATE INDEX idx_autopay_payments_capability ON autopay_payments(capability_hash);
