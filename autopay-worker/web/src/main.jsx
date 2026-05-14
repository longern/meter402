import React, { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import Dashboard from "./Dashboard.jsx";
import { normalizeApiError } from "./apiError.js";
import "./styles.css";

const requestId = new URLSearchParams(window.location.search).get("request_id") || "";

function App() {
  const [authRequest, setAuthRequest] = useState(null);
  const [ownerAddress, setOwnerAddress] = useState("");
  const [activeProvider, setActiveProvider] = useState(null);
  const [walletStatus, setWalletStatus] = useState("");
  const [result, setResult] = useState("");
  const [approvedAt, setApprovedAt] = useState("");
  const [busy, setBusy] = useState(false);

  // Session + dashboard state
  const [session, setSession] = useState(null); // { owner } or null
  const [checkingSession, setCheckingSession] = useState(true);
  const [pageMode, setPageMode] = useState("dashboard");
  const [activeTab, setActiveTab] = useState("authorizations");
  const [auditAuth, setAuditAuth] = useState([]);
  const [auditPay, setAuditPay] = useState([]);
  const [auditBusy, setAuditBusy] = useState(false);
  const [auditLoaded, setAuditLoaded] = useState({
    authorizations: false,
    payments: false,
  });
  const [autopayWalletAddress, setAutopayWalletAddress] = useState("");
  const [autopayPrivateKey, setAutopayPrivateKey] = useState("");
  const [walletKeyDialogOpen, setWalletKeyDialogOpen] = useState(false);
  const [accountBusy, setAccountBusy] = useState(false);

  const [hasWallet, setHasWallet] = useState(false);

  const [authLoading, setAuthLoading] = useState(false);
  const [authError, setAuthError] = useState(false);

  useEffect(() => {
    init().catch(showError);

    async function init() {
      if (requestId) {
        await waitForInjectedWallet();
        setHasWallet(Boolean(window.ethereum));
        setAuthLoading(true);
        setAuthError(false);
        try {
          const details = await fetchJson(`/api/auth/requests/${encodeURIComponent(requestId)}`);
          setAuthRequest(details);
          if (details.status === "approved" || details.status === "denied") {
            setResult(details.status);
          }
          setWalletStatus("Connect an owner wallet to continue.");
          autoConnectWallet();
        } catch {
          setAuthError(true);
        } finally {
          setAuthLoading(false);
        }
      } else {
        await checkSession();
        waitForInjectedWallet().then(() => {
          setHasWallet(Boolean(window.ethereum));
          if (window.ethereum) {
            autoConnectWallet().catch(showError);
          }
        });
      }
    }
  }, []);

  async function waitForInjectedWallet() {
    let attempts = 0;
    while (!window.ethereum && attempts < 20) {
      await new Promise((resolve) => setTimeout(resolve, 150));
      attempts++;
    }
  }

  useEffect(() => {
    const provider = window.ethereum;
    if (!provider?.on) return undefined;

    const handleAccountsChanged = (accounts = []) => {
      setWalletAddress(accounts[0]).catch(showError);
    };

    provider.on("accountsChanged", handleAccountsChanged);
    return () => {
      provider.removeListener?.("accountsChanged", handleAccountsChanged);
    };
  }, []);

  useEffect(() => {
    if (!authRequest) return;
    if (!ownerAddress) {
      setWalletStatus("Connect an owner wallet to continue.");
      return;
    }
    setWalletStatus("Connected wallet is ready to sign.");
  }, [authRequest, ownerAddress]);

  // Auto-load audit when session exists and on dashboard
  useEffect(() => {
    if (!session || requestId || pageMode !== "dashboard") return;
    loadAudit();
  }, [session, activeTab, pageMode]);

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
        setSession({ owner: me.owner, is_admin: Boolean(me.is_admin) });
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
    const tab = activeTab;
    setAuditBusy(true);
    try {
      if (tab === "authorizations") {
        const data = await fetchJson("/api/audit/authorizations");
        setAuditAuth(data.authorizations || []);
      } else {
        const data = await fetchJson("/api/audit/payments");
        setAuditPay(data.payments || []);
      }
      setAuditLoaded((current) => ({ ...current, [tab]: true }));
    } catch (err) {
      setWalletStatus(readableErrorMessage(err));
    } finally {
      setAuditBusy(false);
    }
  }

  async function loadDashboardCapabilities(owner) {
    const data = await fetchJson("/api/account");
    setAutopayWalletAddress(data.autopay_wallet_address || "");
  }

  async function handleAutopayWalletSave(event) {
    event.preventDefault();
    setAccountBusy(true);
    try {
      const data = await fetchJson("/api/account/autopay-wallet", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ private_key: autopayPrivateKey.trim() }),
      });
      setAutopayWalletAddress(data.autopay_wallet_address || "");
      setAutopayPrivateKey("");
      setWalletKeyDialogOpen(false);
      setWalletStatus("Autopay wallet saved.");
    } catch (err) {
      showError(err);
    } finally {
      setAccountBusy(false);
    }
  }

  function openWalletKeyDialog() {
    setAutopayPrivateKey("");
    setWalletKeyDialogOpen(true);
  }

  function closeWalletKeyDialog() {
    if (accountBusy) return;
    setAutopayPrivateKey("");
    setWalletKeyDialogOpen(false);
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
      setPageMode("dashboard");
      setAuditAuth([]);
      setAuditPay([]);
      setAuditLoaded({ authorizations: false, payments: false });
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

  async function setWalletAddress(address) {
    if (!address) {
      setOwnerAddress("");
      return;
    }
    const { checksumAddress } = await loadWalletAuth();
    setOwnerAddress(checksumAddress(address));
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
      await setWalletAddress(accounts[0]);
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

  const dashboardClassName =
    !authPage && !checkingSession && !session
      ? "dashboard-page dashboard-page-guest"
      : "dashboard-page";

  return (
    <main className={authPage ? "auth-page" : dashboardClassName}>
      {!authPage ? (
        <Dashboard
          checkingSession={checkingSession}
          session={session}
          hasWallet={hasWallet}
          ownerAddress={ownerAddress}
          busy={busy}
          pageMode={pageMode}
          setPageMode={setPageMode}
          activeTab={activeTab}
          setActiveTab={setActiveTab}
          auditAuth={auditAuth}
          auditPay={auditPay}
          auditBusy={auditBusy}
          auditLoaded={auditLoaded}
          autopayWalletAddress={autopayWalletAddress}
          autopayPrivateKey={autopayPrivateKey}
          setAutopayPrivateKey={setAutopayPrivateKey}
          walletKeyDialogOpen={walletKeyDialogOpen}
          accountBusy={accountBusy}
          handleLogin={handleLogin}
          handleLogout={handleLogout}
          handleAutopayWalletSave={handleAutopayWalletSave}
          openWalletKeyDialog={openWalletKeyDialog}
          closeWalletKeyDialog={closeWalletKeyDialog}
          onStatus={setWalletStatus}
        />
      ) : (
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
                  {ownerAddress && <button disabled={!Boolean(authRequest && ownerAddress && !busy && !result)} onClick={() => approveAuthorization().catch(showError)}>{isLogin ? "Sign in" : "Sign"}</button>}
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
    throw normalizeApiError(json, response.status);
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
  const code = error.code ?? error.data?.code;
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
