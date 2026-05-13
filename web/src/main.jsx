import React, { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import QRCode from "qrcode";
import HomePage from "./HomePage";
import PayDepositPage from "./PayDepositPage";
import { LoginPage, WalletLoginPage } from "./LoginPage";
import { I18nProvider, useI18n } from "./i18n";
import DepositDialog from "./DepositDialog";
import KeysView from "./views/KeysView";
import RechargeView from "./views/RechargeView";
import UsageView from "./views/UsageView";
import AutopayView from "./views/AutopayView";
import SettingsView from "./views/SettingsView";
import { normalizeApiError } from "./apiError";
import {
  readableError,
  shortAddress,
  formatMoneyCompact,
  apiKeyDurationToIso,
  getConsoleView,
  consoleViewSubtitle,
} from "./utils";
import "./styles.css";

const DEFAULT_AUTOPAY_URL = import.meta.env.VITE_DEFAULT_AUTOPAY_URL || "";

function App() {
  const path = window.location.pathname;
  const [session, setSession] = useState(null);
  const [sessionLoaded, setSessionLoaded] = useState(false);

  useEffect(() => {
    fetchSession().then(setSession, () => setSession(null)).finally(() => setSessionLoaded(true));
  }, []);

  if (path === "/" || path === "") return <HomePage />;
  if (path === "/pay-deposit") return <PayDepositPage />;
  if (path === "/login") return <LoginPage onSessionChange={setSession} />;
  if (path === "/login/wallet") return <WalletLoginPage onSessionChange={setSession} />;
  if (path.startsWith("/console") && !sessionLoaded) {
    return null;
  }
  if (path.startsWith("/console") && !session) {
    return <LoginPage returnTo={window.location.pathname} onSessionChange={setSession} />;
  }
  return <ConsoleApp initialIdentity={session} onSessionChange={setSession} />;
}

function ConsoleApp({ initialIdentity, onSessionChange = () => {} }) {
  const [identity, setIdentity] = useState(initialIdentity);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [activeView, setActiveView] = useState(() => getConsoleView(window.location.pathname));
  const [autopayUrl, setAutopayUrl] = useState(DEFAULT_AUTOPAY_URL);
  const [newApiKey, setNewApiKey] = useState("");
  const [newKeyName, setNewKeyName] = useState("");
  const [newKeyDuration, setNewKeyDuration] = useState("1y");
  const [newKeySpendLimit, setNewKeySpendLimit] = useState("");
  const [createKeyOpen, setCreateKeyOpen] = useState(false);
  const [keyDialogError, setKeyDialogError] = useState("");
  const [paymentDialog, setPaymentDialog] = useState(null);
  const [paymentPayload, setPaymentPayload] = useState("");
  const [autopayWalletBalance, setAutopayWalletBalance] = useState(null);
  const [autopayWalletBalanceError, setAutopayWalletBalanceError] = useState("");
  const [capabilities, setCapabilities] = useState([]);
  const [capabilitiesLoading, setCapabilitiesLoading] = useState(false);
  const [capCreateOpen, setCapCreateOpen] = useState(false);
  const [capTotalBudget, setCapTotalBudget] = useState("5.00");
  const [capMaxSingleAmount, setCapMaxSingleAmount] = useState("5.00");
  const [capTtlDays, setCapTtlDays] = useState(7);
  const [capDialog, setCapDialog] = useState(null);
  const [capApprovalCopied, setCapApprovalCopied] = useState(false);
  const capAbortRef = useRef(null);
  const [editEndpointOpen, setEditEndpointOpen] = useState(false);
  const [depositDialogOpen, setDepositDialogOpen] = useState(false);
  const [account, setAccount] = useState(null);
  const { t } = useI18n();
  const [accountMissing, setAccountMissing] = useState(false);
  const [apiKeys, setApiKeys] = useState([]);
  const [lastInvoices, setLastInvoices] = useState([]);
  const [deposits, setDeposits] = useState([]);
  const [depositsLoading, setDepositsLoading] = useState(false);
  const [requests, setRequests] = useState([]);
  const [requestsCursor, setRequestsCursor] = useState(null);
  const [requestsPrevCursors, setRequestsPrevCursors] = useState([]);
  const [requestsNextCursor, setRequestsNextCursor] = useState(null);
  const [output, setOutput] = useState("");
  const [busy, setBusy] = useState("");

  useEffect(() => {
    function handlePopState() {
      setActiveView(getConsoleView(window.location.pathname));
      setSidebarOpen(false);
    }
    window.addEventListener("popstate", handlePopState);
    return () => window.removeEventListener("popstate", handlePopState);
  }, []);

  useEffect(() => {
    document.body.classList.toggle("sidebar-locked", sidebarOpen || createKeyOpen || Boolean(paymentDialog) || editEndpointOpen || depositDialogOpen);
    return () => document.body.classList.remove("sidebar-locked");
  }, [sidebarOpen, createKeyOpen, paymentDialog, editEndpointOpen, depositDialogOpen]);

  useEffect(() => {
    setIdentity(initialIdentity);
  }, [initialIdentity?.owner]);

  useEffect(() => {
    if (identity?.owner) {
      loadAccount();
    }
  }, [identity?.owner]);

  useEffect(() => {
    if (activeView !== "recharge" || !identity?.owner || !account) return;
    loadDeposits();
    if (account.autopay_url) {
      loadAutopayWalletBalance();
    } else {
      setAutopayWalletBalance(null);
      setAutopayWalletBalanceError("");
    }
  }, [activeView, identity?.owner, account?.account_id, account?.autopay_url]);

  useEffect(() => {
    if (activeView === "autopay" && identity?.owner && account) {
      loadCapabilities();
    }
  }, [activeView, identity?.owner, account?.account_id]);

  useEffect(() => {
    if (activeView === "keys" && identity?.owner && account) {
      loadApiKeys();
    }
  }, [activeView, identity?.owner, account?.account_id]);

  useEffect(() => {
    if (activeView === "usage" && identity?.owner && account) {
      loadRequests().then(loadInvoices);
    }
  }, [activeView, identity?.owner, account?.account_id]);

  function show(value) {
    setOutput(typeof value === "string" ? value : JSON.stringify(value, null, 2));
  }

  async function request(path, options = {}) {
    const headers = { "content-type": "application/json", ...(options.headers || {}) };
    const response = await fetch(path, { ...options, headers });
    const text = await response.text();
    const json = text ? JSON.parse(text) : null;
    if (!response.ok) throw normalizeApiError(json, response.status);
    return json;
  }

  async function withBusy(label, fn) {
    setBusy(label);
    try {
      await fn();
    } catch (error) {
      show(readableError(error));
      if (label === "walletPayment") {
        setPaymentDialog((current) => current ? { ...current, status: "failed", error: readableError(error) } : current);
      }
      if (label === "createCapability") {
        setCapDialog((current) => current ? { ...current, status: "failed", error: readableError(error) } : current);
      }
    } finally {
      setBusy("");
    }
  }

  async function loadAutopayWalletBalance() {
    if (!identity?.owner || !account?.autopay_url) return;
    setBusy("loadWalletBalance");
    setAutopayWalletBalanceError("");
    try {
      const json = await request("/api/autopay-wallet/balance");
      setAutopayWalletBalance(json);
    } catch (error) {
      setAutopayWalletBalance(null);
      setAutopayWalletBalanceError(readableError(error));
    } finally {
      setBusy("");
    }
  }

  async function updateAutopayEndpoint() {
    await withBusy("updateAutopay", async () => {
      const json = await request("/api/session/autopay", {
        method: "POST",
        body: JSON.stringify({ autopay_url: autopayUrl.trim() }),
      });
      setAccount((current) => current ? { ...current, autopay_url: json.autopay_url } : current);
      setAutopayWalletBalance(null);
      setAutopayWalletBalanceError("");
      setEditEndpointOpen(false);
      show({ message: "Autopay endpoint updated.", autopay_url: json.autopay_url });
    });
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

  async function createCapability(event) {
    event.preventDefault();
    setCapCreateOpen(false);
    await withBusy("createCapability", async () => {
      const controller = new AbortController();
      capAbortRef.current = controller;
      const signal = controller.signal;

      const json = await request("/api/autopay/capabilities", {
        method: "POST",
        body: JSON.stringify({
          total_budget: capTotalBudget.trim(),
          max_single_amount: capMaxSingleAmount.trim(),
          ttl_days: capTtlDays,
          autopay_url: account?.autopay_url || undefined,
        }),
        signal,
      });

      const qr = json.verification_uri_complete
        ? await QRCode.toDataURL(json.verification_uri_complete, {
            margin: 1,
            scale: 8,
            color: { dark: "#111827", light: "#ffffff" },
          })
        : "";

      setCapDialog({
        status: "waiting",
        qr,
        url: json.verification_uri_complete,
        error: "",
        capId: json.capability_id,
      });

      const result = await waitForAutopayAuthorization(
        `/api/autopay/capabilities/${encodeURIComponent(json.capability_id)}/complete`,
        {
          poll_token: json.poll_token,
          autopay_url: json.autopay_url,
          total_budget: capTotalBudget.trim(),
          max_single_amount: capMaxSingleAmount.trim(),
        },
        json.websocket_uri_complete,
        signal,
      );

      if (result.status === "active" || result.status === "settled") {
        setCapDialog((current) => (current ? { ...current, status: "done" } : current));
      } else {
        const errorText = typeof result.message === "string" ? result.message : `Authorization ${result.status || "failed"}.`;
        setCapDialog((current) => (current ? { ...current, status: "failed", error: errorText } : current));
      }
      show(result);
      await loadCapabilities();
    });
  }

  async function revokeCapability(capId) {
    if (!window.confirm("Revoke this autopay authorization? Future autopay requests will require fresh approval.")) return;
    await withBusy("revokeCapability", async () => {
      const json = await request(`/api/autopay/capabilities/${encodeURIComponent(capId)}`, { method: "DELETE" });
      show(json);
      await loadCapabilities();
    });
  }

  function openCapCreate() {
    setCapTotalBudget("5.00");
    setCapMaxSingleAmount("5.00");
    setCapTtlDays(7);
    setCapCreateOpen(true);
  }

  function closeCapCreate() {
    setCapCreateOpen(false);
  }

  function closeCapDialog() {
    if (capAbortRef.current) {
      capAbortRef.current.abort();
      capAbortRef.current = null;
    }
    setCapDialog(null);
    setCapApprovalCopied(false);
  }

  async function copyCapApprovalLink() {
    if (!capDialog?.url) return;
    try {
      await navigator.clipboard.writeText(capDialog.url);
      setCapApprovalCopied(true);
      window.setTimeout(() => setCapApprovalCopied(false), 1400);
    } catch {
      setCapApprovalCopied(false);
    }
  }

  async function loadAccount() {
    setBusy("loadAccount");
    try {
      const json = await request("/api/account");
      setAccount(json);
      setAutopayUrl(json.autopay_url || DEFAULT_AUTOPAY_URL);
      setAccountMissing(false);
      show(json);
    } catch (error) {
      if (isAccountNotFound(error)) {
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
        show({ status: "account_activation_required", owner: identity?.owner });
      } else {
        show(readableError(error));
      }
    } finally {
      setBusy("");
    }
  }

  async function loadApiKeys() {
    await withBusy("loadApiKeys", async () => {
      const json = await request("/api/api-keys");
      setApiKeys(json.api_keys || []);
      show(json);
    });
  }

  function openCreateKeyDialog() {
    setNewApiKey("");
    setKeyDialogError("");
    setCreateKeyOpen(true);
  }

  function closeCreateKeyDialog() {
    if (busy === "createApiKey") return;
    setCreateKeyOpen(false);
    setKeyDialogError("");
    setNewApiKey("");
    setNewKeyName("");
    setNewKeyDuration("1y");
    setNewKeySpendLimit("");
  }

  function openEditEndpointDialog() {
    setAutopayUrl(account?.autopay_url || DEFAULT_AUTOPAY_URL);
    setEditEndpointOpen(true);
  }

  function closeEditEndpointDialog() {
    setEditEndpointOpen(false);
  }

  function openDepositDialog() {
    setDepositDialogOpen(true);
  }

  function closeDepositDialog() {
    if (busy === "walletPayment" && paymentDialog?.status !== "settled" && paymentDialog?.status !== "failed") return;
    setDepositDialogOpen(false);
  }

  function closePaymentDialog() {
    if (busy === "walletPayment" && paymentDialog?.status !== "settled" && paymentDialog?.status !== "failed") return;
    setPaymentDialog(null);
  }

  async function createManagedApiKey(event) {
    event.preventDefault();
    setBusy("createApiKey");
    setKeyDialogError("");
    try {
      const json = await request("/api/api-keys", {
        method: "POST",
        body: JSON.stringify({
          name: newKeyName.trim() || undefined,
          expires_at: apiKeyDurationToIso(newKeyDuration),
          spend_limit: newKeySpendLimit.trim() || undefined,
        }),
      });
      if (json.api_key) {
        setNewApiKey(json.api_key);
      }
      setNewKeyName("");
      setNewKeyDuration("1y");
      setNewKeySpendLimit("");
      const keysJson = await request("/api/api-keys");
      setApiKeys(keysJson.api_keys || []);
    } catch (error) {
      setKeyDialogError(readableError(error));
    } finally {
      setBusy("");
    }
  }

  async function disableApiKey(keyId) {
    await withBusy("disableApiKey", async () => {
      const json = await request(`/api/api-keys/${encodeURIComponent(keyId)}/disable`, {
        method: "POST",
      });
      show(json);
      await loadApiKeys();
    });
  }

  async function enableApiKey(keyId) {
    await withBusy("enableApiKey", async () => {
      const json = await request(`/api/api-keys/${encodeURIComponent(keyId)}/enable`, {
        method: "POST",
      });
      show(json);
      await loadApiKeys();
    });
  }

  async function deleteApiKey(keyId) {
    if (!window.confirm("Delete this API key? It will be hidden and clients using it will stop working.")) return;
    await withBusy("deleteApiKey", async () => {
      const json = await request(`/api/api-keys/${encodeURIComponent(keyId)}`, {
        method: "DELETE",
      });
      show(json);
      await loadApiKeys();
    });
  }

  async function loadInvoices() {
    await withBusy("loadInvoices", async () => {
      const json = await request("/api/invoices");
      setLastInvoices(json.invoices || []);
      show(json);
    });
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
    await withBusy("loadRequests", async () => {
      const url = cursor
        ? `/api/requests?cursor=${encodeURIComponent(cursor)}`
        : "/api/requests";
      const json = await request(url);
      setRequests(json.requests || []);
      setRequestsCursor(cursor);
      setRequestsPrevCursors(prevCursors);
      setRequestsNextCursor(json.next_cursor || null);
      show(json);
    });
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

  async function autopayInvoice() {
    await withBusy("autopayInvoice", async () => {
      let invoices = lastInvoices;
      if (!invoices.length) {
        const json = await request("/api/invoices");
        invoices = json.invoices || [];
        setLastInvoices(invoices);
      }
      const invoice = invoices.find((item) => item.status === "unpaid");
      if (!invoice) throw new Error("No unpaid invoice was found.");

      const started = await request(`/api/invoices/${encodeURIComponent(invoice.id)}/pay/autopay/start`, {
        method: "POST",
        body: "{}",
      });
      if (started.status === "settled") {
        show(started);
        await Promise.all([loadAccount(), loadInvoices()]);
        return;
      }
      show({
        message: "Open the payment link in your wallet, then this page will wait for settlement.",
        ...started,
      });
      openAuthorization(started.verification_uri_complete);
      const result = await waitForAutopayAuthorization(
        `/api/invoices/${encodeURIComponent(invoice.id)}/pay/autopay/complete`,
        { payment_id: started.payment_id },
        started.websocket_uri_complete,
      );
      if (result?.status === "settled") {
        await Promise.all([loadAccount(), loadInvoices()]);
      }
    });
  }

  async function waitForAutopayAuthorization(path, body, websocketUrl, signal) {
    if (!websocketUrl || (signal && signal.aborted)) {
      return await pollAutopay(path, body, signal);
    }

    let reconnectAttempts = 0;
    const MAX_RECONNECT_ATTEMPTS = 3;

    async function tryWebSocket() {
      return await new Promise((resolve, reject) => {
        const socket = new WebSocket(websocketUrl);
        let settled = false;

        function onAbort() {
          if (!settled) {
            settled = true;
            socket.close();
            reject(new Error("Authorization cancelled."));
          }
        }
        if (signal) signal.addEventListener("abort", onAbort);

        socket.onerror = () => {
          if (!settled) {
            settled = true;
            socket.close();
            if (reconnectAttempts < MAX_RECONNECT_ATTEMPTS) {
              reconnectAttempts += 1;
              show({ message: `WebSocket disconnected. Reconnecting (${reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS})...` });
              tryWebSocket().then(resolve, reject);
            } else {
              show({ message: "WebSocket failed, falling back to polling..." });
              pollAutopay(path, body, signal).then(resolve, reject);
            }
          }
        };
        socket.onclose = () => {
          if (!settled) {
            settled = true;
            if (reconnectAttempts < MAX_RECONNECT_ATTEMPTS) {
              reconnectAttempts += 1;
              show({ message: `WebSocket closed. Reconnecting (${reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS})...` });
              tryWebSocket().then(resolve, reject);
            } else {
              show({ message: "WebSocket closed, falling back to polling..." });
              pollAutopay(path, body, signal).then(resolve, reject);
            }
          }
        };
        socket.onmessage = (event) => {
          const message = parseSocketMessage(event.data);
          if (message.status === "pending") {
            show({ message: "Waiting for wallet signature...", event: message });
            return;
          }
          if (message.status === "approved") {
            settled = true;
            socket.close();
            request(path, {
              method: "POST",
              body: JSON.stringify(body),
              signal,
            }).then((json) => {
              show(json);
              resolve(json);
            }, reject);
            return;
          }
          if (message.status === "denied" || message.status === "expired") {
            settled = true;
            socket.close();
            show(message);
            resolve(message);
          }
        };
      });
    }

    return tryWebSocket();
  }

  async function pollAutopay(path, body, signal) {
    let lastError = "";
    let consecutiveErrors = 0;
    const MAX_POLL_ATTEMPTS = 150; // 5 minutes at 2s intervals
    const MAX_CONSECUTIVE_ERRORS = 5;

    for (let attempt = 0; attempt < MAX_POLL_ATTEMPTS; attempt++) {
      if (signal?.aborted) {
        throw new Error("Authorization cancelled.");
      }
      await new Promise((resolve) => setTimeout(resolve, 2000));
      if (signal?.aborted) {
        throw new Error("Authorization cancelled.");
      }
      try {
        const json = await request(path, {
          method: "POST",
          body: JSON.stringify(body),
          signal,
        });
        show(json);
        consecutiveErrors = 0;
        if (json.status === "settled" || json.status === "settle_failed" || json.status === "denied" || json.status === "active") {
          return json;
        }
      } catch (error) {
        if (signal?.aborted) {
          throw new Error("Authorization cancelled.");
        }
        lastError = readableError(error);
        consecutiveErrors += 1;
        show({ message: "Polling error (" + consecutiveErrors + "/" + MAX_CONSECUTIVE_ERRORS + "): " + lastError });
        if (capDialog) {
          setCapDialog((current) => current ? { ...current, error: lastError } : current);
        }
        if (consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) {
          throw new Error("Polling failed " + MAX_CONSECUTIVE_ERRORS + " times in a row. Last error: " + lastError);
        }
      }
    }
    throw new Error("Authorization polling timed out after 5 minutes.");
  }

  function openAuthorization(url) {
    if (url) window.open(url, "_blank", "noopener,noreferrer");
  }

  const isBusy = Boolean(busy);

  async function logout() {
    try {
      await fetchJson("/api/logout", { method: "POST" });
    } catch {
      // The local view should still leave the logged-in surface.
    }
    setIdentity(null);
    onSessionChange(null);
    window.location.assign("/login");
  }

  const navItems = [
    { href: "/console/recharge", view: "recharge", label: t("Recharge") },
    { href: "/console/autopay", view: "autopay", label: t("Autopay Limits") },
    { href: "/console/keys", view: "keys", label: t("API Keys", { ns: "nav" }) },
    { href: "/console/usage", view: "usage", label: t("Usage") },
    { href: "/console/settings", view: "settings", label: t("Settings") },
  ];

  function closeSidebar() {
    setSidebarOpen(false);
  }

  function navigateConsole(event, item) {
    event.preventDefault();
    navigateConsoleView(item.view);
    closeSidebar();
  }

  function navigateConsoleView(view) {
    const item = navItems.find((candidate) => candidate.view === view) || navItems[0];
    if (window.location.pathname !== item.href) {
      window.history.pushState({}, "", item.href);
    }
    setActiveView(item.view);
  }

  const activeItem = navItems.find((item) => item.view === activeView) || navItems[0];

  return (
    <div className="console-shell">
      <aside className={`console-sidebar ${sidebarOpen ? "open" : ""}`}>
        <a className="brand console-brand" href="/">
          <img src="/logo-transparent.png" alt="" className="brand-icon" />
          Meteria402
        </a>
        <nav className="console-nav" aria-label="Console navigation">
          {navItems.map((item) => (
            <a
              key={item.href}
              href={item.href}
              className={item.view === activeView ? "active" : ""}
              onClick={(event) => navigateConsole(event, item)}
            >
              {item.label}
            </a>
          ))}
        </nav>
      </aside>
      <button
        className={`sidebar-scrim ${sidebarOpen ? "visible" : ""}`}
        aria-label="Close navigation"
        aria-hidden={!sidebarOpen}
        tabIndex={sidebarOpen ? 0 : -1}
        onClick={closeSidebar}
      />

      <main className="console-main">
        <div className="console-topbar">
          <button
            className="icon-button menu-button"
            type="button"
            aria-label="Open navigation"
            aria-expanded={sidebarOpen}
            onClick={() => setSidebarOpen(true)}
          >
            <svg className="menu-icon" viewBox="0 0 24 24" aria-hidden="true">
              <path d="M5 7h14M5 12h14M5 17h14" />
            </svg>
          </button>
          <a className="brand mobile-console-brand" href="/">Meteria402</a>
          {identity && (
            <div className="console-identity">
              <span>{shortAddress(identity.owner)}</span>
              <button className="icon-button logout-button" type="button" aria-label="Logout" title="Logout" onClick={logout}>
                <svg className="logout-icon" viewBox="0 0 24 24" aria-hidden="true">
                  <path d="M10 5H7a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h3" />
                  <path d="M14 8l4 4-4 4" />
                  <path d="M18 12H9" />
                </svg>
              </button>
            </div>
          )}
        </div>

        <div className="console-header">
          <div>
            <h1>{accountMissing ? t("Activate account") : activeItem.label}</h1>
          </div>
        </div>

        {accountMissing ? (
          <ActivationView
            identity={identity}
            isBusy={isBusy}
            openDepositDialog={openDepositDialog}
            depositDialogOpen={depositDialogOpen}
            closeDepositDialog={closeDepositDialog}
            request={request}
            withBusy={withBusy}
            show={show}
            autopayUrl={autopayUrl}
            setNewApiKey={setNewApiKey}
            loadAccount={loadAccount}
            waitForAutopayAuthorization={waitForAutopayAuthorization}
          />
        ) : activeView === "recharge" && (
          <RechargeView
            account={account}
            deposits={deposits}
            depositsLoading={depositsLoading}
            identity={identity}
            autopayWalletBalance={autopayWalletBalance}
            autopayWalletBalanceError={autopayWalletBalanceError}
            isBusy={isBusy}
            busy={busy}
            loadAccount={loadAccount}
            loadDeposits={loadDeposits}
            loadAutopayWalletBalance={loadAutopayWalletBalance}
            openDepositDialog={openDepositDialog}
            closeDepositDialog={closeDepositDialog}
            editEndpointOpen={editEndpointOpen}
            closeEditEndpointDialog={closeEditEndpointDialog}
            openEditEndpointDialog={openEditEndpointDialog}
            autopayUrl={autopayUrl}
            setAutopayUrl={setAutopayUrl}
            updateAutopayEndpoint={updateAutopayEndpoint}
            depositDialogOpen={depositDialogOpen}
            paymentDialog={paymentDialog}
            closePaymentDialog={closePaymentDialog}
            request={request}
            withBusy={withBusy}
            show={show}
            setNewApiKey={setNewApiKey}
            waitForAutopayAuthorization={waitForAutopayAuthorization}
          />
        )}

        {!accountMissing && activeView === "keys" && (
          <KeysView
            apiKeys={apiKeys}
            isBusy={isBusy}
            busy={busy}
            loadApiKeys={loadApiKeys}
            openCreateKeyDialog={openCreateKeyDialog}
            disableApiKey={disableApiKey}
            enableApiKey={enableApiKey}
            deleteApiKey={deleteApiKey}
            navigateConsoleView={navigateConsoleView}
            createKeyOpen={createKeyOpen}
            closeCreateKeyDialog={closeCreateKeyDialog}
            createManagedApiKey={createManagedApiKey}
            newKeyName={newKeyName}
            setNewKeyName={setNewKeyName}
            newKeyDuration={newKeyDuration}
            setNewKeyDuration={setNewKeyDuration}
            newKeySpendLimit={newKeySpendLimit}
            setNewKeySpendLimit={setNewKeySpendLimit}
            newApiKey={newApiKey}
            keyDialogError={keyDialogError}
            formatMoneyCompact={formatMoneyCompact}
          />
        )}

        {!accountMissing && activeView === "usage" && (
          <UsageView
            requests={requests}
            lastInvoices={lastInvoices}
            isBusy={isBusy}
            busy={busy}
            loadRequests={loadRequests}
            loadPreviousRequestsPage={loadPreviousRequestsPage}
            loadNextRequestsPage={loadNextRequestsPage}
            requestsPage={requestsPrevCursors.length + 1}
            hasPreviousRequestsPage={requestsPrevCursors.length > 0}
            hasNextRequestsPage={Boolean(requestsNextCursor)}
            loadInvoices={loadInvoices}
            autopayInvoice={autopayInvoice}
          />
        )}

        {!accountMissing && activeView === "autopay" && (
          <AutopayView
            capabilities={capabilities}
            capabilitiesLoading={capabilitiesLoading}
            isBusy={isBusy}
            busy={busy}
            loadCapabilities={loadCapabilities}
            openCapCreate={openCapCreate}
            revokeCapability={revokeCapability}
            capCreateOpen={capCreateOpen}
            closeCapCreate={closeCapCreate}
            createCapability={createCapability}
            capDialog={capDialog}
            closeCapDialog={closeCapDialog}
            capTotalBudget={capTotalBudget}
            setCapTotalBudget={setCapTotalBudget}
            capMaxSingleAmount={capMaxSingleAmount}
            setCapMaxSingleAmount={setCapMaxSingleAmount}
            capTtlDays={capTtlDays}
            setCapTtlDays={setCapTtlDays}
            capApprovalCopied={capApprovalCopied}
            copyCapApprovalLink={copyCapApprovalLink}
          />
        )}

        {!accountMissing && activeView === "settings" && (
          <SettingsView
            identity={identity}
            account={account}
            isBusy={isBusy}
            busy={busy}
            request={request}
            show={show}
            onSessionChange={onSessionChange}
            loadAccount={loadAccount}
          />
        )}
      </main>
    </div>
  );
}

function ActivationView({
  identity,
  isBusy,
  openDepositDialog,
  depositDialogOpen,
  closeDepositDialog,
  request,
  withBusy,
  show,
  autopayUrl,
  setNewApiKey,
  loadAccount,
  waitForAutopayAuthorization,
}) {
  return (
    <>
      <section className="activation-panel">
        <div>
          <p className="eyebrow">Account setup</p>
          <h2>Activate your account</h2>
          <p>
            Make your first deposit to create the account, enable API keys, and start metered gateway usage.
          </p>
          <div className="activation-owner">
            <span>Main wallet</span>
            <strong>{identity?.owner ? shortAddress(identity.owner) : "Not connected"}</strong>
          </div>
        </div>
        <div className="activation-actions">
          <button disabled={isBusy} className="primary" onClick={openDepositDialog}>
            Add deposit
          </button>
        </div>
      </section>

      {depositDialogOpen && (
        <DepositDialog
          open={depositDialogOpen}
          onClose={closeDepositDialog}
          request={request}
          withBusy={withBusy}
          isBusy={isBusy}
          show={show}
          identity={identity}
          autopayUrl={autopayUrl}
          setNewApiKey={setNewApiKey}
          waitForAutopayAuthorization={waitForAutopayAuthorization}
          loadAccount={loadAccount}
        />
      )}
    </>
  );
}

function isAccountNotFound(error) {
  return error && typeof error === "object" && error.code === "account_not_found";
}

async function fetchSession() {
  return await fetchJson("/api/session");
}

async function fetchJson(path, options = {}) {
  const response = await fetch(path, options);
  const text = await response.text();
  const json = text ? JSON.parse(text) : null;
  if (!response.ok) throw normalizeApiError(json, response.status);
  return json;
}

function parseSocketMessage(data) {
  if (typeof data !== "string") {
    throw new Error("Unexpected WebSocket message.");
  }
  return JSON.parse(data);
}

createRoot(document.getElementById("root")).render(
  React.createElement(I18nProvider, null, React.createElement(App))
);
