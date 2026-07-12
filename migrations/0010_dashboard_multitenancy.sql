-- 0010_dashboard_multitenancy.sql
-- Adds what the routing dashboard needs on top of the single-tenant backend:
--   (1) per-company tenancy, (2) stored per-company config (versioned),
--   (3) a materialized `suggestions` table the checkout serving reads.
--
-- Bootstrap note: `company_id` defaults to 1 so all existing single-tenant data is
-- tagged as company 1 (Accotta) for free, and the running ingest/recompute keep working
-- during the transition. When ingest is generalized to set company_id per company,
-- drop the DEFAULT.

-- ── companies ────────────────────────────────────────────────────────────────
CREATE TABLE companies (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  name         TEXT NOT NULL,
  api_key      TEXT UNIQUE,        -- checkout /api/suggest identifies the company by this
  cc_login     TEXT,              -- CheckoutChamp API creds (staging only — move to a secret store before live)
  cc_password  TEXT,
  created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);
INSERT INTO companies (id, name, api_key) VALUES (1, 'Accotta', 'accotta-staging-key');

-- ── tag per-company tables (existing rows backfill to 1 via DEFAULT) ──────────
ALTER TABLE transactions ADD COLUMN company_id INTEGER NOT NULL DEFAULT 1;
ALTER TABLE mids         ADD COLUMN company_id INTEGER NOT NULL DEFAULT 1;
CREATE INDEX transactions_company ON transactions (company_id);
CREATE INDEX mids_company ON mids (company_id);

-- ── bank_mid needs company_id in its identity → rebuild (old PK was bank_id,mid_id) ──
CREATE TABLE bank_mid_v2 (
  company_id    INTEGER NOT NULL DEFAULT 1,
  bank_id       INTEGER NOT NULL,
  mid_id        INTEGER NOT NULL,
  success_count INTEGER NOT NULL DEFAULT 0,
  fail_count    INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (company_id, bank_id, mid_id)
);
INSERT INTO bank_mid_v2 (company_id, bank_id, mid_id, success_count, fail_count)
  SELECT 1, bank_id, mid_id, success_count, fail_count FROM bank_mid;
DROP TABLE bank_mid;
ALTER TABLE bank_mid_v2 RENAME TO bank_mid;

-- ── stored config, versioned per company ─────────────────────────────────────
CREATE TABLE config_versions (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id   INTEGER NOT NULL,
  version      INTEGER NOT NULL,
  config_json  TEXT NOT NULL,          -- the full config blob (API-CONTRACT §2)
  phasea_hash  TEXT NOT NULL,          -- hash of config.phaseA → skip re-aggregate when unchanged
  is_current   INTEGER NOT NULL DEFAULT 0,
  published_by TEXT,
  published_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX config_versions_current ON config_versions (company_id, is_current);

-- ── materialized suggestions — the checkout serving reads THIS ────────────────
CREATE TABLE suggestions (
  company_id      INTEGER NOT NULL,
  bank_id         INTEGER NOT NULL,
  allocation_json TEXT NOT NULL,       -- [{mid,pct}] — single = [{mid,pct:100}]
  source          TEXT,                -- strategy | override:pin|split|block|test
  computed_at     TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (company_id, bank_id)
);
