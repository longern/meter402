UPDATE meteria402_payments
SET currency = COALESCE(
  NULLIF(UPPER(json_extract(payment_requirement_json, '$.accepts[0].extra.currency')), ''),
  currency
)
WHERE currency = 'USD'
  AND payment_requirement_json IS NOT NULL
  AND json_extract(payment_requirement_json, '$.accepts[0].extra.currency') IS NOT NULL;

UPDATE meteria402_invoices
SET currency = COALESCE(
  NULLIF(UPPER(json_extract(payment_requirement_json, '$.accepts[0].extra.currency')), ''),
  currency
)
WHERE currency = 'USD'
  AND payment_requirement_json IS NOT NULL
  AND json_extract(payment_requirement_json, '$.accepts[0].extra.currency') IS NOT NULL;

UPDATE meteria402_ledger_entries
SET currency = COALESCE(
  (
    SELECT p.currency
    FROM meteria402_payments p
    WHERE p.id = meteria402_ledger_entries.related_payment_id
      AND p.currency <> 'USD'
    LIMIT 1
  ),
  currency
)
WHERE currency = 'USD'
  AND related_payment_id IS NOT NULL;

UPDATE meteria402_ledger_entries
SET currency = COALESCE(
  (
    SELECT i.currency
    FROM meteria402_invoices i
    WHERE i.id = meteria402_ledger_entries.related_invoice_id
      AND i.currency <> 'USD'
    LIMIT 1
  ),
  currency
)
WHERE currency = 'USD'
  AND related_invoice_id IS NOT NULL;
