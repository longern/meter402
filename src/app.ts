import {
handleCreateApiKey,
handleCompleteOwnerRebind,
handleCreateOwnerRebindChallenge,
handleGetAccount,
handleListApiKeys,
handleListDeposits,
handleListInvoices,
handleListRequests,
handleReconcileRequests,
handleRevokeApiKey,
handleUpdateAccount,
} from "./account-handlers";
import {
handleCompleteAutopayCapability,
handleCreateAutopayCapability,
handleInvoiceAutopayComplete,
handleInvoiceAutopayStart,
handleInvoicePayQuote,
handleInvoicePaySettle,
handleListAutopayCapabilities,
handleRefundRequest,
handleRevokeAutopayCapability,
} from "./billing-autopay-handlers";
import {
handleDepositAutopayComplete,
handleDepositAutopayStart,
handleDepositIntent,
handleDepositQuote,
handleDepositSettle,
} from "./deposit-handlers";
import {
handleLoginChallenge,
handleLoginComplete,
handleLoginScanRequest,
handleLoginScanStart,
} from "./login";
import type { RouteHandlers } from "./routes";
import {
handleAutopayWalletBalance,
handleGetConfig,
handleGetSession,
handleLogout,
handleUpdateSessionAutopay
} from "./session-handlers";
import type { Env } from "./types";
import { handleV1Request,reconcilePendingGatewayLogs } from "./v1-handlers";

export const routeHandlers: RouteHandlers = {
  handleGetConfig,
  handleAutopayWalletBalance,
  handleGetSession,
  handleLoginChallenge,
  handleLoginComplete,
  handleLoginScanStart,
  handleLoginScanRequest,
  handleLogout,
  handleUpdateSessionAutopay,
  handleListDeposits,
  handleDepositQuote,
  handleDepositIntent,
  handleDepositSettle,
  handleDepositAutopayStart,
  handleDepositAutopayComplete,
  handleGetAccount,
  handleUpdateAccount,
  handleCreateOwnerRebindChallenge,
  handleCompleteOwnerRebind,
  handleListApiKeys,
  handleCreateApiKey,
  handleRevokeApiKey,
  handleListInvoices,
  handleListRequests,
  handleReconcileRequests,
  handleInvoicePayQuote,
  handleInvoicePaySettle,
  handleInvoiceAutopayStart,
  handleInvoiceAutopayComplete,
  handleRefundRequest,
  handleListAutopayCapabilities,
  handleCreateAutopayCapability,
  handleRevokeAutopayCapability,
  handleCompleteAutopayCapability,
  handleV1Request,
};

export function scheduledReconcile(env: Env, ctx: ExecutionContext): void {
  ctx.waitUntil(reconcilePendingGatewayLogs(env));
}
