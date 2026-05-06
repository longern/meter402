import React, { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import QRCode from "qrcode";
import PayDepositPage from "./PayDepositPage";
import RechargeView from "./views/RechargeView";
import KeysView from "./views/KeysView";
import UsageView from "./views/UsageView";
import AutopayView from "./views/AutopayView";
import { GATEWAY_PROVIDERS } from "./gatewayProviders";
import {
  readableError,
  shortAddress,
  formatCompactNumber,
  formatMoneyCompact,
  datetimeLocalToIso,
  getConsoleView,
  consoleViewSubtitle,
  buildCoinbaseWalletLink,
  buildOkxWalletLink,
  readStoredAutopayEndpoint,
  writeStoredAutopayEndpoint,
} from "./utils";
import "./styles.css";

const AUTOPAY_ENDPOINT_STORAGE_KEY = "meteria402_last_autopay_endpoint";
const DEFAULT_AUTOPAY_URL = import.meta.env.VITE_DEFAULT_AUTOPAY_URL || "";
const LOGIN_SUCCESS_REDIRECT_DELAY_MS = 500;
const COPY_FEEDBACK_DELAY_MS = 1400;

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
  if (path.startsWith("/console") && !sessionLoaded) {
    return null;
  }
  if (path.startsWith("/console") && !session) {
    return <LoginPage returnTo={window.location.pathname} onSessionChange={setSession} />;
  }
  return <ConsoleApp initialIdentity={session} onSessionChange={setSession} />;
}

function HomePage() {
  return (
    <div className="home">
      <nav className="home-nav">
        <a className="brand" href="/">Meteria402</a>
        <div className="nav-actions">
          <a href="/console">Console</a>
        </div>
      </nav>

      <main className="home-main">
        <section className="hero">
          <div className="hero-copy">
            <p className="eyebrow">OpenAI-compatible metered gateway</p>
            <h1>Meteria402</h1>
            <p className="hero-lead">
              A deposit-backed AI API gateway that creates x402 invoices from actual token usage.
            </p>
            <div className="hero-actions">
              <a className="button-link primary" href="/console">Open console</a>
              <a className="button-link secondary" href="/compat/chat/completions">Compat endpoint</a>
            </div>
          </div>

          <div className="flow-panel" aria-label="Meteria402 request flow">
            <div className="flow-row">
              <span>Client</span>
              <strong>/v1 or /compat</strong>
            </div>
            <div className="flow-line" />
            <div className="flow-row">
              <span>Meteria402</span>
              <strong>deposit + invoice gate</strong>
            </div>
            <div className="flow-line" />
            <div className="flow-row">
              <span>Cloudflare AI Gateway</span>
              <strong>model response + usage</strong>
            </div>
            <div className="flow-line" />
            <div className="flow-row accent">
              <span>x402</span>
              <strong>pay invoices with wallet approval</strong>
            </div>
          </div>
        </section>

        <section className="home-section">
          <h2>How It Works</h2>
          <div className="feature-grid">
            <article>
              <span className="step">01</span>
              <h3>Deposit</h3>
              <p>Create a refundable deposit quote and receive a one-time API key after x402 settlement.</p>
            </article>
            <article>
              <span className="step">02</span>
              <h3>Meter</h3>
              <p>Use any OpenAI-compatible client while the Worker records request usage through Cloudflare AI Gateway.</p>
            </article>
            <article>
              <span className="step">03</span>
              <h3>Invoice</h3>
              <p>Each successful request creates an unpaid usage invoice that must be settled before the next request.</p>
            </article>
            <article>
              <span className="step">04</span>
              <h3>Autopay</h3>
              <p>Approve scoped wallet payments for deposit and invoice settlement without exposing your owner wallet key.</p>
            </article>
          </div>
        </section>

        <section className="home-section split">
          <div>
            <h2>Gateway Endpoint</h2>
            <p>Point each provider SDK at the matching Meteria402 path.</p>
          </div>
          <pre className="code-sample">{`const client = new OpenAI({
  apiKey: "meteria402_xxx",
  baseURL: "https://your-worker.example.com/v1",
});`}</pre>
        </section>

        <section className="home-section">
          <h2>Provider Paths</h2>
          <div className="provider-path-grid">
            {GATEWAY_PROVIDERS.slice(0, 10).map((provider) => (
              <article key={provider.path}>
                <strong>{provider.path}</strong>
                <span>{provider.label}</span>
              </article>
            ))}
          </div>
        </section>
      </main>
    </div>
  );
}

