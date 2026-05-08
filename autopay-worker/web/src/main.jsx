import React, { useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import "./styles.css";

const requestId = new URLSearchParams(window.location.search).get("request_id") || "";

function App() {
  const [authRequest, setAuthRequest] = useState(null);
  const [allowedOwners, setAllowedOwners] = useState([]);
  const [ownerAddress, setOwnerAddress] = useState("");
  const [activeProvider, setActiveProvider] = useState(null);
  const [walletStatus, setWalletStatus] = useState("");
  const [result, setResult] = useState("");
  const [approvedAt, setApprovedAt] = useState("");
  const [busy, setBusy] = useState(false);

  // Session + dashboard state
  const [session, setSession] = useState(null); // { owner } or null
  const [checkingSession, setCheckingSession] = useState(true);
  const [activeTab, setActiveTab] = useState("authorizations");
  const [auditAuth, setAuditAuth] = useState([]);
  const [auditPay, setAuditPay] = useState([]);
  const [auditBusy, setAuditBusy] = useState(false);
  const [autopayWalletAddress, setAutopayWalletAddress] = useState("");

  const [hasWallet, setHasWallet] = useState(false);

  const [authLoading, setAuthLoading] = useState(false);
  const [authError, setAuthError] = useState(false);

  const ownerAllowed = useMemo(() => {
    if (!ownerAddress || allowedOwners.length === 0) return true;
    const owner = ownerAddress.toLowerCase();
    return allowedOwners.map((item) => item.toLowerCase()).includes(owner);
  }, [allowedOwners, ownerAddress]);

  useEffect(() => {
    init().catch(showError);

    async function init() {
      // Wait for wallet provider injection (some mobile wallets inject with delay)
      let attempts = 0;
      while (!window.ethereum && attempts < 20) {
        await new Promise((r) => setTimeout(r, 150));
        attempts++;
      }
      setHasWallet(Boolean(window.ethereum));
      if (requestId) {
        setAuthLoading(true);
        setAuthError(false);
        try {
          const [details, capabilities] = await Promise.all([
            fetchJson(`/api/auth/requests/${encodeURIComponent(requestId)}`),
            fetchJson("/api/capabilities"),
          ]);
          setAuthRequest(details);
          if (details.status === "approved" || details.status === "denied") {
            setResult(details.status);
          }
          setAllowedOwners(capabilities.allowed_owner_addresses || []);
          setWalletStatus("Connect an owner wallet to continue.");
          autoConnectWallet();
        } catch {
          setAuthError(true);
        } finally {
          setAuthLoading(false);
        }
      } else {
        // Dashboard mode: check session, then maybe auto-connect wallet
        await checkSession();
        if (window.ethereum) {
          await autoConnectWallet();
        }
      }
    }
  }, []);

  useEffect(() => {
    if (!authRequest) return;
    if (!ownerAddress) {
      setWalletStatus("Connect an owner wallet to continue.");
      return;
    }
    setWalletStatus(ownerAllowed
      ? "Connected wallet is allowed to sign."
      : "Connected wallet is not allowed to authorize this worker.");
  }, [authRequest, ownerAddress, ownerAllowed]);

  // Auto-load audit when session exists and on dashboard
  useEffect(() => {
    if (!session || requestId) return;
    loadAudit();
  }, [session, activeTab]);

  useEffect(() => {
    if (!session || requestId) return;
    loadDashboardCapabilities(session.owner).catch((err) => {
      setAutopayWalletAddress("");
      setWalletStatus(readableErrorMessage(err));
    });
  }, [session]);

  async function checkSession() {
    setCheckingSession(true);
    try {
      const me = await fetchJson("/api/auth/me");
      if (me.authenticated && me.owner) {
        setSession({ owner: me.owner });
      } else {
        setSession(null);
      }
    } catch {
      setSession(null);
    } finally {
      setCheckingSession(false);
    }
  }

  async function loadAudit() {
    if (!session) return;
    setAuditBusy(true);
    try {
      if (activeTab === "authorizations") {
        const data = await fetchJson("/api/audit/authorizations");
        setAuditAuth(data.authorizations || []);
      } else {
        const data = await fetchJson("/api/audit/payments");
        setAuditPay(data.payments || []);
      }
    } catch (err) {
      setWalletStatus(readableErrorMessage(err));
    } finally {
      setAuditBusy(false);
    }
  }

  async function loadDashboardCapabilities(owner) {
    const data = await fetchJson(`/api/capabilities?owner=${encodeURIComponent(owner)}`);
    setAutopayWalletAddress(data.payer_address || "");
  }

  async function handleLogin() {
    if (!ownerAddress) {
      setWalletStatus("Connect a wallet first.");
      return;
    }
    setBusy(true);
    try {
      const challenge = await fetchJson("/api/auth/challenge");
      const message = challenge.message.replace(
        "0x0000000000000000000000000000000000000000",
        ownerAddress
      );
      const provider = activeProvider || window.ethereum;
      if (!provider) throw new Error("No injected wallet.");
      const signature = await personalSign(provider, message, ownerAddress);
      await fetchJson("/api/auth/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ message, signature }),
      });
      await checkSession();
      setWalletStatus("Signed in.");
    } catch (err) {
      showError(err);
    } finally {
      setBusy(false);
    }
  }

  async function handleLogout() {
    setBusy(true);
    try {
      await fetchJson("/api/auth/logout", { method: "POST" });
      setSession(null);
      setAuditAuth([]);
      setAuditPay([]);
      setAutopayWalletAddress("");
      setWalletStatus("Signed out.");
    } catch (err) {
      showError(err);
    } finally {
      setBusy(false);
    }
  }

  async function loadWalletAuth() {
    return await import("./walletAuth.js");
  }

  async function autoConnectWallet() {
    if (!window.ethereum) return;
    try {
      await connectWallet();
    } catch (error) {
      console.info("Automatic wallet connection did not complete.", error);
    }
  }

  async function connectWallet() {
    const provider = window.ethereum;
    if (!provider) {
      throw new Error("No injected wallet was found. Open this page in a wallet browser.");
    }
    setBusy(true);
    try {
      setActiveProvider(provider);
      const accounts = await provider.request({ method: "eth_requestAccounts" });
      const { checksumAddress } = await loadWalletAuth();
      setOwnerAddress(accounts[0] ? checksumAddress(accounts[0]) : "");
    } finally {
      setBusy(false);
    }
  }

  async function approveAuthorization() {
    if (!authRequest) throw new Error("Authorization request was not loaded.");
    if (!ownerAddress) throw new Error("Connect a wallet first.");
    setBusy(true);
    setWalletStatus("Submitting authorization...");
    try {
      const provider = activeProvider || window.ethereum;
      if (!provider) throw new Error("No injected wallet was found.");

      const { buildSiweMessage, checksumAddress } = await loadWalletAuth();
      const checksumOwnerAddress = checksumAddress(ownerAddress);
      const siweMessage = buildSiweMessage({
        authRequest,
        requestId,
        ownerAddress: checksumOwnerAddress,
        origin: window.location.origin,
        host: window.location.host,
      });

      const signature = await personalSign(provider, siweMessage, checksumOwnerAddress);
      const approved = await fetchJson(`/api/auth/requests/${encodeURIComponent(requestId)}/approve`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          siwe_message: siweMessage,
          siwe_signature: signature,
        }),
      });

      const approvedStatus = approved.status === "approved" ? "approved" : approved.status || "approved";
      setResult(approvedStatus);
      if (approvedStatus === "approved") setApprovedAt(new Date().toISOString());
      setWalletStatus(isLogin ? "Login approved. Return to Meteria402." : "Authorization approved. Return to the requester page.");
    } finally {
      setBusy(false);
    }
  }

  async function denyAuthorization() {
    if (!requestId) return;
    setBusy(true);
    try {
      const denied = await fetchJson(`/api/auth/requests/${encodeURIComponent(requestId)}/deny`, { method: "POST" });
      setResult(denied.status === "denied" ? "denied" : denied.status || "denied");
      setWalletStatus("Authorization denied.");
    } finally {
      setBusy(false);
    }
  }

  function showError(error) {
    setWalletStatus(readableErrorMessage(error));
    setResult(isUserRejectedRequest(error) ? "" : "error");
    setBusy(false);
  }

  const policy = authRequest?.policy;
  const isLogin = authRequest?.kind === "login";
  const loginApproved = isLogin && result === "approved";
  const authPage = Boolean(requestId);
  const policyAsset = policy ? assetLabel(policy.asset, policy.network) : "";

  // Dashboard rendering helpers
  const renderDashboard = () => {
    if (checkingSession) {
      return (
        <>
          <header>
            <h1>Autopay Dashboard</h1>
            <p>Manage your Meteria402 autopay authorizations and payments.</p>
          </header>
          <div className="content">
            <div className="status">Checking session...</div>
          </div>
        </>
      );
    }

    if (!session) {
      const isMobile = /iPhone|iPad|iPod|Android/i.test(navigator.userAgent);
      return (
        <>
          <header>
            <h1>Autopay Dashboard</h1>
            <p>Sign in to view your authorizations and payments.</p>
          </header>
          <div className="content">
            <div className="login-center">
              {!hasWallet && (
                <>
                  <div className="login-icon">
                    <svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                      <rect x="2" y="5" width="20" height="14" rx="2" stroke="currentColor" strokeWidth="1.5"/>
                      <path d="M2 10h20" stroke="currentColor" strokeWidth="1.5"/>
                      <circle cx="7" cy="12" r="1" fill="currentColor"/>
                    </svg>
                  </div>
                  <h2>Sign in to continue</h2>
                  <p className="login-subtitle">Connect your wallet to access your dashboard.</p>

                  {isMobile && (
                    <>
                      <div className="divider">
                        <span>Choose a wallet</span>
                      </div>
                      <div className="wallet-list">
                        <a className="wallet-card" href={`https://go.cb-w.com/m/x/dapp?url=${encodeURIComponent(window.location.href)}`}>
                          <img src="/wallet-icons/coinbase-wallet.svg" alt="Coinbase Wallet" />
                          <span className="wallet-name">Coinbase Wallet</span>
                          <svg className="wallet-arrow" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                            <path d="M9 6l6 6-6 6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
                          </svg>
                        </a>
                        <a className="wallet-card" href={`okx://wallet/dapp/url?dappUrl=${encodeURIComponent(window.location.href)}`}>
                          <img src="/wallet-icons/okx-wallet.svg" alt="OKX Wallet" />
                          <span className="wallet-name">OKX Wallet</span>
                          <svg className="wallet-arrow" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                            <path d="M9 6l6 6-6 6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
                          </svg>
                        </a>
                      </div>
                      <div className="security-footer">
                        <svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                          <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" stroke="#22c55e" strokeWidth="1.5" fill="#f0fdf4"/>
                          <path d="M9 12l2 2 4-4" stroke="#22c55e" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
                        </svg>
                        <div>
                          <p className="security-title">Your wallet connection is secure</p>
                          <p className="security-desc">We never store your private keys.</p>
                        </div>
                      </div>
                    </>
                  )}

                  {!isMobile && (
                    <p className="guide-text" style={{ marginTop: "12px" }}>
                      Please install a wallet browser extension such as{" "}
                      <a href="https://metamask.io" target="_blank" rel="noopener noreferrer">MetaMask</a>
                      {" "}and refresh this page.
                    </p>
                  )}
                </>
              )}

              {hasWallet && (
                <>
                  <div className="login-icon">
                    <svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                      <rect x="2" y="5" width="20" height="14" rx="2" stroke="currentColor" strokeWidth="1.5"/>
                      <path d="M2 10h20" stroke="currentColor" strokeWidth="1.5"/>
                      <circle cx="7" cy="12" r="1" fill="currentColor"/>
                    </svg>
                  </div>
                  <h2>Sign in to continue</h2>
                  <p className="login-subtitle">Connect your wallet to access your dashboard.</p>
                  <div className="wallet-row" style={{ marginTop: "20px" }}>
                    {ownerAddress ? (
                      <>
                        <strong>{shortAddress(ownerAddress)}</strong>
                        <span className="badge">Not signed in</span>
                      </>
                    ) : (
                      <span style={{ color: "#6b7280" }}>Wallet connected, requesting accounts...</span>
                    )}
                  </div>
                  <div style={{ marginTop: "16px" }}>
                    {ownerAddress && (
                      <button disabled={busy} onClick={() => handleLogin()}>
                        Sign In
                      </button>
                    )}
                  </div>
                </>
              )}
            </div>
          </div>
        </>
      );
    }

    return (
      <>
        <div className="dashboard-topbar">
          <div className="dashboard-topbar-inner">
            <h1>Autopay</h1>
            <div className="dashboard-account">
              <span className="dashboard-address">{shortAddress(session.owner)}</span>
              <button className="icon-button" type="button" aria-label="Sign out" disabled={busy} onClick={() => handleLogout()}>
                <svg viewBox="0 0 24 24" aria-hidden="true">
                  <path d="M10 6H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h4" />
                  <path d="M14 8l4 4-4 4" />
                  <path d="M18 12H9" />
                </svg>
              </button>
            </div>
          </div>
        </div>

        <div className="content">
          <section className="dashboard-card autopay-wallet-card">
            <div className="section-heading">
              <h2>Autopay wallet</h2>
              <span>Managed payer</span>
            </div>
            <strong className="wallet-address-large">{autopayWalletAddress ? shortAddress(autopayWalletAddress) : "Not configured"}</strong>
            {autopayWalletAddress && <p className="wallet-address-full">{autopayWalletAddress}</p>}
          </section>

          <section className="dashboard-card">
            <div className="tabs">
              <button className={activeTab === "authorizations" ? "active" : ""} onClick={() => setActiveTab("authorizations")}>Authorizations</button>
              <button className={activeTab === "payments" ? "active" : ""} onClick={() => setActiveTab("payments")}>Payments</button>
            </div>

            {auditBusy && <div className="status">Loading...</div>}

            {activeTab === "authorizations" && (
              <div className="audit-list">
                {auditAuth.length === 0 && <div className="empty-cell">No authorizations yet.</div>}
                {auditAuth.map((row) => (
                  <article className="audit-item" key={row.id}>
                    <div className="audit-main">
                      <div>
                        <span className="audit-label">Max amount</span>
                        <strong className="audit-amount">{formatAuthorizationAmount(row)}</strong>
                      </div>
                      <span className={`status-badge ${statusClassName(row.status)}`}>{row.status}</span>
                    </div>
                    <div className="audit-meta">
                      <span>Origin {originHost(row.requester_origin) || "-"}</span>
                      <span>Created {formatTimestamp(row.created_at)}</span>
                      <span>Valid until {formatTimestamp(row.policy_valid_before)}</span>
                    </div>
                  </article>
                ))}
              </div>
            )}

            {activeTab === "payments" && (
              <div className="audit-list">
                {auditPay.length === 0 && <div className="empty-cell">No payments yet.</div>}
                {auditPay.map((row) => (
                  <article className="audit-item" key={row.id}>
                    <div className="audit-main">
                      <div>
                        <strong className="audit-amount">{formatPaymentAmount(row)}</strong>
                      </div>
                      <span className={`status-badge ${statusClassName(row.status)}`}>{row.status}</span>
                    </div>
                    <div className="audit-meta">
                      <span>{originHost(row.requester_origin) || "-"}</span>
                      <span>{formatTimestamp(row.created_at)}</span>
                    </div>
                  </article>
                ))}
              </div>
            )}
          </section>
        </div>
      </>
    );
  };

  function returnToRequester() {
    if (authRequest?.return_origin) {
      window.location.assign(authRequest.return_origin);
    }
  }

  if (authPage && authLoading) {
    return (
      <main className="auth-page">
        <div className="auth-loading">
          <div className="spinner" />
          <p>Loading request...</p>
        </div>
      </main>
    );
  }

  if (authPage && authError) {
    return (
      <main className="auth-page">
        <div className="auth-error">
          <div className="error-icon" aria-hidden="true">
            <svg viewBox="0 0 24 24">
              <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="2" fill="none" />
              <path d="M15 9l-6 6M9 9l6 6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
            </svg>
          </div>
          <p>请求不存在或已过期</p>
          <div className="actions">
            <button onClick={() => window.close()}>关闭页面</button>
            <button onClick={() => window.location.href = "/"}>返回主页</button>
          </div>
        </div>
      </main>
    );
  }

  return (
    <main className={authPage ? "auth-page" : "dashboard-page"}>
      {!authPage ? renderDashboard() : (
        <>
          <header className={authPage ? "auth-topbar" : ""}>
            {authPage && !loginApproved && (
              <button className="auth-nav-button" type="button" aria-label="Go back" onClick={() => window.history.back()}>
                <svg viewBox="0 0 24 24" aria-hidden="true">
                  <path d="M15 6l-6 6 6 6" />
                </svg>
              </button>
            )}
            <div>
              <h1>{loginApproved ? "Login Approved" : isLogin ? "Confirm Login" : "Autopay Authorization"}</h1>
              <p>{loginApproved ? "You can return to Meteria402." : isLogin ? "Use your wallet" : "Review the spending limit before signing."}</p>
            </div>
            {authPage && !loginApproved && (
              <span className="auth-shield" aria-hidden="true">
                <svg viewBox="0 0 24 24">
                  <path d="M12 21s7-3.5 7-9V5l-7-3-7 3v7c0 5.5 7 9 7 9z" />
                  <path d="M9 12l2 2 4-4" />
                </svg>
              </span>
            )}
          </header>

          <div className="content">
            {loginApproved ? (
              <section className="success-panel">
                <div className="success-icon" aria-hidden="true">
                  <svg viewBox="0 0 24 24">
                    <path d="M7 12.5l3.2 3.2L17.5 8" />
                  </svg>
                </div>
                <p>You can return to Meteria402.</p>
                <div className="detail-list success-list">
                  <div className="detail-row">
                    <span className="detail-icon" aria-hidden="true">
                      <svg viewBox="0 0 24 24">
                        <circle cx="12" cy="8" r="3.5" />
                        <path d="M5.5 19a6.5 6.5 0 0 1 13 0" />
                      </svg>
                    </span>
                    <span className="detail-label">Wallet</span>
                    <strong>{ownerAddress ? shortAddress(ownerAddress) : "Connected"}</strong>
                    {ownerAddress && (
                      <button className="detail-copy" type="button" aria-label="Copy wallet address" onClick={() => navigator.clipboard?.writeText(ownerAddress)}>
                        <svg viewBox="0 0 24 24" aria-hidden="true">
                          <rect x="9" y="9" width="10" height="10" rx="2" />
                          <path d="M5 15V7a2 2 0 0 1 2-2h8" />
                        </svg>
                      </button>
                    )}
                  </div>
                  <div className="detail-row">
                    <span className="detail-icon" aria-hidden="true">
                      <svg viewBox="0 0 24 24">
                        <circle cx="12" cy="12" r="9" />
                        <path d="M3 12h18M12 3c2.5 2.7 3.8 5.7 3.8 9s-1.3 6.3-3.8 9M12 3c-2.5 2.7-3.8 5.7-3.8 9s1.3 6.3 3.8 9" />
                      </svg>
                    </span>
                    <span className="detail-label">Network</span>
                    <strong>{networkLabel(authRequest.network)}</strong>
                  </div>
                  <div className="detail-row">
                    <span className="detail-icon" aria-hidden="true">
                      <svg viewBox="0 0 24 24">
                        <circle cx="12" cy="12" r="9" />
                        <path d="M12 7v5l3 2" />
                      </svg>
                    </span>
                    <span className="detail-label">Timestamp</span>
                    <strong>{formatTimestamp(approvedAt)}</strong>
                  </div>
                </div>
              </section>
            ) : policy ? (
              <section className="authorization-summary">
                <div className="requester-card">
                  <div className="requester-mark" aria-hidden="true">
                    {requesterInitial(policy.requester)}
                  </div>
                  <div className="requester-copy">
                    <h2>{policy.requester?.name || originHost(policy.requester?.origin) || "Requester"}</h2>
                    <p>{policy.requester?.origin || "Requester origin unavailable"}</p>
                    {policy.requester?.account && (
                      <span className="requester-wallet">{policy.requester.account}</span>
                    )}
                  </div>
                </div>
                <p className="transparency-note">Requester identity is shown for transparency.</p>
              </section>
            ) : (
              <section className="empty">
                <h2>Payment Authorization</h2>
                <p>Use this page to approve scoped x402 payment requests with your owner wallet. Start from a payment QR code or authorization link.</p>
              </section>
            )}

            {!loginApproved && policy && (
              <section className="spending-panel">
                <div className="budget-header">
                  <span>Budget</span>
                  <strong>{formatPolicyAmount(policy.totalBudget, policy)}</strong>
                </div>
                <div className="risk-list">
                  <div className="risk-row">
                    <span>Per payment</span>
                    <strong>{formatPolicyAmount(policy.maxSingleAmount, policy)}</strong>
                  </div>
                  <div className="risk-row">
                    <span>Valid until</span>
                    <strong>{formatTimestamp(policy.validBefore)}</strong>
                  </div>
                  <div className="risk-row">
                    <span>Network</span>
                    <strong>{networkLabel(policy.network)}</strong>
                  </div>
                </div>
              </section>
            )}

            {!loginApproved && policy && (
              <section className="scope-panel">
                <h2>Payment Scope</h2>
                <div className="scope-list">
                  <div className="scope-row">
                    <span>Can pay for</span>
                    <strong>{formatList(policy.allowedOrigins, originHost)}</strong>
                  </div>
                  <div className="scope-row">
                    <span>Pays to</span>
                    <strong>{formatList(policy.allowedPayTo, shortAddress)}</strong>
                  </div>
                  <div className="scope-row">
                    <span>Asset</span>
                    <strong>{policyAsset}</strong>
                  </div>
                </div>
                <details className="binding-details">
                  <summary>
                    <span>{authRequest.payment_requirement_hash ? "Bound to this payment request" : "Not bound to a specific payment request"}</span>
                    <strong>{authRequest.payment_requirement_hash ? shortHash(authRequest.payment_requirement_hash) : "No hash"}</strong>
                  </summary>
                  {authRequest.payment_requirement_hash && <p>{authRequest.payment_requirement_hash}</p>}
                </details>
                <div className="wallet-state">
                  <span>Owner wallet</span>
                  <strong>{ownerAddress ? shortAddress(ownerAddress) : "Not connected"}</strong>
                </div>
                <div className="status">{walletStatus}</div>
              </section>
            )}

            {!loginApproved && authRequest && !policy && (
              <section className={isLogin ? "confirm-card login-confirm-panel" : "confirm-card"}>
                <div className="app-identity">
                  <span className="app-mark">M</span>
                  <div>
                    <h2>Meteria402</h2>
                    <p>{isLogin ? "Wallet login request" : "Authorization request"}</p>
                  </div>
                </div>
                {isLogin ? (
                  <>
                    <div className="detail-list">
                      <div className="detail-row">
                        <span className="detail-icon" aria-hidden="true">
                          <svg viewBox="0 0 24 24">
                            <circle cx="12" cy="8" r="3.5" />
                            <path d="M5.5 19a6.5 6.5 0 0 1 13 0" />
                          </svg>
                        </span>
                        <span className="detail-label">Wallet</span>
                        <strong>{ownerAddress ? shortAddress(ownerAddress) : "Not connected"}</strong>
                        {ownerAddress && (
                          <button className="detail-copy" type="button" aria-label="Copy wallet address" onClick={() => navigator.clipboard?.writeText(ownerAddress)}>
                            <svg viewBox="0 0 24 24" aria-hidden="true">
                              <rect x="9" y="9" width="10" height="10" rx="2" />
                              <path d="M5 15V7a2 2 0 0 1 2-2h8" />
                            </svg>
                          </button>
                        )}
                      </div>
                      <div className="detail-row">
                        <span className="detail-icon" aria-hidden="true">
                          <svg viewBox="0 0 24 24">
                            <circle cx="12" cy="12" r="9" />
                            <path d="M3 12h18M12 3c2.5 2.7 3.8 5.7 3.8 9s-1.3 6.3-3.8 9M12 3c-2.5 2.7-3.8 5.7-3.8 9s1.3 6.3 3.8 9" />
                          </svg>
                        </span>
                        <span className="detail-label">Network</span>
                        <strong>{networkLabel(authRequest.network)}</strong>
                      </div>
                      <div className="detail-row">
                        <span className="detail-icon" aria-hidden="true">
                          <svg viewBox="0 0 24 24">
                            <circle cx="12" cy="12" r="9" />
                            <path d="M12 7v5l3 2" />
                          </svg>
                        </span>
                        <span className="detail-label">Timestamp</span>
                        <strong>{formatTimestamp(authRequest.expires_at)}</strong>
                      </div>
                    </div>
                    <div className="status confirm-status">{walletStatus}</div>
                    <p className="security-note">Only sign requests you trust.</p>
                  </>
                ) : (
                  <dl>
                    <dt>Status</dt><dd>{authRequest.status}</dd>
                    <dt>Expires</dt><dd>{authRequest.expires_at}</dd>
                    <dt>Network</dt><dd>{authRequest.network || "eip155:8453"}</dd>
                  </dl>
                )}
              </section>
            )}

            {!loginApproved && authRequest && !isLogin && !policy && (
              <section>
                <h2>Wallet</h2>
                <dl>
                  <dt>Owner wallet</dt><dd>{ownerAddress || "Not connected"}</dd>
                  <dt>Allowed owners</dt><dd>{allowedOwners.length ? allowedOwners.join(", ") : "Any valid SIWE signer"}</dd>
                </dl>
                <div className="status">{walletStatus}</div>
              </section>
            )}
          </div>

          {loginApproved ? (
            <div className="actions">
              <button className="secondary" onClick={() => window.close()}>Close</button>
              <button disabled={!authRequest?.return_origin} onClick={returnToRequester}>Return</button>
            </div>
          ) : authRequest && (
            <div className="actions">
              {result === "approved" ? (
                <div className="signed-action" role="status" aria-live="polite">
                  <span className="signed-check" aria-hidden="true">
                    <svg viewBox="0 0 24 24">
                      <path d="M5 12.5l4.5 4.5L19 7" />
                    </svg>
                  </span>
                  <span>Signed</span>
                </div>
              ) : (
                <>
                  <button className="danger" disabled={busy || Boolean(result)} onClick={() => denyAuthorization().catch(showError)}>Deny</button>
                  {!ownerAddress && <button disabled={busy} onClick={() => connectWallet().catch(showError)}>Connect</button>}
                  {ownerAddress && <button disabled={!Boolean(authRequest && ownerAddress && ownerAllowed && !busy && !result)} onClick={() => approveAuthorization().catch(showError)}>{isLogin ? "Sign in" : "Sign"}</button>}
                </>
              )}
            </div>
          )}
        </>
      )}
    </main>
  );
}

