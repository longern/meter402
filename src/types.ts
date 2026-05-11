export type Env = {
  DB: D1Database;
  AI?: {
    aiGatewayLogId?: string;
    run(
      model: string,
      input: Record<string, unknown>,
      options?: Record<string, unknown>,
    ): Promise<unknown>;
  };
  CLOUDFLARE_ACCOUNT_ID?: string;
  CLOUDFLARE_API_TOKEN?: string;
  AI_GATEWAY_ID?: string;
  AI_GATEWAY_API_KEY?: string;
  AI_GATEWAY_AUTH_TOKEN?: string;
  X402_FACILITATOR_URL?: string;
  X402_FACILITATOR_AUTH_TOKEN?: string;
  X402_RECIPIENT_ADDRESS?: string;
  X402_RECIPIENT_PRIVATE_KEY?: string;
  X402_NETWORK?: string;
  X402_ASSET?: string;
  X402_ASSET_SYMBOL?: string;
  X402_RPC_URL?: string;
  UPSTREAM_BASE_URL?: string;
  DEFAULT_MIN_DEPOSIT?: string;
  DEFAULT_CONCURRENCY_LIMIT?: string;
  BILLING_COST_MULTIPLIER?: string;
  ALLOW_DEV_PAYMENTS?: string;
  DEV_PAYMENT_PROOF?: string;
  METERED_REQUEST_LEASE_SECONDS?: string;
  X402_ASSET_DECIMALS?: string;
  AUTOPAY_REQUESTER_ORIGIN?: string;
  AUTOPAY_REQUESTER_NAME?: string;
  ACCOUNT_GATES: DurableObjectNamespace;
  LOGIN_SESSIONS: DurableObjectNamespace;
};

export type Account = {
  id: string;
  status: string;
  owner_address: string | null;
  autopay_url: string | null;
  deposit_balance: number;
  unpaid_invoice_total: number;
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

export type LoginChallengeState = {
  address: string;
  request_id?: string;
  nonce: string;
  domain: string;
  uri: string;
  chain_id: number;
  issued_at: string;
  expires_at: number;
};

export type OwnerRebindChallengeState = {
  account_id: string;
  old_owner: string;
  new_owner: string;
  nonce: string;
  domain: string;
  uri: string;
  chain_id: number;
  issued_at: string;
  expires_at: number;
};

export type SessionState = {
  owner: string;
  expires_at: number;
};

export type DepositQuoteState = {
  payment_id: string;
  kind: "deposit";
  amount: number;
  currency: string;
  owner_address: string;
  autopay_url: string;
  payment_requirement: PaymentRequirement;
  authorization: {
    nonce: string;
    valid_after: string;
    valid_before: string;
  };
  expires_at: number;
};

export type DepositIntentState = {
  payment_id: string;
  amount: number;
  owner_address: string;
  autopay_url: string;
  token_amount: string;
  currency: string;
  network: string;
  asset: string;
  pay_to: string;
  nonce: string;
  valid_after: string;
  valid_before: string;
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