function LoginPage({ returnTo = "", onSessionChange = () => {} }) {
  const initialAutopayEndpoint = readStoredAutopayEndpoint();
  const [autopayUrl, setAutopayUrl] = useState(initialAutopayEndpoint || DEFAULT_AUTOPAY_URL);
  const [verificationUrl, setVerificationUrl] = useState("");
  const [verificationQr, setVerificationQr] = useState("");
  const [step, setStep] = useState("worker");
  const [stepDirection, setStepDirection] = useState("forward");
  const [identity, setIdentity] = useState(null);
  const [status, setStatus] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [authExpired, setAuthExpired] = useState(false);
  const [approvalLinkCopied, setApprovalLinkCopied] = useState(false);
  const autoStartEndpointRef = useRef(initialAutopayEndpoint);
  const didAutoStartRef = useRef(false);
  const loginAttemptRef = useRef(0);
  const loginSocketRef = useRef(null);
  const copyFeedbackTimerRef = useRef(null);

  const stepOrder = ["worker", "authorize", "complete"];

  useEffect(() => {
    const endpoint = autoStartEndpointRef.current?.trim();
    if (!endpoint || didAutoStartRef.current) return undefined;
    didAutoStartRef.current = true;
    login(null, endpoint);
    return () => {
      cancelLoginAttempt();
      clearCopyFeedbackTimer();
    };
  }, []);

  function clearCopyFeedbackTimer() {
    if (copyFeedbackTimerRef.current) {
      window.clearTimeout(copyFeedbackTimerRef.current);
      copyFeedbackTimerRef.current = null;
    }
  }

  function goToStep(nextStep) {
    setStepDirection(stepOrder.indexOf(nextStep) >= stepOrder.indexOf(step) ? "forward" : "back");
    setStep(nextStep);
  }

  function startLoginAttempt() {
    loginAttemptRef.current += 1;
    if (loginSocketRef.current) {
      loginSocketRef.current.close();
      loginSocketRef.current = null;
    }
    return loginAttemptRef.current;
  }

  function isActiveLoginAttempt(attemptId) {
    return loginAttemptRef.current === attemptId;
  }

  function cancelLoginAttempt() {
    loginAttemptRef.current += 1;
    if (loginSocketRef.current) {
      loginSocketRef.current.close();
      loginSocketRef.current = null;
    }
  }

  function returnToEndpointStep() {
    cancelLoginAttempt();
    setBusy(false);
    setStatus("");
    setError("");
    setAuthExpired(false);
    clearCopyFeedbackTimer();
    setApprovalLinkCopied(false);
    setVerificationQr("");
    setVerificationUrl("");
    goToStep("worker");
  }

  function refreshAuthorizationRequest() {
    if (busy) return;
    login(null, autopayUrl);
  }

  async function login(event, endpointOverride = "") {
    event?.preventDefault();
    const endpoint = (endpointOverride || autopayUrl).trim();
    if (!endpoint) return;
    const attemptId = startLoginAttempt();
    setBusy(true);
    setAutopayUrl(endpoint);
    setStatus("Creating login request...");
    setError("");
    setAuthExpired(false);
    clearCopyFeedbackTimer();
    setApprovalLinkCopied(false);
    setVerificationQr("");
    setVerificationUrl("");
    goToStep("authorize");
    try {
      const started = await fetchJson("/api/login/autopay/start", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ autopay_url: endpoint }),
      });
      if (!isActiveLoginAttempt(attemptId)) return;
      writeStoredAutopayEndpoint(endpoint);
      setVerificationUrl(started.verification_uri_complete);
      if (started.verification_uri_complete) {
        const qr = await QRCode.toDataURL(started.verification_uri_complete, {
          margin: 1,
          scale: 8,
          color: {
            dark: "#111827",
            light: "#ffffff",
          },
        });
        if (!isActiveLoginAttempt(attemptId)) return;
        setVerificationQr(qr);
      }
      setStatus("Waiting for owner wallet signature...");
      if (started.websocket_uri_complete) {
        await waitForLoginAuthorization(started.websocket_uri_complete, started.login_request_id, attemptId);
      } else {
        await pollLogin(started.login_request_id, attemptId);
      }
    } catch (error) {
      if (!isActiveLoginAttempt(attemptId)) return;
      const message = readableError(error);
      setStatus(message);
      setError(message);
      goToStep("worker");
    } finally {
      if (isActiveLoginAttempt(attemptId)) setBusy(false);
    }
  }

  async function pollLogin(id, attemptId) {
    while (isActiveLoginAttempt(attemptId)) {
      await new Promise((resolve) => setTimeout(resolve, 2000));
      if (!isActiveLoginAttempt(attemptId)) return;
      const completed = await completeLogin(id, attemptId);
      if (completed.status === "approved" || completed.status === "denied" || completed.status === "expired") {
        return;
      }
      if (!isActiveLoginAttempt(attemptId)) return;
      setStatus("Waiting for owner wallet signature...");
    }
  }

  async function waitForLoginAuthorization(url, id, attemptId) {
    await new Promise((resolve, reject) => {
      const socket = new WebSocket(url);
      loginSocketRef.current = socket;
      let settled = false;

      socket.onopen = () => {
        if (isActiveLoginAttempt(attemptId)) setStatus("Waiting for owner wallet signature...");
      };
      socket.onerror = () => {
        if (!isActiveLoginAttempt(attemptId)) {
          resolve();
          return;
        }
        if (!settled) reject(new Error("Authorization WebSocket failed."));
      };
      socket.onclose = () => {
        if (!isActiveLoginAttempt(attemptId)) {
          resolve();
          return;
        }
        if (!settled) reject(new Error("Authorization WebSocket closed before login completed."));
      };
      socket.onmessage = (event) => {
        if (!isActiveLoginAttempt(attemptId)) return;
        const message = parseSocketMessage(event.data);
        if (message.status === "pending") {
          setStatus("Waiting for owner wallet signature...");
          return;
        }
        if (message.status === "approved") {
          settled = true;
          socket.close();
          loginSocketRef.current = null;
          completeLogin(id, attemptId).then(resolve, reject);
          return;
        }
        if (message.status === "denied") {
          settled = true;
          socket.close();
          loginSocketRef.current = null;
          setStatus("Login denied.");
          setError("The owner wallet denied this login request.");
          resolve();
          return;
        }
        if (message.status === "expired") {
          settled = true;
          socket.close();
          loginSocketRef.current = null;
          setStatus("QR code expired.");
          setError("");
          setAuthExpired(true);
          resolve();
        }
      };
    });
  }

  async function completeLogin(id, attemptId) {
    const completed = await fetchJson("/api/login/autopay/complete", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ login_request_id: id }),
    });
    if (!isActiveLoginAttempt(attemptId)) return { status: "canceled" };
    if (completed.status === "approved") {
      const nextIdentity = {
        owner: completed.owner,
        autopay_url: completed.autopay_url,
        expires_at: completed.expires_at,
      };
      setIdentity(nextIdentity);
      onSessionChange(nextIdentity);
      setStatus("Login approved.");
      goToStep("complete");
      window.setTimeout(() => {
        if (isActiveLoginAttempt(attemptId)) window.location.assign(returnTo || "/console");
      }, LOGIN_SUCCESS_REDIRECT_DELAY_MS);
    } else if (completed.status === "denied") {
      setStatus("Login denied.");
      setError("The owner wallet denied this login request.");
    } else if (completed.status === "expired") {
      setStatus("QR code expired.");
      setError("");
      setAuthExpired(true);
    }
    return completed;
  }

  async function copyApprovalLink() {
    if (!verificationUrl || authExpired) return;
    try {
      await navigator.clipboard.writeText(verificationUrl);
      setApprovalLinkCopied(true);
      clearCopyFeedbackTimer();
      copyFeedbackTimerRef.current = window.setTimeout(() => {
        setApprovalLinkCopied(false);
        copyFeedbackTimerRef.current = null;
      }, COPY_FEEDBACK_DELAY_MS);
    } catch {
      clearCopyFeedbackTimer();
      setApprovalLinkCopied(false);
    }
  }

  return (
    <main className="login-main">
      <nav className="compact-nav">
        <a className="brand" href="/">Meteria402</a>
        <a href="/">Home</a>
      </nav>

      <section className="login-panel">
        <div className="login-heading">
          <h1>Sign in</h1>
          <p>Use your wallet</p>
        </div>

        <div className="login-step-viewport">
          <div key={step} className={`login-step-card ${stepDirection}`}>
            {step === "worker" && (
              <form onSubmit={login}>
                <label>
                  <span>Autopay endpoint</span>
                  <input
                    value={autopayUrl}
                    placeholder="https://autopay.example.com"
                    autoComplete="url"
                    onChange={(event) => setAutopayUrl(event.target.value)}
                  />
                </label>
                {error && <p className="login-error" role="alert">{error}</p>}
                <div className="login-actions">
                  <button className="primary" disabled={busy || !autopayUrl.trim()} type="submit">
                    {busy ? "Creating request..." : "Continue"}
                  </button>
                </div>
              </form>
            )}

            {step === "authorize" && (
              <div className="login-authorization">
                <div className="login-authorization-header">
                  <h2>
                    <span className="desktop-login-title">Approve in your owner wallet</span>
                    <span className="mobile-login-title">Continue in your wallet</span>
                  </h2>
                </div>

                <div className="login-approval-options">
                  <div className="login-approval-option">
                    <span>Mobile wallet</span>
                    {authExpired ? (
                      <button className="login-qr-expired" type="button" onClick={refreshAuthorizationRequest} disabled={busy}>
                        <span aria-hidden="true" />
                        <strong>QR expired</strong>
                        <small>{busy ? "Refreshing..." : "Click to refresh"}</small>
                      </button>
                    ) : verificationQr ? (
                      <img src={verificationQr} alt="Owner wallet authorization QR code" />
                    ) : (
                      <div className="login-qr-placeholder" aria-label="Preparing approval" />
                    )}
                  </div>

                  <div className="login-approval-option">
                    <span>Desktop</span>
                    <div className="login-desktop-approval">
                      <strong>Open the approval page</strong>
                      <p>Use this browser if your wallet is available here.</p>
                      <a className="button-link secondary" href={verificationUrl && !authExpired ? verificationUrl : undefined} target="_blank" rel="noreferrer" aria-disabled={!verificationUrl || authExpired}>Open approval</a>
                    </div>
                  </div>
                </div>

                <div className="login-mobile-approval">
                  <div className="wallet-deeplink-actions" aria-label="Open in wallet app">
                    <a className="wallet-icon-link" href={verificationUrl && !authExpired ? buildCoinbaseWalletLink(verificationUrl) : undefined} aria-disabled={!verificationUrl || authExpired} aria-label="Open in Coinbase Wallet">
                      <img src="/wallet-icons/coinbase-wallet.svg" alt="" />
                    </a>
                    <a className="wallet-icon-link" href={verificationUrl && !authExpired ? buildOkxWalletLink(verificationUrl) : undefined} aria-disabled={!verificationUrl || authExpired} aria-label="Open in OKX Wallet">
                      <img src="/wallet-icons/okx-wallet.svg" alt="" />
                    </a>
                  </div>
                  <p className="wallet-mobile-fallback">or manually copy the link and open it in your wallet app browser.</p>
                  <div className="approval-link-box">
                    <div className="approval-link-header">
                      <span>Approval link</span>
                      <button className={`approval-copy-button${approvalLinkCopied ? " copied" : ""}`} type="button" onClick={copyApprovalLink} disabled={!verificationUrl || authExpired} aria-label={approvalLinkCopied ? "Approval link copied" : "Copy approval link"} title={approvalLinkCopied ? "Copied" : "Copy approval link"}>
                        {approvalLinkCopied ? (
                          <svg viewBox="0 0 24 24" aria-hidden="true">
                            <path d="M5 13l4 4L19 7" />
                          </svg>
                        ) : (
                          <svg viewBox="0 0 24 24" aria-hidden="true">
                            <rect x="9" y="9" width="10" height="10" rx="2" />
                            <path d="M6 15H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v1" />
                          </svg>
                        )}
                      </button>
                    </div>
                    <code>{verificationUrl || "Preparing link..."}</code>
                  </div>
                </div>

                <div className="login-actions login-authorize-actions">
                  <button className="text-button" type="button" onClick={returnToEndpointStep}>
                    Back
                  </button>
                  <span className="login-endpoint-inline">Endpoint: <strong>{autopayUrl}</strong></span>
                </div>
              </div>
            )}

            {step === "complete" && (
              <div className="login-complete">
                <h2>Signed in</h2>
                <p>Your owner wallet is connected for this browser.</p>
                {identity && (
                  <dl>
                    <dt>Owner</dt>
                    <dd>{identity.owner}</dd>
                  </dl>
                )}
                <div className="login-actions">
                  <a className="button-link primary" href={returnTo || "/console"}>Open console</a>
                </div>
              </div>
            )}
          </div>
        </div>
      </section>
    </main>
  );
}

