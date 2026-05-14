import AdminDashboard from "./AdminDashboard.jsx";
import "./Dashboard.css";

export default function Dashboard({
  checkingSession,
  session,
  hasWallet,
  ownerAddress,
  busy,
  pageMode,
  setPageMode,
  activeTab,
  setActiveTab,
  auditAuth,
  auditPay,
  auditBusy,
  auditLoaded,
  autopayWalletAddress,
  autopayPrivateKey,
  setAutopayPrivateKey,
  walletKeyDialogOpen,
  accountBusy,
  handleLogin,
  handleLogout,
  handleAutopayWalletSave,
  openWalletKeyDialog,
  closeWalletKeyDialog,
  onStatus,
}) {
  if (checkingSession) {
    return (
      <div className="content dashboard-loading">
        <div className="spinner" role="status" aria-label="Loading" />
      </div>
    );
  }

  if (!session) {
    const isMobile = /iPhone|iPad|iPod|Android/i.test(navigator.userAgent);
    return (
      <div className="dashboard-guest-shell">
        <section className="dashboard-login-card">
          <header className="dashboard-guest-header">
            <h1>Autopay Dashboard</h1>
            <p>Sign in to view your authorizations and payments.</p>
          </header>
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
                    <strong>{shortAddress(ownerAddress)}</strong>
                  ) : (
                    <span style={{ color: "#6b7280" }}>Wallet connected, requesting accounts...</span>
                  )}
                </div>
                <div className="login-action">
                  {ownerAddress && (
                    <button disabled={busy} onClick={() => handleLogin()}>
                      Sign In
                    </button>
                  )}
                </div>
              </>
            )}
          </div>
        </section>
      </div>
    );
  }

  const adminModeButton = session.is_admin ? (
    <div className="dashboard-content-actions">
      <button
        className="dashboard-mode-button"
        type="button"
        disabled={busy}
        onClick={() => setPageMode((current) => current === "admin" ? "dashboard" : "admin")}
      >
        {pageMode === "admin" ? "Back to dashboard" : "Go to admin console"}
      </button>
    </div>
  ) : null;
  const activeAuditItems = activeTab === "authorizations" ? auditAuth : auditPay;
  const activeAuditLoaded = Boolean(auditLoaded?.[activeTab]);
  const auditInitialLoading = auditBusy && !activeAuditLoaded;
  const auditRefreshOverlay = auditBusy && activeAuditLoaded && activeAuditItems.length > 0;

  return (
    <>
      <div className="dashboard-topbar">
        <div className="dashboard-topbar-inner">
          <h1>{pageMode === "admin" ? "Admin" : "Autopay"}</h1>
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

      {pageMode === "admin" ? (
        <div className="content admin-content">
          {adminModeButton}
          <AdminDashboard onStatus={onStatus} />
        </div>
      ) : (
      <div className="content">
        {adminModeButton}
        <section className="dashboard-card autopay-wallet-card">
          <div className="section-heading">
            <h2>Autopay wallet</h2>
          </div>
          <hr className="dashboard-card-divider" />
          <div className="dashboard-card-body">
            <div className="wallet-address-row">
              <strong className="wallet-address-large">{autopayWalletAddress ? shortAddress(autopayWalletAddress) : "Not configured"}</strong>
              <button className="icon-button" type="button" aria-label="Edit autopay wallet private key" onClick={openWalletKeyDialog}>
                <svg viewBox="0 0 24 24" aria-hidden="true">
                  <path d="M12 20h9" />
                  <path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z" />
                </svg>
              </button>
            </div>
            {autopayWalletAddress && <p className="wallet-address-full">{autopayWalletAddress}</p>}
          </div>
        </section>

        <section className="dashboard-card">
          <div className="section-heading">
            <h2>Activity</h2>
            <div className="tabs">
              <button className={activeTab === "authorizations" ? "active" : ""} onClick={() => setActiveTab("authorizations")}>Authorizations</button>
              <button className={activeTab === "payments" ? "active" : ""} onClick={() => setActiveTab("payments")}>Payments</button>
            </div>
          </div>
          <hr className="dashboard-card-divider" />

          <div className={`dashboard-card-body activity-body${auditRefreshOverlay ? " is-refreshing" : ""}`} aria-busy={auditBusy ? "true" : "false"}>
            {auditInitialLoading && (
              <div className="activity-loading">
                <div className="spinner" role="status" aria-label="Loading activity" />
              </div>
            )}

            {!auditInitialLoading && activeTab === "authorizations" && (
              <div className="audit-list">
                {auditAuth.length === 0 && <div className="empty-cell">No authorizations yet.</div>}
                {auditAuth.map((row) => (
                  <article className="audit-item" key={row.id}>
                    <div className="audit-main">
                      <div>
                        <span className="audit-label">Max amount</span>
                        <strong className="audit-amount">{formatAuthorizationAmount(row)}</strong>
                      </div>
                      <span className={`status-badge ${statusClassName(row.status)}`}>{formatStatusLabel(row.status)}</span>
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

            {!auditInitialLoading && activeTab === "payments" && (
              <div className="audit-list">
                {auditPay.length === 0 && <div className="empty-cell">No payments yet.</div>}
                {auditPay.map((row) => (
                  <article className="audit-item payment-audit-item" key={row.id}>
                    <div className="payment-audit-lines">
                      <strong className="audit-amount">{formatPaymentAmount(row)}</strong>
                      <span className="payment-audit-domain">{originHost(row.requester_origin) || "-"}</span>
                      <span className="payment-audit-time">{formatTimestamp(row.created_at)}</span>
                    </div>
                    <span className={`status-badge payment-audit-status ${statusClassName(row.status)}`}>{formatStatusLabel(row.status)}</span>
                    {renderPaymentExplorerLink(row)}
                  </article>
                ))}
              </div>
            )}
            {auditRefreshOverlay && (
              <div className="activity-refresh-overlay" aria-hidden="true">
                <div className="spinner" />
              </div>
            )}
          </div>
        </section>
      </div>
      )}
      {walletKeyDialogOpen && (
        <div className="dialog-backdrop" role="presentation" onMouseDown={closeWalletKeyDialog}>
          <section className="dialog-card wallet-key-dialog" role="dialog" aria-modal="true" aria-labelledby="wallet-key-dialog-title" onMouseDown={(event) => event.stopPropagation()}>
            <div className="section-heading">
              <h2 id="wallet-key-dialog-title">Edit autopay wallet</h2>
              <button className="icon-button" type="button" aria-label="Close" disabled={accountBusy} onClick={closeWalletKeyDialog}>
                <svg viewBox="0 0 24 24" aria-hidden="true">
                  <path d="M18 6 6 18" />
                  <path d="m6 6 12 12" />
                </svg>
              </button>
            </div>
            <hr className="dashboard-card-divider" />
            <form className="wallet-key-form" onSubmit={handleAutopayWalletSave}>
              <label htmlFor="autopay-private-key">Private key</label>
              <input
                id="autopay-private-key"
                type="password"
                autoComplete="off"
                spellCheck="false"
                placeholder="0x..."
                value={autopayPrivateKey}
                onChange={(event) => setAutopayPrivateKey(event.target.value)}
                autoFocus
              />
              <div className="dialog-actions">
                <button type="button" className="button-link secondary" disabled={accountBusy} onClick={closeWalletKeyDialog}>Cancel</button>
                <button type="submit" disabled={accountBusy || !autopayPrivateKey.trim()}>
                  {accountBusy ? "Saving..." : "Save"}
                </button>
              </div>
            </form>
          </section>
        </div>
      )}
    </>
  );
}

function shortAddress(value) {
  if (!value || value.length < 12) return value || "";
  return `${value.slice(0, 5)}...${value.slice(-4)}`;
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

function renderPaymentExplorerLink(row) {
  if (!row.tx_hash) return null;
  const href = transactionExplorerUrl(row.network, row.tx_hash);
  return (
    <a
      className="icon-button payment-audit-link"
      href={href}
      target="_blank"
      rel="noreferrer"
      aria-label="View transaction"
      title="View transaction"
    >
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
      </svg>
    </a>
  );
}

function transactionExplorerUrl(network, txHash) {
  const chainId = Number(String(network || "").split(":")[1] || "8453");
  const explorers = {
    1: "https://etherscan.io",
    10: "https://optimistic.etherscan.io",
    137: "https://polygonscan.com",
    8453: "https://basescan.org",
    84532: "https://sepolia.basescan.org",
    42161: "https://arbiscan.io",
    11155111: "https://sepolia.etherscan.io",
  };
  const explorer = explorers[chainId] || "https://blockscan.com";
  return `${explorer}/tx/${encodeURIComponent(txHash)}`;
}

function statusClassName(value) {
  return String(value || "").toLowerCase();
}

function formatStatusLabel(value) {
  return String(value || "")
    .split(/[_\s-]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1).toLowerCase())
    .join(" ");
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
