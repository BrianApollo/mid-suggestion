-- 0012: dashboard auth (users) + connection status on companies.

CREATE TABLE users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  email         TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,             -- pbkdf2$iters$salt$hash (src/lib/auth.js)
  company_id    INTEGER NOT NULL,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

-- connection health shown on the Settings page
ALTER TABLE companies ADD COLUMN connected      INTEGER NOT NULL DEFAULT 0;
ALTER TABLE companies ADD COLUMN last_ingest_at TEXT;
ALTER TABLE companies ADD COLUMN last_tested_at TEXT;
ALTER TABLE companies ADD COLUMN last_status    TEXT;

-- seed the Accotta login (admin@accotta.com) and mark it connected (it already has data +
-- a working ingest via the proxy). NOTE: this is a throwaway STAGING password hash — rotate
-- the credential before any non-staging use.
INSERT INTO users (email, password_hash, company_id)
VALUES ('admin@accotta.com', 'pbkdf2$100000$+TOwLI02b4Iri10m/LR1Bw==$MclR/db5m6vqhrEyashvXaG1rKXu8K0wCbOx20N49Qc=', 1);
UPDATE companies SET connected = 1 WHERE id = 1;
