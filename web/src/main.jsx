import React, { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import QRCode from "qrcode";
import "./styles.css";

const API_KEY_STORAGE_KEY = "meteria402_console_api_key";
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
              <a className="button-link secondary" href="/v1/chat/completions">API endpoint</a>
            </div>
          </div>

          <div className="flow-panel" aria-label="Meteria402 request flow">
            <div className="flow-row">
              <span>Client</span>
              <strong>/v1/chat/completions</strong>
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
            <p>Point the OpenAI SDK at the Worker and keep your existing chat completions integration.</p>
          </div>
          <pre className="code-sample">{`const client = new OpenAI({
  apiKey: "meteria402_xxx",
  baseURL: "https://your-worker.example.com/v1",
});`}</pre>
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
                  <button disabled={busy || !autopayUrl.trim()} type="submit">
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
  const [depositAmount, setDepositAmount] = useState("5.00");
  const [apiKey, setApiKey] = useState(() => localStorage.getItem(API_KEY_STORAGE_KEY) || "");
  const [newApiKey, setNewApiKey] = useState("");
  const [newKeyName, setNewKeyName] = useState("");
  const [newKeyExpiresAt, setNewKeyExpiresAt] = useState("");
  const [createKeyOpen, setCreateKeyOpen] = useState(false);
  const [keyDialogError, setKeyDialogError] = useState("");
  const [paymentDialog, setPaymentDialog] = useState(null);
  const [paymentPayload, setPaymentPayload] = useState("");
  const [lastDepositPaymentId, setLastDepositPaymentId] = useState("");
  const [lastDepositQuoteToken, setLastDepositQuoteToken] = useState("");
  const [autopayWalletBalance, setAutopayWalletBalance] = useState(null);
  const [autopayWalletBalanceError, setAutopayWalletBalanceError] = useState("");
  const [account, setAccount] = useState(null);
  const [apiKeys, setApiKeys] = useState([]);
  const [currentApiKeyId, setCurrentApiKeyId] = useState("");
  const [lastInvoices, setLastInvoices] = useState([]);
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
    document.body.classList.toggle("sidebar-locked", sidebarOpen || createKeyOpen || Boolean(paymentDialog));
    return () => document.body.classList.remove("sidebar-locked");
  }, [sidebarOpen, createKeyOpen, paymentDialog]);

  useEffect(() => {
    setIdentity(initialIdentity);
    if (initialIdentity?.autopay_url) setAutopayUrl(initialIdentity.autopay_url);
  }, [initialIdentity?.owner, initialIdentity?.autopay_url]);

  useEffect(() => {
    if (activeView === "recharge" && identity?.owner) {
      loadAutopayWalletBalance();
    }
  }, [activeView, identity?.owner]);

  function show(value) {
    setOutput(typeof value === "string" ? value : JSON.stringify(value, null, 2));
  }

  async function request(path, options = {}) {
    const headers = { "content-type": "application/json", ...(options.headers || {}) };
    if (apiKey.trim()) headers.authorization = `Bearer ${apiKey.trim()}`;
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
    } finally {
      setBusy("");
    }
  }

  async function quoteDeposit() {
    await withBusy("quoteDeposit", async () => {
      const json = await request("/api/deposits/quote", {
        method: "POST",
        body: JSON.stringify({ amount: depositAmount.trim() }),
      });
      setLastDepositPaymentId(json.payment_id);
      setLastDepositQuoteToken(json.quote_token || "");
      show(json);
      await openDepositPayment(json.payment_id, json.quote_token || "");
    });
  }

  async function settleDeposit() {
    await withBusy("settleDeposit", async () => {
      if (!lastDepositPaymentId || !lastDepositQuoteToken) throw new Error("Create a deposit quote first.");
      const parsedPayload = paymentPayload.trim() ? JSON.parse(paymentPayload.trim()) : null;
      const json = await request("/api/deposits/settle", {
        method: "POST",
        body: JSON.stringify({
          payment_id: lastDepositPaymentId,
          quote_token: lastDepositQuoteToken,
          payment_payload: parsedPayload,
          dev_proof: "dev-paid",
          autopay_url: autopayUrl.trim() || undefined,
        }),
      });
      if (json.api_key) saveApiKey(json.api_key);
      show(json);
    });
  }

  async function openDepositPayment(paymentId = lastDepositPaymentId, quoteToken = lastDepositQuoteToken) {
    await withBusy("walletPayment", async () => {
      if (!paymentId || !quoteToken) throw new Error("Create a deposit quote first.");
      setPaymentDialog({
        status: "preparing",
        qr: "",
        url: "",
        error: "",
      });
      const started = await request(`/api/deposits/${encodeURIComponent(paymentId)}/autopay/start`, {
        method: "POST",
        body: JSON.stringify({
          quote_token: quoteToken,
          autopay_url: autopayUrl.trim(),
        }),
      });
      const qr = started.verification_uri_complete
        ? await QRCode.toDataURL(started.verification_uri_complete, {
          margin: 1,
          scale: 8,
          color: {
            dark: "#111827",
            light: "#ffffff",
          },
        })
        : "";
      setPaymentDialog({
        status: "waiting",
        qr,
        url: started.verification_uri_complete,
        error: "",
      });
      show({
        message: "Scan the QR with your wallet, then this page will wait for payment settlement.",
        ...started,
      });
      const settled = await waitForAutopayAuthorization(
        `/api/deposits/${encodeURIComponent(paymentId)}/autopay/complete`,
        { autopay_state: started.autopay_state },
        started.websocket_uri_complete,
      );
      if (settled?.settlement?.api_key) saveApiKey(settled.settlement.api_key);
      if (settled?.status === "settled") {
        setPaymentDialog((current) => current ? { ...current, status: "settled", error: "" } : current);
      }
    });
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

  async function loadAccount() {
    await withBusy("loadAccount", async () => {
      const json = await request("/api/account");
      setAccount(json);
      if (json.current_api_key_id) setCurrentApiKeyId(json.current_api_key_id);
      show(json);
    });
  }

  async function loadApiKeys() {
    await withBusy("loadApiKeys", async () => {
      const json = await request("/api/api-keys");
      setApiKeys(json.api_keys || []);
      setCurrentApiKeyId(json.current_api_key_id || "");
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
        saveApiKey(json.api_key);
        setNewApiKey(json.api_key);
      }
      setNewKeyName("");
      setNewKeyExpiresAt("");
      const keysJson = await request("/api/api-keys");
      setApiKeys(keysJson.api_keys || []);
      setCurrentApiKeyId(keysJson.current_api_key_id || "");
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

  async function waitForAutopayAuthorization(path, body, websocketUrl) {
    if (!websocketUrl) {
      return await pollAutopay(path, body);
    }

    return await new Promise((resolve, reject) => {
      const socket = new WebSocket(websocketUrl);
      let settled = false;

      socket.onerror = () => {
        if (!settled) reject(new Error("Authorization WebSocket failed."));
      };
      socket.onclose = () => {
        if (!settled) reject(new Error("Authorization WebSocket closed before authorization completed."));
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

  async function pollAutopay(path, body) {
    for (;;) {
      await new Promise((resolve) => setTimeout(resolve, 2000));
      const json = await request(path, {
        method: "POST",
        body: JSON.stringify(body),
      });
      show(json);
      if (json.status === "settled" || json.status === "settle_failed" || json.status === "denied") return json;
    }
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
    { href: "/console/keys", view: "keys", label: "API Keys" },
    { href: "/console/usage", view: "usage", label: "Usage" },
  ];

  function closeSidebar() {
    setSidebarOpen(false);
  }

  function saveApiKey(value) {
    setApiKey(value);
    localStorage.setItem(API_KEY_STORAGE_KEY, value);
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
        <a className="brand console-brand" href="/">Meteria402</a>
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
            <p>{consoleViewSubtitle(activeView)}</p>
          </div>
        </div>

        {activeView === "recharge" && (
          <>
            <section>
              <h2>Payment Wallet</h2>
              {identity?.owner ? (
                <>
                  <div className="balance-panel">
                    <span>Address</span>
                    <strong className="mono">
                      {autopayWalletBalance?.address
                        ? shortAddress(autopayWalletBalance.address)
                        : autopayWalletBalanceError
                        ? "Unavailable"
                        : "Loading..."}
                    </strong>
                    <span>Balance</span>
                    <strong>
                      {autopayWalletBalanceError
                        ? "Unavailable"
                        : autopayWalletBalance
                        ? `${autopayWalletBalance.balance} ${autopayWalletBalance.symbol}`
                        : "Loading..."}
                    </strong>
                  </div>
                  {autopayWalletBalanceError && <p className="form-error">{autopayWalletBalanceError}</p>}
                  <div className="row">
                    <button disabled={busy === "loadWalletBalance"} className="secondary" onClick={loadAutopayWalletBalance}>
                      Refresh balance
                    </button>
                  </div>
                </>
              ) : (
                <p className="muted">No payer wallet is available for this login.</p>
              )}
            </section>

	            <section>
	              <h2>Create Deposit Quote</h2>
	              <div className="grid">
	                <label>
	                  <span>Deposit amount</span>
	                  <input value={depositAmount} inputMode="decimal" onChange={(event) => setDepositAmount(event.target.value)} />
	                </label>
	                <label>
	                  <span>Autopay endpoint</span>
	                  <input value={autopayUrl} autoComplete="url" onChange={(event) => setAutopayUrl(event.target.value)} />
	                </label>
	              </div>
              <div className="row">
                <button disabled={isBusy} onClick={quoteDeposit}>Create quote</button>
                <button disabled={isBusy} className="secondary" onClick={settleDeposit}>Settle with dev proof</button>
                <button disabled={isBusy} className="secondary" onClick={() => openDepositPayment()}>Pay with wallet</button>
              </div>
              <p className="muted">Development settlement requires ALLOW_DEV_PAYMENTS=true and sends dev_proof=dev-paid.</p>
            </section>

            <section>
              <h2>Payment Payload</h2>
              <textarea
                value={paymentPayload}
                placeholder="Paste a signed x402 payment payload here for facilitator settlement."
                onChange={(event) => setPaymentPayload(event.target.value)}
              />
            </section>
          </>
        )}

        {activeView === "keys" && (
          <>
            <section>
              <h2>API Keys</h2>
              <p className="muted">Keys are generated by the Worker and shown once. The active key is stored locally for this console.</p>
              {apiKey ? (
                <>
                  <div className="key-status">
                    <span>Active key: {maskApiKey(apiKey)}</span>
                  </div>
                  <div className="row">
                    <button disabled={isBusy} onClick={loadApiKeys}>Refresh keys</button>
                    <button disabled={isBusy} className="secondary" onClick={openCreateKeyDialog}>Create key</button>
                  </div>
                </>
              ) : (
                <div className="empty-state">
                  <strong>No active key</strong>
                  <p>Create a deposit first. The Worker will generate the first API key after settlement.</p>
                  <button type="button" onClick={() => navigateConsoleView("recharge")}>Go to Recharge</button>
                </div>
              )}
            </section>

            <section>
              <h2>Keys</h2>
              {apiKeys.length ? (
                <div className="data-list">
                  {apiKeys.map((item) => (
                    <div className="data-row" key={item.id}>
                      <div>
                        <strong>{item.name || `${item.prefix}_...${item.key_suffix}`}</strong>
                        <span>
                          {item.prefix}_...{item.key_suffix} · {item.status}{item.id === currentApiKeyId ? " · current" : ""}
                          {item.expires_at ? ` · expires ${formatDateTime(item.expires_at)}` : ""}
                        </span>
                        {typeof item.calls === "number" && (
                          <div className="usage-stats">
                            <div className="stat-box">
                              <div className="num">{item.calls.toLocaleString()}</div>
                              <div className="label">Calls</div>
                            </div>
                            <div className="stat-box">
                              <div className="num">{formatCompactNumber(item.total_tokens || 0)}</div>
                              <div className="label">Tokens</div>
                            </div>
                            <div className="stat-box">
                              <div className="num">{formatMoneyCompact(item.total_cost || 0)}</div>
                              <div className="label">Cost</div>
                            </div>
                            <div className="stat-box">
                              <div className="num">{item.calls > 0 ? Math.round(((item.calls - (item.errors || 0)) / item.calls) * 100) : 0}%</div>
                              <div className="label">Success</div>
                            </div>
                          </div>
                        )}
                      </div>
                      <button
                        className="secondary danger"
                        disabled={isBusy || item.status !== "active" || item.id === currentApiKeyId}
                        onClick={() => revokeApiKey(item.id)}
                      >
                        Revoke
                      </button>
                    </div>
                  ))}
                </div>
              ) : (
                <p className="muted">{apiKey ? "Refresh the list to load keys." : "Create a deposit first to receive the initial key."}</p>
              )}
            </section>
          </>
        )}

        {createKeyOpen && (
          <div className="modal-layer" role="presentation">
            <button className="modal-scrim" type="button" aria-label="Close create key dialog" onClick={closeCreateKeyDialog} />
            <section className="modal-panel" role="dialog" aria-modal="true" aria-labelledby="create-key-title">
              <div className="modal-header">
                <div>
                  <h2 id="create-key-title">Create API Key</h2>
                  <p className="muted">The generated key is shown once.</p>
                </div>
                <button className="icon-button modal-close" type="button" aria-label="Close" onClick={closeCreateKeyDialog}>
                  <svg className="close-icon" viewBox="0 0 24 24" aria-hidden="true">
                    <path d="M7 7l10 10M17 7L7 17" />
                  </svg>
                </button>
              </div>
              <form onSubmit={createManagedApiKey}>
                <div className="grid single">
                  <label>
                    <span>Name</span>
                    <input value={newKeyName} placeholder="Auto-generated if empty" onChange={(event) => setNewKeyName(event.target.value)} />
                  </label>
                  <label>
                    <span>Expires</span>
                    <input type="datetime-local" value={newKeyExpiresAt} onChange={(event) => setNewKeyExpiresAt(event.target.value)} />
                  </label>
                </div>
                {keyDialogError && <p className="form-error">{keyDialogError}</p>}
                {newApiKey && (
                  <div className="generated-key">
                    <span>New key</span>
                    <code>{newApiKey}</code>
                  </div>
                )}
                <div className="modal-actions">
                  <button type="button" className="secondary" onClick={closeCreateKeyDialog}>Close</button>
                  <button type="submit" disabled={busy === "createApiKey" || !apiKey.trim()}>
                    {busy === "createApiKey" ? "Creating..." : "Create key"}
                  </button>
                </div>
              </form>
            </section>
          </div>
        )}

        {paymentDialog && (
          <div className="modal-layer" role="presentation">
            <button className="modal-scrim" type="button" aria-label="Close payment dialog" onClick={closePaymentDialog} />
            <section className="modal-panel payment-modal" role="dialog" aria-modal="true" aria-labelledby="payment-title">
              <div className="modal-header">
                <div>
                  <h2 id="payment-title">Pay Deposit</h2>
                  <p className="muted">Scan with your wallet app or open the link on this device.</p>
                </div>
                <button className="icon-button modal-close" type="button" aria-label="Close" onClick={closePaymentDialog}>
                  <svg className="close-icon" viewBox="0 0 24 24" aria-hidden="true">
                    <path d="M7 7l10 10M17 7L7 17" />
                  </svg>
                </button>
              </div>

              <div className="payment-qr-panel">
                {paymentDialog.qr ? (
                  <img src={paymentDialog.qr} alt="Wallet payment QR code" />
                ) : (
                  <div className="payment-qr-placeholder">Preparing QR</div>
                )}
                <div>
                  <strong>
                    {paymentDialog.status === "settled"
                      ? "Payment settled"
                      : paymentDialog.status === "failed"
                      ? "Payment failed"
                      : "Waiting for wallet signature"}
                  </strong>
                  <p className="muted">
                    {paymentDialog.status === "settled"
                      ? "Your API key has been stored locally."
                      : "After approval, this page will settle the payment and store the generated API key."}
                  </p>
                  {paymentDialog.error && <p className="form-error">{paymentDialog.error}</p>}
                  <div className="row">
                    {paymentDialog.url && (
                      <a className="button-link secondary" href={paymentDialog.url} target="_blank" rel="noreferrer">
                        Open link
                      </a>
                    )}
                    {(paymentDialog.status === "settled" || paymentDialog.status === "failed") && (
                      <button type="button" onClick={closePaymentDialog}>Close</button>
                    )}
                  </div>
                </div>
              </div>
            </section>
          </div>
        )}

        {activeView === "usage" && (
          <>
            <section>
              <h2>Account</h2>
              {apiKey ? (
                <>
                  <div className="key-status">
                    <span>Active key: {maskApiKey(apiKey)}</span>
                  </div>
                  <div className="row">
                    <button disabled={isBusy} onClick={loadAccount}>Load account</button>
                    <button disabled={isBusy} className="secondary" onClick={loadRequests}>Load calls</button>
                    <button disabled={isBusy} className="secondary" onClick={loadInvoices}>Load invoices</button>
                    <button disabled={isBusy} className="secondary" onClick={autopayInvoice}>Pay invoice</button>
                  </div>
                </>
              ) : (
                <div className="empty-state">
                  <strong>No active key</strong>
                  <p>Create a deposit first. Usage records are tied to the generated API key.</p>
                  <button type="button" onClick={() => navigateConsoleView("recharge")}>Go to Recharge</button>
                </div>
              )}
              {account && (
                <dl className="summary-grid">
                  <dt>Balance</dt><dd>{account.deposit_balance}</dd>
                  <dt>Unpaid</dt><dd>{account.unpaid_invoice_total}</dd>
                  <dt>Status</dt><dd>{account.status}</dd>
                </dl>
              )}
            </section>

            <section>
              <h2>Model Calls</h2>
              {requests.length ? (
                <div className="data-list">
                  {requests.map((item) => (
                    <div className="data-row" key={item.id}>
                      <div>
                        <strong>{item.model || "Unknown model"}</strong>
                        <span>{item.status} · {item.total_tokens ?? 0} tokens · {item.final_cost || "0.000000"}</span>
                      </div>
                      <span className="mono">{shortId(item.id)}</span>
                    </div>
                  ))}
                </div>
              ) : (
                <p className="muted">Load calls to see recent metered gateway requests.</p>
              )}
            </section>

            <section>
              <h2>Invoices</h2>
              {lastInvoices.length ? (
                <div className="data-list">
                  {lastInvoices.map((item) => (
                    <div className="data-row" key={item.id}>
                      <div>
                        <strong>{item.amount_due} {item.currency}</strong>
                        <span>{item.status} · {shortId(item.id)}</span>
                      </div>
                    </div>
                  ))}
                </div>
              ) : (
                <p className="muted">Load invoices to see unpaid usage charges.</p>
              )}
            </section>
          </>
        )}

        {activeView !== "keys" && (
          <section>
            <h2>Output</h2>
            <pre className="output">{busy ? `Working: ${busy}\n\n${output}` : output}</pre>
          </section>
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

function readableError(error) {
  if (error instanceof Error && error.message) return error.message;
  if (error?.error?.message) return error.error.message;
  if (error?.message) return error.message;
  if (typeof error === "string") return error;
  try {
    const json = JSON.stringify(error, null, 2);
    return json && json !== "{}" ? json : "Request failed.";
  } catch {
    return "Request failed.";
  }
}

function readStoredAutopayEndpoint() {
  try {
    return localStorage.getItem(AUTOPAY_ENDPOINT_STORAGE_KEY) || "";
  } catch {
    return "";
  }
}

function writeStoredAutopayEndpoint(value) {
  try {
    localStorage.setItem(AUTOPAY_ENDPOINT_STORAGE_KEY, value);
  } catch {
    // Login still works if the browser blocks localStorage.
  }
}

function buildCoinbaseWalletLink(url) {
  return `https://go.cb-w.com/dapp?cb_url=${encodeURIComponent(url)}`;
}

function buildOkxWalletLink(url) {
  const deepLink = `okx://wallet/dapp/url?dappUrl=${encodeURIComponent(url)}`;
  return `https://web3.okx.com/download?deeplink=${encodeURIComponent(deepLink)}`;
}

function getConsoleView(pathname) {
  if (pathname === "/console/keys") return "keys";
  if (pathname === "/console/usage") return "usage";
  return "recharge";
}

function consoleViewSubtitle(view) {
  if (view === "keys") return "Create and revoke keys used by clients calling the metered AI gateway.";
  if (view === "usage") return "Inspect account balance, model call records, and payable invoices.";
  return "Create a refundable deposit and receive an API key for metered model calls.";
}

function shortAddress(value) {
  if (!value || value.length <= 14) return value || "";
  return `${value.slice(0, 6)}...${value.slice(-4)}`;
}

function shortId(value) {
  if (!value || value.length <= 16) return value || "";
  return `${value.slice(0, 8)}...${value.slice(-4)}`;
}

function maskApiKey(value) {
  if (!value) return "";
  if (value.length <= 18) return value;
  return `${value.slice(0, 10)}...${value.slice(-4)}`;
}

function datetimeLocalToIso(value) {
  if (!value) return undefined;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : undefined;
}

function formatDateTime(value) {
  try {
    return new Intl.DateTimeFormat(undefined, {
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    }).format(new Date(value));
  } catch {
    return value;
  }
}

function formatCompactNumber(value) {
  const n = Number(value);
  if (Number.isNaN(n)) return "0";
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

function formatMoneyCompact(microUsd) {
  const usd = Number(microUsd) / 1_000_000;
  if (usd >= 1) return `$${usd.toFixed(2)}`;
  if (usd >= 0.01) return `$${usd.toFixed(3)}`;
  return `$${usd.toFixed(6)}`;
}

createRoot(document.getElementById("root")).render(<App />);
