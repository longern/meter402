#!/bin/bash
set -e

BASE="http://localhost:8787"
TEST_FAILED=0

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

cleanup() {
  echo ""
  echo "=== Cleaning up ==="
  pkill -f "mock_ai_gateway.py" 2>/dev/null || true
  pkill -f "mock_autopay_worker.py" 2>/dev/null || true
  pkill -f "wrangler dev" 2>/dev/null || true
  echo "Cleanup done"
}

trap cleanup EXIT

echo "=== Starting mock servers ==="
python3 scripts/mock_ai_gateway.py &
AI_GATEWAY_PID=$!
python3 scripts/mock_autopay_worker.py &
AUTOPAY_WORKER_PID=$!

echo "=== Starting Meteria402 (wrangler dev) ==="
npx wrangler dev --port 8787 &
WRANGLER_PID=$!

echo "=== Waiting for services to start (10s) ==="
sleep 10

echo ""
echo "=========================================="
echo "=== SCENARIO 1: Prepaid Excess Deposit ==="
echo "=========================================="
echo ""

echo "1. Create deposit quote ($10)"
QUOTE=$(curl -s -X POST "$BASE/api/deposits/quote" \
  -H "content-type: application/json" \
  -d '{"amount": "10.00"}')
echo "$QUOTE" | jq . 2>/dev/null || echo "$QUOTE"
PAYMENT_ID=$(echo "$QUOTE" | jq -r '.payment_id // empty')
QUOTE_TOKEN=$(echo "$QUOTE" | jq -r '.quote_token // empty')

if [ -z "$PAYMENT_ID" ] || [ "$PAYMENT_ID" = "null" ]; then
  echo -e "${RED}ERROR: No payment_id returned${NC}"
  TEST_FAILED=1
  exit 1
fi

echo ""
echo "2. Settle deposit with dev proof"
SETTLE_BODY=$(curl -s -X POST "$BASE/api/deposits/settle" \
  -H "content-type: application/json" \
  -d "{\"payment_id\":\"$PAYMENT_ID\",\"quote_token\":\"$QUOTE_TOKEN\",\"dev_proof\":\"dev-paid\",\"autopay_url\":\"http://localhost:8789\"}")
echo "$SETTLE_BODY" | jq . 2>/dev/null || echo "$SETTLE_BODY"

API_KEY=$(echo "$SETTLE_BODY" | jq -r '.api_key // empty')
ACCOUNT_ID=$(echo "$SETTLE_BODY" | jq -r '.account_id // empty')

echo ""
echo "api_key: $API_KEY"
echo "account_id: $ACCOUNT_ID"

if [ -z "$API_KEY" ] || [ "$API_KEY" = "null" ]; then
  echo -e "${RED}ERROR: No API key returned${NC}"
  TEST_FAILED=1
  exit 1
fi

# For session-based APIs, we'll create a new session via login
# But first let's use the API key for testing
SESSION_COOKIE=""

echo ""
echo "3. Check account via session (should show deposit_balance=$10.00)"
ACCOUNT=$(curl -s "$BASE/api/account" \
  -H "cookie: $SESSION_COOKIE")
echo "$ACCOUNT" | jq . 2>/dev/null || echo "$ACCOUNT"

DEPOSIT_BALANCE=$(echo "$ACCOUNT" | jq -r '.deposit_balance // 0')
MIN_DEPOSIT=$(echo "$ACCOUNT" | jq -r '.min_deposit_required // 5')
echo ""
echo "deposit_balance: $DEPOSIT_BALANCE"
echo "min_deposit_required: $MIN_DEPOSIT"

echo ""
echo "4. API request #1 (should auto-pay with excess deposit)"
API_RESP=$(curl -s -D - -X POST "$BASE/v1/chat/completions" \
  -H "authorization: Bearer $API_KEY" \
  -H "content-type: application/json" \
  -d '{"model":"test","messages":[{"role":"user","content":"hi"}]}')

echo "=== Response Headers ==="
echo "$API_RESP" | head -20

