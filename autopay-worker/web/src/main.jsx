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
            <section className="login-prompt">
              <h2>Sign In Required</h2>
              {!hasWallet ? (
                <>
                  <p>No wallet detected.</p>
                  <div className="wallet-guide">
                    {isMobile ? (
                      <>
                        <p className="guide-title">Open in a wallet browser</p>
                        <p className="guide-text">
                          Please open this page in a wallet app to connect your wallet and sign in.
                        </p>
                        <div className="wallet-icon-buttons">
                          <a className="wallet-icon-btn" href={`https://go.cb-w.com/dapp?cb_url=${encodeURIComponent(window.location.href)}`}>
                            <img src="/wallet-icons/coinbase-wallet.svg" alt="Coinbase Wallet" />
                            <span>Coinbase Wallet</span>
                          </a>
                          <a className="wallet-icon-btn" href={`https://www.okx.com/download?deeplink=okx%3A%2F%2Fwallet%2Fdapp%2Furl%3FdappUrl%3D${encodeURIComponent(window.location.href)}`}>
                            <img src="/wallet-icons/okx-wallet.svg" alt="OKX Wallet" />
                            <span>OKX Wallet</span>
                          </a>
                        </div>
                      </>
                    ) : (
                      <>
                        <p className="guide-title">Install a wallet extension</p>
                        <p className="guide-text">
                          Please install a wallet browser extension such as{" "}
                          <a href="https://metamask.io" target="_blank" rel="noopener noreferrer">MetaMask</a>
                          {" "}and refresh this page.
                        </p>
                      </>
                    )}
                  </div>
                </>
              ) : (
                <>
                  <p>Connect your wallet and sign in to access your autopay records.</p>
                  <div className="wallet-row" style={{ marginTop: "14px" }}>
                    {ownerAddress ? (
                      <>
                        <strong>{shortAddress(ownerAddress)}</strong>
                        <span className="badge">Not signed in</span>
                      </>
                    ) : (
                      <span style={{ color: "#6b7280" }}>Wallet connected, requesting accounts...</span>
                    )}
                  </div>
                  <div style={{ marginTop: "14px", display: "flex", gap: "10px" }}>
                    {ownerAddress && (
                      <button disabled={busy} onClick={() => handleLogin()}>
                        Sign In
                      </button>
                    )}
                  </div>
                </>
              )}
            </section>
          </div>
        </>
      );
    }

    return (
      <>
        <header>
          <h1>Autopay Dashboard</h1>
          <p>Manage your Meteria402 autopay authorizations and payments.</p>
        </header>

        <div className="content">
          <section>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "14px" }}>
              <h2 style={{ margin: 0 }}>Wallet</h2>
              <button className="secondary" style={{ padding: "6px 12px", fontSize: "13px" }} disabled={busy} onClick={() => handleLogout()}>
                Sign Out
              </button>
            </div>
            <div className="wallet-row">
              <strong>{shortAddress(ownerAddress)}</strong>
              <span className="badge signed-in">Signed in</span>
            </div>
          </section>

          <section>
            <div className="tabs">
              <button className={activeTab === "authorizations" ? "active" : ""} onClick={() => setActiveTab("authorizations")}>Authorizations</button>
              <button className={activeTab === "payments" ? "active" : ""} onClick={() => setActiveTab("payments")}>Payments</button>
            </div>

            {auditBusy && <div className="status">Loading...</div>}

            {activeTab === "authorizations" && (
              <table className="audit-table">
                <thead>
                  <tr><th>Time</th><th>Kind</th><th>Status</th><th>Max Amount</th><th>Expires</th></tr>
                </thead>
                <tbody>
                  {auditAuth.length === 0 && <tr><td colSpan="5" className="empty-cell">No authorizations yet.</td></tr>}
                  {auditAuth.map((row) => (
                    <tr key={row.id}>
                      <td>{formatTimestamp(row.created_at)}</td>
                      <td>{row.kind}</td>
                      <td><span className={`status-badge ${row.status}`}>{row.status}</span></td>
                      <td>{row.policy_max_single_amount || "-"}</td>
                      <td>{formatTimestamp(row.expires_at)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}

            {activeTab === "payments" && (
              <table className="audit-table">
                <thead>
                  <tr><th>Time</th><th>Status</th><th>Amount</th><th>Currency</th><th>Resource</th></tr>
                </thead>
                <tbody>
                  {auditPay.length === 0 && <tr><td colSpan="5" className="empty-cell">No payments yet.</td></tr>}
                  {auditPay.map((row) => (
                    <tr key={row.id}>
                      <td>{formatTimestamp(row.created_at)}</td>
                      <td><span className={`status-badge ${row.status}`}>{row.status}</span></td>
                      <td>{row.amount_decimal || row.amount || "-"}</td>
                      <td>{row.currency}</td>
                      <td className="resource-cell">{row.resource_url || "-"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
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
            <h1>{loginApproved ? "Login Approved" : isLogin ? "Confirm Login" : "Confirm Payment"}</h1>
            <p>{loginApproved ? "You can return to Meteria402." : isLogin ? "Use your wallet" : "Review and sign this payment authorization."}</p>
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
            ) : (
              <section className="empty">
                <h2>Payment Authorization</h2>
                <p>Use this page to approve scoped x402 payment requests with your owner wallet. Start from a payment QR code or authorization link.</p>
              </section>
            )}

            {!loginApproved && policy && (
              <section>
                <h2>Request</h2>
                <dl>
                  <dt>Status</dt><dd>{authRequest.status}</dd>
                  <dt>Expires</dt><dd>{authRequest.expires_at}</dd>
                  <dt>Network</dt><dd>{policy.network}</dd>
                  <dt>Asset</dt><dd>{policy.asset}</dd>
                  <dt>Max amount</dt><dd>{policy.maxSingleAmount}</dd>
                  <dt>Policy valid before</dt><dd>{policy.validBefore}</dd>
                  <dt>Origins</dt><dd>{policy.allowedOrigins.join(", ")}</dd>
                  <dt>Recipients</dt><dd>{policy.allowedPayTo.join(", ")}</dd>
                  <dt>Payment hash</dt><dd>{authRequest.payment_requirement_hash || "Not bound"}</dd>
                </dl>
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

            {!loginApproved && authRequest && !isLogin && (
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
              <button className="danger" disabled={busy || Boolean(result)} onClick={() => denyAuthorization().catch(showError)}>Deny</button>
              {!ownerAddress && <button disabled={busy} onClick={() => connectWallet().catch(showError)}>Connect</button>}
              {ownerAddress && <button disabled={!Boolean(authRequest && ownerAddress && ownerAllowed && !busy && !result)} onClick={() => approveAuthorization().catch(showError)}>{isLogin ? "Sign in" : "Sign"}</button>}
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
  const response = await fetch(url, init);
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

function networkLabel(value) {
  if (!value || value === "eip155:8453") return "Base";
  return value;
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