async function personalSign(provider, message, address) {
  try {
    return await provider.request({ method: "personal_sign", params: [message, address] });
  } catch (error) {
    if (isUserRejectedRequest(error)) throw error;
    try {
      return await provider.request({ method: "personal_sign", params: [address, message] });
    } catch (fallbackError) {
      throw normalizeThrownError(fallbackError);
    }
  }
}

async function fetchJson(url, init) {
  const response = await fetch(url, { ...init, credentials: "include" });
  const json = await response.json().catch(() => null);
  if (!response.ok) {
    const message = readableErrorMessage(json?.error) || `Request failed with HTTP ${response.status}.`;
    throw new Error(message);
  }
  return json;
}

function normalizeThrownError(error) {
  if (error instanceof Error) return error;
  return new Error(readableErrorMessage(error));
}

function readableErrorMessage(error) {
  if (!error) return "Request failed.";
  if (typeof error === "string") return error;
  if (error instanceof Error) return error.message || "Request failed.";
  if (typeof error === "object") {
    const value = error;
    const nestedMessage = readableString(value.message)
      || readableString(value.shortMessage)
      || readableString(value.reason)
      || readableString(value.details)
      || readableString(value.error?.message)
      || readableString(value.data?.message);
    if (nestedMessage) return nestedMessage;
    try {
      return JSON.stringify(error);
    } catch {
      return "Request failed.";
    }
  }
  return String(error);
}

