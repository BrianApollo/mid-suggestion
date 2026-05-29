CREATE TABLE transactions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  cc_transaction_id INTEGER NOT NULL UNIQUE,
  date_created TEXT NOT NULL,
  response_type TEXT NOT NULL,
  response_text TEXT,
  merchant_id INTEGER,
  mid_number TEXT,
  card_bin TEXT,
  card_last4 TEXT,
  card_type TEXT,
  order_id TEXT,
  merchant_txn_id TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  bill_cycle INTEGER
);

CREATE INDEX transactions_card_bin ON transactions (card_bin);
CREATE INDEX transactions_merchant_id ON transactions (merchant_id);
CREATE INDEX transactions_response_type ON transactions (response_type);
CREATE INDEX transactions_date_created ON transactions (date_created);

CREATE TRIGGER transactions_set_updated_at
AFTER UPDATE ON transactions
FOR EACH ROW
BEGIN
  UPDATE transactions SET updated_at = datetime('now') WHERE id = OLD.id;
END;
