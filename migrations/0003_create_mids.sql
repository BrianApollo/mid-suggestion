CREATE TABLE mids (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  merchant_id INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TRIGGER mids_set_updated_at
AFTER UPDATE ON mids
FOR EACH ROW
BEGIN
  UPDATE mids SET updated_at = datetime('now') WHERE id = OLD.id;
END;