function readableString(value) {
  return typeof value === "string" && value.trim() ? value : "";
}

function isUserRejectedRequest(error) {
  if (!error || typeof error !== "object") return false;
  const code = error.code ?? error.error?.code ?? error.data?.code;
  if (code === 4001 || code === "4001" || code === "ACTION_REJECTED") return true;
  const message = readableErrorMessage(error).toLowerCase();
  return message.includes("user rejected")
    || message.includes("user denied")
    || message.includes("rejected by user")
    || message.includes("request rejected")
    || message.includes("cancelled")
    || message.includes("canceled");
}

function shortAddress(value) {
  if (!value || value.length < 12) return value || "";
  return `${value.slice(0, 5)}...${value.slice(-4)}`;
}

function shortCaipAccount(value) {
  if (!value) return "";
  const parts = String(value).split(":");
  const address = parts[parts.length - 1] || "";
  if (!address) return value;
  return `${parts.slice(0, -1).join(":")}:${shortAddress(address)}`;
}

function shortHash(value) {
  if (!value || value.length < 16) return value || "";
  return `${value.slice(0, 6)}...${value.slice(-4)}`;
}

function networkLabel(value) {
  if (!value || value === "eip155:8453") return "Base";
  if (value === "eip155:84532") return "Base Sepolia";
  return value;
}

