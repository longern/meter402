#!/bin/bash
set -e

BASE="http://localhost:8787"

echo "=== 1. Session check (should be unauthenticated) ==="
curl -s "$BASE/api/session"
echo -e "\n"

echo "=== 2. Create deposit quote ==="
QUOTE=$(curl -s -X POST "$BASE/api/deposits/quote" \
  -H "content-type: application/json" \
  -d '{"amount": "5.00"}')
echo "$QUOTE" | jq .
PAYMENT_ID=$(echo "$QUOTE" | jq -r '.payment_id')
QUOTE_TOKEN=$(echo "$QUOTE" | jq -r '.quote_token')
echo "payment_id: $PAYMENT_ID"
echo "quote_token: $QUOTE_TOKEN"

echo -e "\n=== 3. Settle deposit with dev proof ==="
SETTLE=$(curl -s -X POST "$BASE/api/deposits/settle" \
  -H "content-type: application/json" \
  -d "{\"payment_id\":\"$PAYMENT_ID\",\"quote_token\":\"$QUOTE_TOKEN\",\"dev_proof\":\"dev-paid\",\"autopay_url\":\"https://autopay.example.com\"}")
echo "$SETTLE" | jq .
API_KEY=$(echo "$SETTLE" | jq -r '.api_key // empty')
echo "api_key: $API_KEY"

echo -e "\n=== 4. Try /api/account without session (should fail) ==="
curl -s "$BASE/api/account" | jq .

echo -e "\n=== 5. Try /api/account with API key (should fail - now cookie-only) ==="
curl -s "$BASE/api/account" \
  -H "authorization: Bearer $API_KEY" | jq .

echo -e "\n=== 6. Try /v1/chat/completions without API key (should fail) ==="
curl -s -X POST "$BASE/v1/chat/completions" \
  -H "content-type: application/json" \
  -d '{"model": "test", "messages": [{"role": "user", "content": "hi"}]}' | jq .

echo -e "\n=== 7. Try /v1/chat/completions with API key ==="
curl -s -X POST "$BASE/v1/chat/completions" \
  -H "authorization: Bearer $API_KEY" \
  -H "content-type: application/json" \
  -d '{"model": "test", "messages": [{"role": "user", "content": "hi"}]}' | jq .

echo -e "\n=== 8. List API keys (cookie-only, should fail without session) ==="
curl -s "$BASE/api/api-keys" | jq .
