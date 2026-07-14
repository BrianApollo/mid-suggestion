-- 0015: store the CheckoutChamp transaction operation type (SALE / AUTHORIZE / CAPTURE / …)
-- on each transaction. Previously only the *result* was kept (response_type), so SALE/AUTH/
-- CAPTURE rows were indistinguishable once ingested. Populated by the ingest + Excel import
-- from the row's txnType field. Nullable — existing rows predate the column.
ALTER TABLE transactions ADD COLUMN txn_type TEXT;
CREATE INDEX transactions_txn_type ON transactions (txn_type);
