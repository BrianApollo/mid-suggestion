DELETE FROM bank_mid;
DELETE FROM bins;
DELETE FROM mids;
DELETE FROM banks;
DELETE FROM sqlite_sequence WHERE name IN ('banks', 'bins', 'mids');
