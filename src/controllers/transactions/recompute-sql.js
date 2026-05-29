export const SNAPSHOT_TABLE = "bank_mid_snapshot_v1";

const FILTER = `
  t.merchant_id IN (3, 5, 7)
  AND t.card_type != 'TESTCARD'
  AND (
    (t.response_type = 'SUCCESS'
        AND t.response_text NOT IN (
          'Zero Amount Transaction Not Sent to Gateway'
        ))
    OR (t.response_type = 'SOFT_DECLINE'
        AND t.response_text NOT LIKE 'CVV must be%'
        AND t.response_text NOT LIKE '3DSecure is inactive%'
        AND t.response_text NOT LIKE 'Payee account is not setup%'
        AND t.response_text NOT LIKE 'The API caller%'
        AND t.response_text NOT IN (
          'Activity limit exceeded',
          'Amex is not a supported payment type',
          'Cascade Error: No unattempted Gateways remaining in Cascade',
          'CVV2 Mismatch',
          'Discover is not a supported payment type',
          'Error Code: K-20',
          'Exceeds withdrawal limit',
          'General error',
          'Insufficient funds',
          'Insufficient Funds',
          'Invalid Cvc',
          'Invalid CVV',
          'Mastercard is not a supported payment type',
          'Merchant enrollment not yet completed.',
          'Payment Intent Authentication Failure',
          'Pin tries exceeded',
          'Testmode Charges Only',
          'The merchant account is restricted.',
          'VISA is not a supported card type.',
          'Visa is not a supported payment type'
        ))
    OR (t.response_type = 'HARD_DECLINE'
        AND t.response_text NOT LIKE 'Invalid Credit Card Number%'
        AND t.response_text NOT LIKE 'CVV must be%'
        AND t.response_text NOT LIKE 'Duplicate transaction%'
        AND t.response_text NOT LIKE 'Specified API key not found%'
        AND t.response_text NOT LIKE 'The cc payment type%'
        AND t.response_text NOT LIKE 'Credit Cards can only be stored%'
        AND t.response_text NOT IN (
          'Account Closed',
          'Blocked, first used',
          'Customer requested stop of all recurring payments',
          'Expired card',
          'Invalid amount',
          'Invalid card number',
          'Invalid merchant ID',
          'Invalid transaction',
          'Re-enter transaction',
          'Transaction not permitted by issuer'
        ))
  )
`;

export const RECOMPUTE_INSERT_SQL = `
  INSERT INTO bank_mid (bank_id, mid_id, success_count, fail_count)
  SELECT
    bn.bank_id,
    m.id AS mid_id,
    SUM(CASE WHEN t.response_type = 'SUCCESS' THEN 1 ELSE 0 END) AS success_count,
    SUM(CASE WHEN t.response_type IN ('SOFT_DECLINE','HARD_DECLINE') THEN 1 ELSE 0 END) AS fail_count
  FROM transactions t
  JOIN bins bn ON bn.bin_number = t.card_bin
  JOIN mids m  ON m.merchant_id = t.merchant_id
  WHERE bn.bank_id IS NOT NULL
    AND (${FILTER})
  GROUP BY bn.bank_id, m.id
`;
