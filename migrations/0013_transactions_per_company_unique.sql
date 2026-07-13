-- 0013: make transaction uniqueness per-company. The original UNIQUE(cc_transaction_id) is
-- global, so two companies sharing a CheckoutChamp transaction id would collide (one loses the
-- row). Rebuild with UNIQUE(company_id, cc_transaction_id) so companies never interfere.
DROP TABLE IF EXISTS transactions_v2;
CREATE TABLE transactions_v2 (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  cc_transaction_id INTEGER NOT NULL,
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
  bill_cycle INTEGER,
  company_id INTEGER NOT NULL DEFAULT 1,
  UNIQUE (company_id, cc_transaction_id)
);
INSERT INTO transactions_v2 (id, cc_transaction_id, date_created, response_type, response_text, merchant_id, mid_number, card_bin, card_last4, card_type, order_id, merchant_txn_id, created_at, updated_at, bill_cycle, company_id)
  SELECT id, cc_transaction_id, date_created, response_type, response_text, merchant_id, mid_number, card_bin, card_last4, card_type, order_id, merchant_txn_id, created_at, updated_at, bill_cycle, company_id FROM transactions;
DROP TABLE transactions;
ALTER TABLE transactions_v2 RENAME TO transactions;
CREATE INDEX transactions_card_bin ON transactions (card_bin);
CREATE INDEX transactions_merchant_id ON transactions (merchant_id);
CREATE INDEX transactions_response_type ON transactions (response_type);
CREATE INDEX transactions_date_created ON transactions (date_created);
CREATE INDEX transactions_company ON transactions (company_id);
CREATE TRIGGER transactions_set_updated_at AFTER UPDATE ON transactions FOR EACH ROW BEGIN UPDATE transactions SET updated_at = datetime('now') WHERE id = OLD.id; END;
