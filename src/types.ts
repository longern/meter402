export type Env = {
  DB: D1Database;
  CLOUDFLARE_ACCOUNT_ID?: string;
  CLOUDFLARE_API_TOKEN?: string;
  AI_GATEWAY_ID?: string;
  AI_GATEWAY_API_KEY?: string;
  AI_GATEWAY_AUTH_TOKEN?: string;
  PRICE_TABLE_JSON?: string;
  X402_FACILITATOR_URL?: string;
  X402_FACILITATOR_AUTH_TOKEN?: string;
  X402_RECIPIENT_ADDRESS?: string;
  X402_NETWORK?: string;
  X402_ASSET?: string;
  X402_RPC_URL?: string;
  UPSTREAM_BASE_URL?: string;
  DEFAULT_MIN_DEPOSIT?: string;
  DEFAULT_CONCURRENCY_LIMIT?: string;
  DEFAULT_INPUT_MICRO_USD_PER_TOKEN?: string;
  DEFAULT_OUTPUT_MICRO_USD_PER_TOKEN?: string;
  ALLOW_DEV_PAYMENTS?: string;
  X402_ASSET_DECIMALS?: string;
  APP_SIGNING_SECRET?: string;
};

export type Account = {
  id: string;
  status: string;
  owner_address: string | null;
  autopay_url: string | null;
  deposit_balance: number;
  unpaid_invoice_total: number;
  active_request_count: number;
  concurrency_limit: number;
  min_deposit_required: number;
  autopay_min_recharge_amount: number;
  refund_address: string | null;
};

export type AuthenticatedAccount = Account & {
  api_key_id: string;
};

export type ChatBody = {
  model?: string;
  stream?: boolean;
  stream_options?: {
    include_usage?: boolean;
    [key: string]: unknown;
  };
  [key: string]: unknown;
};

export type Usage = {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
};

export type PaymentRequirement = {
  x402Version: number;
  resource: { url: string };
  accepts: Array<{
    scheme: string;
    network: string;
    asset: string;
    amount: string;
    payTo: string;
    maxTimeoutSeconds?: number;
    extra?: Record<string, unknown>;
  }>;
  error?: string;
};

export type AutopayRequestRow = {
  id: string;
  payment_id: string;
  account_id: string | null;
  invoice_id: string | null;
  autopay_url: string;
  autopay_request_id: string;
  poll_token: string;
  status: string;
  verification_uri_complete: string;
};

export type LoginState = {
  autopay_url: string;
  autopay_request_id: string;
  poll_token: string;
  verification_uri_complete: string;
  expires_at: number;
};

export type SessionState = {
  owner: string;
  autopay_url: string;
  expires_at: number;
};

export type DepositQuoteState = {
  payment_id: string;
  kind: "deposit";
  amount: number;
  currency: "USD";
  payment_requirement: PaymentRequirement;
  expires_at: number;
};

export type DepositAutopayState = {
  payment_id: string;
  quote_token: string;
  autopay_url: string;
  autopay_request_id: string;
  poll_token: string;
  verification_uri_complete: string;
  expires_at: number;
};

export type AutopayWalletBalanceEligibility = {
  account: Account;
  owner: string;
};

export type AutopayCapabilityRow = {
  id: string;
  account_id: string;
  owner_address: string;
  autopay_url: string;
  siwe_message: string;
  siwe_signature: string;
  capability_json: string;
  max_single_amount: number;
  total_budget: number;
  spent_amount: number;
  valid_before: string;
  created_at: string;
  revoked_at: string | null;
};
