ALTER TABLE meteria402_api_keys ADD COLUMN spend_limit INTEGER;
ALTER TABLE meteria402_api_keys ADD COLUMN spent_amount INTEGER NOT NULL DEFAULT 0;

UPDATE meteria402_api_keys
SET spent_amount = COALESCE((
  SELECT SUM(final_cost)
  FROM meteria402_requests
  WHERE meteria402_requests.api_key_id = meteria402_api_keys.id
), 0);
