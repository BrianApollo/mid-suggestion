INSERT INTO bins (bin_number, bank_id) VALUES
  ('000000', (SELECT id FROM banks WHERE name = 'REPLACE WITH BANK NAME' LIMIT 1));
