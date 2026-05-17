import React, { useEffect, useState } from "react";
import "./admin-styles.css";
import { useI18n } from "./i18n";
import { shortAddress, readableError, formatMoneyCompact } from "./utils";
import Modal from "./Modal";

export default function AdminConsole({ identity, onSessionChange }) {
  const { t } = useI18n();
  const [activeView, setActiveView] = useState("dashboard");
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [stats, setStats] = useState(null);
  const [accounts, setAccounts] = useState(null);
  const [apiKeys, setApiKeys] = useState(null);
  const [deposits, setDeposits] = useState(null);
  const [invoices, setInvoices] = useState(null);
  const [requests, setRequests] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [createOpen, setCreateOpen] = useState(false);
  const [newOwner, setNewOwner] = useState("");
  const [createStatus, setCreateStatus] = useState("");
  const [creating, setCreating] = useState(false);

  const adminNavItems = [
    { view: "dashboard", label: t("Dashboard"), icon: "📊" },
    { view: "accounts", label: t("Accounts"), icon: "👤" },
    { view: "api-keys", label: t("API Keys"), icon: "🔑" },
    { view: "deposits", label: t("Deposits"), icon: "💰" },
    { view: "invoices", label: t("Invoices"), icon: "📄" },
    { view: "requests", label: t("Requests"), icon: "📡" },
  ];

  async function request(path, options = {}) {
    const headers = { "content-type": "application/json", ...(options.headers || {}) };
    const response = await fetch(path, { ...options, headers });
    const text = await response.text();
    const json = text ? JSON.parse(text) : null;
    if (!response.ok) throw new Error(json?.message || `HTTP ${response.status}`);
    return json;
  }

  async function loadStats() {
    const data = await request("/api/admin/stats");
    setStats(data);
  }

  async function loadAccounts() {
    const data = await request("/api/admin/accounts");
    setAccounts(data);
  }

  async function loadApiKeys() {
    const data = await request("/api/admin/api-keys");
    setApiKeys(data);
  }

  async function loadDeposits() {
    const data = await request("/api/admin/deposits");
    setDeposits(data);
  }

  async function loadInvoices() {
    const data = await request("/api/admin/invoices");
    setInvoices(data);
  }

  async function loadRequests() {
    const data = await request("/api/admin/requests");
    setRequests(data);
  }

  useEffect(() => {
    setLoading(true);
    setError("");
    loadStats()
      .then(() => {
        if (activeView === "accounts") return loadAccounts();
        if (activeView === "api-keys") return loadApiKeys();
        if (activeView === "deposits") return loadDeposits();
        if (activeView === "invoices") return loadInvoices();
        if (activeView === "requests") return loadRequests();
      })
      .catch((err) => setError(readableError(err)))
      .finally(() => setLoading(false));
  }, [activeView]);

  function navigateAdmin(view) {
    setActiveView(view);
    setSidebarOpen(false);
  }

  function goToConsole() {
    window.location.assign("/console");
  }

  function logout() {
    fetch("/api/logout", { method: "POST" }).catch(() => {});
    onSessionChange(null);
    window.location.assign("/login");
  }

  async function createAccount(event) {
    event.preventDefault();
    setCreateStatus("");
    const address = newOwner.trim();
    if (!address) {
      setCreateStatus(t("Wallet Address") + " is required.");
      return;
    }
    setCreating(true);
    try {
      await request("/api/admin/accounts", {
        method: "POST",
        body: JSON.stringify({ owner_address: address }),
      });
      setNewOwner("");
      setCreateOpen(false);
      if (activeView === "accounts") {
        setLoading(true);
        await loadAccounts();
        setLoading(false);
      }
    } catch (err) {
      setCreateStatus(readableError(err));
    } finally {
      setCreating(false);
    }
  }

  return (
    <div className="console-shell">
      <aside className={`console-sidebar admin-sidebar ${sidebarOpen ? "open" : ""}`}>
        <a className="brand console-brand" href="/">
          <img src="/logo-transparent.png" alt="" className="brand-icon" />
          {t("Admin")}
        </a>

        <div className="admin-identity">
          <span>{shortAddress(identity.owner)}</span>
        </div>

        <nav className="console-nav" aria-label="Admin navigation">
          {adminNavItems.map((item) => (
            <a
              key={item.view}
              href={`#${item.view}`}
              className={item.view === activeView ? "active" : ""}
              onClick={(e) => {
                e.preventDefault();
                navigateAdmin(item.view);
              }}
            >
              <span className="nav-icon">{item.icon}</span>
              {item.label}
            </a>
          ))}
        </nav>

        <div className="admin-sidebar-footer">
          <button type="button" className="text-button back-to-console" onClick={goToConsole}>
            ← {t("Back to Console")}
          </button>
          <button type="button" className="text-button logout" onClick={logout}>
            {t("Logout")}
          </button>
        </div>
      </aside>

      <button
        className={`sidebar-scrim ${sidebarOpen ? "visible" : ""}`}
        aria-label="Close navigation"
        aria-hidden={!sidebarOpen}
        tabIndex={sidebarOpen ? 0 : -1}
        onClick={() => setSidebarOpen(false)}
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
          <span className="mobile-console-brand">{t("Admin")}</span>
          <button type="button" className="icon-button back-button" onClick={goToConsole} title={t("Back to Console")}>
            <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M9 14L4 9l5-5" />
              <path d="M4 9h16" />
            </svg>
          </button>
        </div>

        <div className="console-header">
          <h1>{adminNavItems.find((i) => i.view === activeView)?.label || t("Dashboard")}</h1>
        </div>

        {error && <div className="admin-error-banner">{error}</div>}

        {activeView === "dashboard" && stats && (
          <div className="admin-dashboard">
            <div className="stat-grid">
              <div className="stat-card">
                <span className="stat-value">{stats.total_accounts}</span>
                <span className="stat-label">{t("Total Accounts")}</span>
              </div>
              <div className="stat-card">
                <span className="stat-value">{stats.active_accounts}</span>
                <span className="stat-label">{t("Active Accounts")}</span>
              </div>
              <div className="stat-card">
                <span className="stat-value">{stats.active_keys}</span>
                <span className="stat-label">{t("Active Keys")}</span>
              </div>
              <div className="stat-card">
                <span className="stat-value">{formatMoneyCompact(stats.total_deposits)}</span>
                <span className="stat-label">{t("Total Deposits")}</span>
              </div>
              <div className="stat-card">
                <span className="stat-value">{formatMoneyCompact(stats.total_unpaid)}</span>
                <span className="stat-label">{t("Total Unpaid")}</span>
              </div>
              <div className="stat-card">
                <span className="stat-value">{stats.requests_24h}</span>
                <span className="stat-label">{t("Requests 24h")}</span>
              </div>
            </div>
          </div>
        )}

        {activeView === "accounts" && (
          <>
            <div className="admin-table-actions">
              <button
                type="button"
                className="primary"
                onClick={() => {
                  setNewOwner("");
                  setCreateStatus("");
                  setCreateOpen(true);
                }}
              >
                + {t("Add User")}
              </button>
            </div>
            {loading ? (
              <div className="admin-loading">
                <span className="spinner" />
              </div>
            ) : accounts ? (
              <AdminDataTable
                columns={[
                  { key: "id", label: t("ID"), width: "200px" },
                  { key: "owner_address", label: t("Owner"), formatter: (v) => shortAddress(v) },
                  { key: "status", label: t("Status") },
                  { key: "deposit_balance", label: t("Deposit"), formatter: (v) => formatMoneyCompact(v) },
                  { key: "unpaid_invoice_total", label: t("Unpaid"), formatter: (v) => formatMoneyCompact(v) },
                  { key: "created_at", label: t("Created") },
                ]}
                rows={accounts.accounts || []}
                total={accounts.total}
              />
            ) : null}
          </>
        )}

        {activeView === "api-keys" && apiKeys && (
          <AdminDataTable
            columns={[
              { key: "id", label: t("ID"), width: "200px" },
              { key: "owner_address", label: t("Owner"), formatter: (v) => shortAddress(v) },
              { key: "name", label: t("Name") },
              { key: "spend_limit", label: t("Limit"), formatter: (v) => v ? formatMoneyCompact(v) : "∞" },
              { key: "spent_amount", label: t("Spent"), formatter: (v) => formatMoneyCompact(v) },
              { key: "created_at", label: t("Created") },
            ]}
            rows={apiKeys.api_keys || []}
            total={apiKeys.total}
          />
        )}

        {activeView === "deposits" && deposits && (
          <AdminDataTable
            columns={[
              { key: "id", label: t("ID"), width: "200px" },
              { key: "owner_address", label: t("Owner"), formatter: (v) => shortAddress(v) },
              { key: "amount", label: t("Amount"), formatter: (v) => formatMoneyCompact(v) },
              { key: "status", label: t("Status") },
              { key: "settled_at", label: t("Settled") },
              { key: "created_at", label: t("Created") },
            ]}
            rows={deposits.deposits || []}
            total={deposits.total}
          />
        )}

        {activeView === "invoices" && invoices && (
          <AdminDataTable
            columns={[
              { key: "id", label: t("ID"), width: "200px" },
              { key: "owner_address", label: t("Owner"), formatter: (v) => shortAddress(v) },
              { key: "amount", label: t("Amount"), formatter: (v) => formatMoneyCompact(v) },
              { key: "status", label: t("Status") },
              { key: "settled_at", label: t("Settled") },
              { key: "created_at", label: t("Created") },
            ]}
            rows={invoices.invoices || []}
            total={invoices.total}
          />
        )}

        {activeView === "requests" && requests && (
          <AdminDataTable
            columns={[
              { key: "id", label: t("ID"), width: "200px" },
              { key: "owner_address", label: t("Owner"), formatter: (v) => shortAddress(v) },
              { key: "provider", label: t("Provider") },
              { key: "model", label: t("Model") },
              { key: "cost", label: t("Cost"), formatter: (v) => formatMoneyCompact(v) },
              { key: "created_at", label: t("Created") },
            ]}
            rows={requests.requests || []}
            total={requests.total}
          />
        )}
        <Modal
          open={createOpen}
          onClose={() => {
            if (!creating) setCreateOpen(false);
          }}
          title={t("Create Account")}
        >
          <form onSubmit={createAccount}>
            <div className="admin-form-group">
              <label htmlFor="new-owner-address">{t("Wallet Address")}</label>
              <input
                id="new-owner-address"
                type="text"
                value={newOwner}
                placeholder="0x..."
                autoComplete="off"
                spellCheck="false"
                onChange={(e) => setNewOwner(e.target.value)}
                disabled={creating}
              />
              {createStatus && <p className="form-status">{createStatus}</p>}
            </div>
            <div className="admin-form-actions">
              <button
                type="button"
                className="secondary"
                disabled={creating}
                onClick={() => setCreateOpen(false)}
              >
                {t("Cancel")}
              </button>
              <button type="submit" className="primary" disabled={creating || !newOwner.trim()}>
                {creating ? "..." : t("Create")}
              </button>
            </div>
          </form>
        </Modal>
      </main>
    </div>
  );
}

function AdminDataTable({ columns, rows, total }) {
  return (
    <>
      <div className="admin-table-header">
        <span className="muted">{total} total</span>
      </div>
      <div className="admin-table-wrapper">
        <table className="admin-table">
          <thead>
            <tr>
              {columns.map((col) => (
                <th key={col.key} style={col.width ? { width: col.width } : undefined}>
                  {col.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 && (
              <tr>
                <td colSpan={columns.length} className="admin-empty">
                  No data
                </td>
              </tr>
            )}
            {rows.map((row, i) => (
              <tr key={row.id || i}>
                {columns.map((col) => (
                  <td key={col.key} title={String(row[col.key] || "")}>
                    {col.formatter ? col.formatter(row[col.key]) : (row[col.key] ?? "—")}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}
