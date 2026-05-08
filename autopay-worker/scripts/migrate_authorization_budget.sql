-- One-time migration for existing autopay-worker D1 databases.
--
-- Moves capability budget state from autopay_capability_budgets into
-- autopay_authorizations and adds requester_origin for new audit rows.
--
-- Run once against databases that were created before the merged
-- autopay_authorizations schema. This script is intentionally not idempotent:
-- running it after these columns already exist will fail.

BEGIN TRANSACTION;

ALTER TABLE autopay_authorizations ADD COLUMN requester_origin TEXT;
ALTER TABLE autopay_authorizations ADD COLUMN policy_total_budget TEXT;
ALTER TABLE autopay_authorizations ADD COLUMN reserved_amount TEXT NOT NULL DEFAULT '0';

UPDATE autopay_authorizations
SET
  policy_total_budget = COALESCE(
    policy_total_budget,
    (
      SELECT total_budget
      FROM autopay_capability_budgets
      WHERE autopay_capability_budgets.capability_hash = autopay_authorizations.capability_hash
    )
  ),
  policy_max_single_amount = COALESCE(
    policy_max_single_amount,
    (
      SELECT max_single_amount
      FROM autopay_capability_budgets
      WHERE autopay_capability_budgets.capability_hash = autopay_authorizations.capability_hash
    )
  ),
  policy_valid_before = COALESCE(
    policy_valid_before,
    (
      SELECT valid_before
      FROM autopay_capability_budgets
      WHERE autopay_capability_budgets.capability_hash = autopay_authorizations.capability_hash
    )
  ),
  reserved_amount = COALESCE(
    (
      SELECT spent_amount
      FROM autopay_capability_budgets
      WHERE autopay_capability_budgets.capability_hash = autopay_authorizations.capability_hash
    ),
    reserved_amount,
    '0'
  )
WHERE capability_hash IS NOT NULL
  AND EXISTS (
    SELECT 1
    FROM autopay_capability_budgets
    WHERE autopay_capability_budgets.capability_hash = autopay_authorizations.capability_hash
  );

CREATE INDEX IF NOT EXISTS idx_autopay_authorizations_requester_origin
  ON autopay_authorizations(requester_origin);

DROP TABLE autopay_capability_budgets;

COMMIT;
