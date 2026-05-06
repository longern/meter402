export const JSON_HEADERS = {
  "content-type": "application/json; charset=utf-8",
};

export const CORS_HEADERS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET,POST,DELETE,OPTIONS",
  "access-control-allow-headers": "authorization,content-type,x-payment",
  "access-control-expose-headers": "meteria402-invoice-id,meteria402-amount-due,meteria402-request-id",
};

export const BASE_MAINNET = "eip155:8453";
export const BASE_USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
export const DEFAULT_X402_FACILITATOR_URL = "https://api.cdp.coinbase.com/platform/v2/x402";
