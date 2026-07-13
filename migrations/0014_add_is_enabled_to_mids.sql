-- 0014: track whether a MID is enabled in CheckoutChamp (the biller's `enabled` flag).
-- Populated by POST /api/mids/sync. Defaults to 1 so existing rows stay enabled.
ALTER TABLE mids ADD COLUMN is_enabled INTEGER NOT NULL DEFAULT 1;
