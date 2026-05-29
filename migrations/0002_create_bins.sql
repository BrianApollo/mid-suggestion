CREATE TABLE bins (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  bin_number TEXT NOT NULL,
  bank_id INTEGER NOT NULL,
  brand TEXT NOT NULL CHECK (brand IN ('VISA', 'MASTERCARD')),
  type TEXT CHECK (type IN ('DEBIT', 'CREDIT')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (bank_id) REFERENCES banks(id)
);

CREATE TRIGGER bins_set_updated_at
AFTER UPDATE ON bins
FOR EACH ROW
BEGIN
  UPDATE bins SET updated_at = datetime('now') WHERE id = OLD.id;
END;