echo ""
echo "=== Response Body ==="
echo "$API_RESP" | tail -1 | jq . 2>/dev/null || echo "$API_RESP" | tail -1

# Check auto-paid header
if echo "$API_RESP" | grep -qi "meteria402-auto-paid: true"; then
  echo -e "${GREEN}✅ PASS: Auto-paid header present${NC}"
else
  echo -e "${RED}❌ FAIL: Auto-paid header NOT present${NC}"
  TEST_FAILED=1
fi

if echo "$API_RESP" | grep -qi "meteria402-auto-pay-method: excess_deposit"; then
  echo -e "${GREEN}✅ PASS: Auto-pay method is excess_deposit${NC}"
else
  echo -e "${YELLOW}⚠️ WARNING: Auto-pay method not excess_deposit${NC}"
fi

echo ""
echo "5. Check invoice status (should be paid)"
INVOICES=$(curl -s "$BASE/api/invoices" \
  -H "cookie: $SESSION_COOKIE")
echo "$INVOICES" | jq '.invoices[0]' 2>/dev/null || echo "$INVOICES"

FIRST_INVOICE_STATUS=$(echo "$INVOICES" | jq -r '.invoices[0].status // empty')
if [ "$FIRST_INVOICE_STATUS" = "paid" ]; then
  echo -e "${GREEN}✅ PASS: Invoice is paid${NC}"
else
  echo -e "${RED}❌ FAIL: Invoice status is '$FIRST_INVOICE_STATUS', expected 'paid'${NC}"
  TEST_FAILED=1
fi

echo ""
echo "=========================================="
echo "=== SCENARIO 2: Capability Autopay    ==="
echo "=========================================="
echo ""

echo "6. Create autopay capability ($5 budget, 7 days)"
CAP_RESP=$(curl -s -X POST "$BASE/api/autopay/capabilities" \
  -H "cookie: $SESSION_COOKIE" \
  -H "content-type: application/json" \
  -d '{"total_budget":"5.00","ttl_days":7}')
echo "$CAP_RESP" | jq . 2>/dev/null || echo "$CAP_RESP"

CAP_ID=$(echo "$CAP_RESP" | jq -r '.capability_id // empty')
if [ -z "$CAP_ID" ] || [ "$CAP_ID" = "null" ]; then
  echo -e "${RED}ERROR: Failed to create capability${NC}"
  TEST_FAILED=1
  # Continue to try next scenario
else
  echo ""
  echo "capability_id: $CAP_ID"
  
  echo ""
  echo "7. Complete capability (poll mock worker)"
  COMPLETE_RESP=$(curl -s -X POST "$BASE/api/autopay/capabilities/$CAP_ID/complete" \
    -H "cookie: $SESSION_COOKIE")
  echo "$COMPLETE_RESP" | jq . 2>/dev/null || echo "$COMPLETE_RESP"
  
  COMPLETE_STATUS=$(echo "$COMPLETE_RESP" | jq -r '.status // empty')
  if [ "$COMPLETE_STATUS" = "completed" ]; then
    echo -e "${GREEN}✅ PASS: Capability completed${NC}"
  else
    echo -e "${YELLOW}⚠️ WARNING: Capability completion status: $COMPLETE_STATUS${NC}"
  fi
  
  echo ""
  echo "8. Check capability list"
  CAP_LIST=$(curl -s "$BASE/api/autopay/capabilities" \
    -H "cookie: $SESSION_COOKIE")
  echo "$CAP_LIST" | jq . 2>/dev/null || echo "$CAP_LIST"
fi

echo ""
echo "=========================================="
echo "=== SCENARIO 3: Unpaid Invoice Block  ==="
echo "=========================================="
echo ""

echo "9. Create NEW account with minimal deposit ($5, no excess)"
QUOTE2=$(curl -s -X POST "$BASE/api/deposits/quote" \
  -H "content-type: application/json" \
  -d '{"amount": "5.00"}')
PAYMENT_ID2=$(echo "$QUOTE2" | jq -r '.payment_id // empty')
QUOTE_TOKEN2=$(echo "$QUOTE2" | jq -r '.quote_token // empty')

