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

-- 出于安全考虑：past session cleanup（保留 7 天日志）
DELETE FROM autopay_sessions WHERE revoked_at IS NOT NULL AND revoked_at < datetime('now', '-7 days');
