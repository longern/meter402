ALTER TABLE meteria402_requests ADD COLUMN api_key_id TEXT REFERENCES meteria402_api_keys(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_meteria402_requests_api_key_id ON meteria402_requests(api_key_id);