function ConsoleApp({ initialIdentity, onSessionChange = () => {} }) {
  const [identity, setIdentity] = useState(initialIdentity);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [activeView, setActiveView] = useState(() => getConsoleView(window.location.pathname));
  const [autopayUrl, setAutopayUrl] = useState(initialIdentity?.autopay_url || DEFAULT_AUTOPAY_URL);
  const [newApiKey, setNewApiKey] = useState("");
  const [newKeyName, setNewKeyName] = useState("");
  const [newKeyExpiresAt, setNewKeyExpiresAt] = useState("");
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
  const [apiKeys, setApiKeys] = useState([]);
  const [lastInvoices, setLastInvoices] = useState([]);
  const [deposits, setDeposits] = useState([]);
  const [requests, setRequests] = useState([]);
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
    if (initialIdentity?.autopay_url) setAutopayUrl(initialIdentity.autopay_url);
  }, [initialIdentity?.owner, initialIdentity?.autopay_url]);

  useEffect(() => {
    if (activeView === "recharge" && identity?.owner) {
      loadAutopayWalletBalance();
      loadAccount();
      loadDeposits();
    }
  }, [activeView, identity?.owner]);

  useEffect(() => {
    if (activeView === "autopay" && identity?.owner) {
      loadCapabilities();
    }
  }, [activeView, identity?.owner]);

  useEffect(() => {
    if (activeView === "keys" && identity?.owner) {
      loadApiKeys();
    }
  }, [activeView, identity?.owner]);

  useEffect(() => {
    if (activeView === "usage" && identity?.owner) {
      loadRequests().then(loadInvoices);
    }
  }, [activeView, identity?.owner]);

  function show(value) {
    setOutput(typeof value === "string" ? value : JSON.stringify(value, null, 2));
  }

  async function request(path, options = {}) {
    const headers = { "content-type": "application/json", ...(options.headers || {}) };
    const response = await fetch(path, { ...options, headers });
    const text = await response.text();
    const json = text ? JSON.parse(text) : null;
    if (!response.ok) throw json;
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
    if (!identity?.owner) return;
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
      setIdentity((current) => current ? { ...current, autopay_url: json.autopay_url } : current);
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
          autopay_url: identity?.autopay_url || undefined,
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
    await withBusy("loadAccount", async () => {
      const json = await request("/api/account");
      setAccount(json);
      show(json);
    });
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
    setNewKeyExpiresAt("");
  }

  function openEditEndpointDialog() {
    setAutopayUrl(identity?.autopay_url || "");
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
          expires_at: datetimeLocalToIso(newKeyExpiresAt),
        }),
      });
      if (json.api_key) {
        setNewApiKey(json.api_key);
      }
      setNewKeyName("");
      setNewKeyExpiresAt("");
      const keysJson = await request("/api/api-keys");
      setApiKeys(keysJson.api_keys || []);
    } catch (error) {
      setKeyDialogError(readableError(error));
    } finally {
      setBusy("");
    }
  }

  async function revokeApiKey(keyId) {
    if (!window.confirm("Revoke this API key? Clients using it will stop working.")) return;
    await withBusy("revokeApiKey", async () => {
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
    await withBusy("loadDeposits", async () => {
      const json = await request("/api/deposits");
      setDeposits(json.deposits || []);
      show(json);
    });
  }

  async function loadRequests() {
    await withBusy("loadRequests", async () => {
      const json = await request("/api/requests");
      setRequests(json.requests || []);
      show(json);
    });
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
      show({
        message: "Open the payment link in your wallet, then this page will wait for settlement.",
        ...started,
      });
      openAuthorization(started.verification_uri_complete);
      await waitForAutopayAuthorization(
        `/api/invoices/${encodeURIComponent(invoice.id)}/pay/autopay/complete`,
        { payment_id: started.payment_id },
        started.websocket_uri_complete,
      );
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
    { href: "/console/recharge", view: "recharge", label: "Recharge" },
    { href: "/console/autopay", view: "autopay", label: "Autopay Limits" },
    { href: "/console/keys", view: "keys", label: "API Keys" },
    { href: "/console/usage", view: "usage", label: "Usage" },
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
            <h1>{activeItem.label}</h1>
          </div>
        </div>

        {activeView === "recharge" && (
          <RechargeView
            account={account}
            deposits={deposits}
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

        {activeView === "keys" && (
          <KeysView
            apiKeys={apiKeys}
            isBusy={isBusy}
            busy={busy}
            loadApiKeys={loadApiKeys}
            openCreateKeyDialog={openCreateKeyDialog}
            revokeApiKey={revokeApiKey}
            navigateConsoleView={navigateConsoleView}
            createKeyOpen={createKeyOpen}
            closeCreateKeyDialog={closeCreateKeyDialog}
            createManagedApiKey={createManagedApiKey}
            newKeyName={newKeyName}
            setNewKeyName={setNewKeyName}
            newKeyExpiresAt={newKeyExpiresAt}
            setNewKeyExpiresAt={setNewKeyExpiresAt}
            newApiKey={newApiKey}
            keyDialogError={keyDialogError}
            formatCompactNumber={formatCompactNumber}
            formatMoneyCompact={formatMoneyCompact}
          />
        )}

        {activeView === "usage" && (
          <UsageView
            requests={requests}
            lastInvoices={lastInvoices}
            isBusy={isBusy}
            busy={busy}
            loadRequests={loadRequests}
            loadInvoices={loadInvoices}
            autopayInvoice={autopayInvoice}
          />
        )}

        {activeView === "autopay" && (
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
      </main>
    </div>
  );
}

async function fetchSession() {
  return await fetchJson("/api/session");
}

async function fetchJson(path, options = {}) {
  const response = await fetch(path, options);
  const text = await response.text();
  const json = text ? JSON.parse(text) : null;
  if (!response.ok) throw json || new Error(`Request failed with HTTP ${response.status}`);
  return json;
}

function parseSocketMessage(data) {
  if (typeof data !== "string") {
    throw new Error("Unexpected WebSocket message.");
  }
  return JSON.parse(data);
}

createRoot(document.getElementById("root")).render(<App />);