SETTLE_RESP2=$(curl -s -D - -X POST "$BASE/api/deposits/settle" \
  -H "content-type: application/json" \
  -d "{\"payment_id\":\"$PAYMENT_ID2\",\"quote_token\":\"$QUOTE_TOKEN2\",\"dev_proof\":\"dev-paid\",\"autopay_url\":\"http://localhost:8789\"}")
SETTLE_BODY2=$(echo "$SETTLE_RESP2" | tail -1)
API_KEY2=$(echo "$SETTLE_BODY2" | jq -r '.api_key // empty')
SESSION_COOKIE2=$(echo "$SETTLE_RESP2" | head -n -1 | grep -i "set-cookie:" | grep -oE "meteria402_session=[^;]+" | head -1)

echo "api_key2: $API_KEY2"

# Ensure this account has NO capability (delete any existing)
echo ""
echo "10. Verify no capabilities for new account"
CAP_LIST2=$(curl -s "$BASE/api/autopay/capabilities" \
  -H "cookie: $SESSION_COOKIE2")
echo "capabilities: $(echo "$CAP_LIST2" | jq '.capabilities | length')"

echo ""
echo "11. API request #1 (should NOT auto-pay, invoice unpaid)"
API_RESP2=$(curl -s -D - -X POST "$BASE/v1/chat/completions" \
  -H "authorization: Bearer $API_KEY2" \
  -H "content-type: application/json" \
  -d '{"model":"test","messages":[{"role":"user","content":"hi"}]}')

echo "=== Response Headers ==="
echo "$API_RESP2" | head -15

# Check NO auto-paid header
if echo "$API_RESP2" | grep -qi "meteria402-auto-paid: true"; then
  echo -e "${RED}❌ FAIL: Should NOT auto-pay${NC}"
  TEST_FAILED=1
else
  echo -e "${GREEN}✅ PASS: No auto-pay header (as expected)${NC}"
fi

# Check amount-due header present
if echo "$API_RESP2" | grep -qi "meteria402-amount-due:"; then
  echo -e "${GREEN}✅ PASS: Amount-due header present${NC}"
else
  echo -e "${RED}❌ FAIL: Amount-due header NOT present${NC}"
  TEST_FAILED=1
fi

echo ""
echo "12. Check invoice status (should be unpaid)"
INVOICES2=$(curl -s "$BASE/api/invoices" \
  -H "cookie: $SESSION_COOKIE2")
FIRST_INVOICE_STATUS2=$(echo "$INVOICES2" | jq -r '.invoices[0].status // empty')
if [ "$FIRST_INVOICE_STATUS2" = "unpaid" ]; then
  echo -e "${GREEN}✅ PASS: Invoice is unpaid${NC}"
else
  echo -e "${RED}❌ FAIL: Invoice status is '$FIRST_INVOICE_STATUS2', expected 'unpaid'${NC}"
  TEST_FAILED=1
fi

echo ""
echo "13. API request #2 (should be blocked with 402)"
API_RESP3=$(curl -s -o /dev/null -w "%{http_code}" -X POST "$BASE/v1/chat/completions" \
  -H "authorization: Bearer $API_KEY2" \
  -H "content-type: application/json" \
  -d '{"model":"test","messages":[{"role":"user","content":"hi again"}]}')

echo "HTTP status: $API_RESP3"
if [ "$API_RESP3" = "402" ]; then
  echo -e "${GREEN}✅ PASS: Second request blocked with 402${NC}"
else
  echo -e "${RED}❌ FAIL: Expected 402, got $API_RESP3${NC}"
  TEST_FAILED=1
fi

echo ""
echo "=========================================="
echo "=== Test Summary                      ==="
echo "=========================================="

if [ $TEST_FAILED -eq 0 ]; then
  echo -e "${GREEN}✅ ALL TESTS PASSED${NC}"
  exit 0
else
  echo -e "${RED}❌ SOME TESTS FAILED${NC}"
  exit 1
fi
