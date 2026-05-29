CREATE TABLE banks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TRIGGER banks_set_updated_at
AFTER UPDATE ON banks
FOR EACH ROW
BEGIN
  UPDATE banks SET updated_at = datetime('now') WHERE id = OLD.id;
END;