function assetLabel(asset, network) {
  const normalized = String(asset || "").toLowerCase();
  if (
    (network === "eip155:8453" && normalized === "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913") ||
    (network === "eip155:84532" && normalized === "0x036cbd53842c5426634e7929541ec2318f3dcf7e")
  ) {
    return "USDC";
  }
  return shortAddress(asset);
}

function tokenDecimals(asset, network) {
  return assetLabel(asset, network) === "USDC" ? 6 : 18;
}

function formatPolicyAmount(raw, policy) {
  const symbol = assetLabel(policy.asset, policy.network);
  const formatted = formatTokenAmount(raw, tokenDecimals(policy.asset, policy.network));
  return `${formatted} ${symbol}`;
}

function formatAuthorizationAmount(row) {
  if (!row.policy_max_single_amount) return "-";
  const policy = {
    asset: row.policy_asset,
    network: row.policy_network,
  };
  return formatPolicyAmount(row.policy_max_single_amount, policy);
}

function formatPaymentAmount(row) {
  const symbol = row.currency || assetLabel(row.asset, row.network);
  if (!row.amount_decimal && !row.amount) return "-";
  const amount = row.amount_decimal
    ? trimDecimalZeros(row.amount_decimal)
    : formatTokenAmount(row.amount, tokenDecimals(row.asset, row.network));
  return symbol ? `${amount} ${symbol}` : amount;
}

