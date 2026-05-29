CREATE TABLE bank_mid (
  bank_id INTEGER NOT NULL,
  mid_id INTEGER NOT NULL,
  fail_count INTEGER NOT NULL DEFAULT 0,
  success_count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (bank_id, mid_id),
  FOREIGN KEY (bank_id) REFERENCES banks(id),
  FOREIGN KEY (mid_id) REFERENCES mids(id)
);
