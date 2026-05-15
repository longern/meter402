import { useState } from "react";
import { readableError } from "../utils";

export default function useConsoleData({
  request,
  show,
  identityOwner,
  defaultAutopayUrl,
  setAutopayUrl,
  setLoadingFlag,
}) {
  const [account, setAccount] = useState(null);
  const [accountMissing, setAccountMissing] = useState(false);
  const [apiKeys, setApiKeys] = useState([]);
  const [lastInvoices, setLastInvoices] = useState([]);
  const [deposits, setDeposits] = useState([]);
  const [depositsLoading, setDepositsLoading] = useState(false);
  const [requests, setRequests] = useState([]);
  const [requestsCursor, setRequestsCursor] = useState(null);
  const [requestsPrevCursors, setRequestsPrevCursors] = useState([]);
  const [requestsNextCursor, setRequestsNextCursor] = useState(null);
  const [autopayWalletBalance, setAutopayWalletBalance] = useState(null);
  const [autopayWalletBalanceError, setAutopayWalletBalanceError] = useState("");
  const [capabilities, setCapabilities] = useState([]);
  const [capabilitiesLoading, setCapabilitiesLoading] = useState(false);

  function clearAccountScopedData() {
    setAccount(null);
    setAccountMissing(true);
    setDeposits([]);
    setApiKeys([]);
    setRequests([]);
    setRequestsCursor(null);
    setRequestsPrevCursors([]);
    setRequestsNextCursor(null);
    setLastInvoices([]);
    setCapabilities([]);
    setAutopayWalletBalance(null);
    setAutopayWalletBalanceError("");
  }

  async function loadAccount() {
    setLoadingFlag("account", true);
    try {
      const json = await request("/api/account");
      setAccount(json);
      setAutopayUrl(json.autopay_url || defaultAutopayUrl);
      setAccountMissing(false);
      show(json);
      return json;
    } catch (error) {
      if (isAccountNotFound(error)) {
        clearAccountScopedData();
        show({ status: "account_activation_required", owner: identityOwner });
        return null;
      }
      show(readableError(error));
      return null;
    } finally {
      setLoadingFlag("account", false);
    }
  }

  async function loadAutopayWalletBalance(accountSnapshot = account) {
    if (!identityOwner || !accountSnapshot?.autopay_url) return;
    setLoadingFlag("walletBalance", true);
    setAutopayWalletBalanceError("");
    try {
      const json = await request("/api/autopay-wallet/balance");
      setAutopayWalletBalance(json);
    } catch (error) {
      setAutopayWalletBalance(null);
      setAutopayWalletBalanceError(readableError(error));
    } finally {
      setLoadingFlag("walletBalance", false);
    }
  }

  async function loadApiKeys() {
    setLoadingFlag("apiKeys", true);
    try {
      const json = await request("/api/api-keys");
      setApiKeys(json.api_keys || []);
      show(json);
    } catch (error) {
      show(readableError(error));
    } finally {
      setLoadingFlag("apiKeys", false);
    }
  }

  async function loadInvoices() {
    setLoadingFlag("invoices", true);
    try {
      const json = await request("/api/invoices");
      setLastInvoices(json.invoices || []);
      show(json);
    } catch (error) {
      show(readableError(error));
    } finally {
      setLoadingFlag("invoices", false);
    }
  }

  async function loadDeposits() {
    setDepositsLoading(true);
    try {
      const json = await request("/api/deposits");
      setDeposits(json.deposits || []);
      show(json);
    } catch (error) {
      show(readableError(error));
    } finally {
      setDepositsLoading(false);
    }
  }

  async function loadRequests(cursor = null, prevCursors = []) {
    setLoadingFlag("requests", true);
    try {
      const url = cursor
        ? `/api/requests?cursor=${encodeURIComponent(cursor)}`
        : "/api/requests";
      const json = await request(url);
      setRequests(json.requests || []);
      setRequestsCursor(cursor);
      setRequestsPrevCursors(prevCursors);
      setRequestsNextCursor(json.next_cursor || null);
      show(json);
    } catch (error) {
      show(readableError(error));
    } finally {
      setLoadingFlag("requests", false);
    }
  }

  async function loadCapabilities() {
    setCapabilitiesLoading(true);
    try {
      const json = await request("/api/autopay/capabilities");
      setCapabilities(json.capabilities || []);
    } catch (error) {
      show(readableError(error));
    } finally {
      setCapabilitiesLoading(false);
    }
  }

  function loadPreviousRequestsPage() {
    if (!requestsPrevCursors.length) return;
    const nextPrevCursors = requestsPrevCursors.slice(0, -1);
    const previousCursor = requestsPrevCursors[requestsPrevCursors.length - 1];
    loadRequests(previousCursor, nextPrevCursors);
  }

  function loadNextRequestsPage() {
    if (!requestsNextCursor) return;
    loadRequests(requestsNextCursor, [...requestsPrevCursors, requestsCursor]);
  }

  return {
    account,
    setAccount,
    accountMissing,
    apiKeys,
    setApiKeys,
    lastInvoices,
    setLastInvoices,
    deposits,
    depositsLoading,
    requests,
    requestsCursor,
    requestsPrevCursors,
    requestsNextCursor,
    autopayWalletBalance,
    setAutopayWalletBalance,
    autopayWalletBalanceError,
    setAutopayWalletBalanceError,
    capabilities,
    loadAccount,
    loadAutopayWalletBalance,
    loadApiKeys,
    loadInvoices,
    loadDeposits,
    loadRequests,
    loadPreviousRequestsPage,
    loadNextRequestsPage,
    loadCapabilities,
    capabilitiesLoading,
  };
}

function isAccountNotFound(error) {
  return error && typeof error === "object" && error.code === "account_not_found";
}