function statusClassName(value) {
  return String(value || "").toLowerCase();
}

function trimDecimalZeros(value) {
  const text = String(value || "");
  if (!text.includes(".")) return text;
  const trimmed = text.replace(/(\.\d*?[1-9])0+$/, "$1").replace(/\.0+$/, "");
  return trimmed || "0";
}

function formatTokenAmount(raw, decimals) {
  try {
    const amount = BigInt(raw);
    const scale = 10n ** BigInt(decimals);
    const whole = amount / scale;
    const fraction = amount % scale;
    if (fraction === 0n) return `${whole}.00`;
    const fractionText = fraction.toString().padStart(decimals, "0").replace(/0+$/, "");
    const padded = fractionText.length === 1 ? `${fractionText}0` : fractionText;
    return `${whole}.${padded}`;
  } catch {
    return raw || "0";
  }
}

function originHost(value) {
  if (!value) return "";
  try {
    return new URL(value).host;
  } catch {
    return value;
  }
}

function formatList(items, formatter) {
  if (!Array.isArray(items) || items.length === 0) return "-";
  return items.map((item) => formatter(item) || item).join(", ");
}

function requesterInitial(requester) {
  const value = requester?.name || originHost(requester?.origin) || "R";
  return value.trim().slice(0, 1).toUpperCase();
}

function formatTimestamp(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value || "";
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(date);
}

createRoot(document.getElementById("root")).render(<App />);
