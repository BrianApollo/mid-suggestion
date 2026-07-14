-- 0016_recompute_cache.sql
-- Cache the expensive combo aggregation (aggregateOverview output) so a publish that doesn't
-- change PhaseA (or recency, or the underlying transactions/mids) can skip the full combo scan
-- and re-run only allocate(). One slot per company = the latest aggregation.
--
-- Validity is proven by three signatures stored alongside the blob:
--   phasea_hash    — hash of config.phaseA (which mids to count + noise filters)
--   recency_hash   — 'off' when recency disabled, else hash of the recency weights
--   tx_fingerprint — transactions COUNT/MAX(id)/MAX(updated_at) + a hash of the mids rows
-- A cache HIT requires all three to match; anything else forces a full recompute + rewrite.
CREATE TABLE recompute_cache (
  company_id     INTEGER PRIMARY KEY,
  phasea_hash    TEXT NOT NULL,
  recency_hash   TEXT NOT NULL,
  tx_fingerprint TEXT NOT NULL,
  agg_json       TEXT NOT NULL,   -- JSON of the aggregateOverview() output array
  computed_at    TEXT NOT NULL DEFAULT (datetime('now'))
);
