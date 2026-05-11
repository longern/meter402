import React, { useEffect, useState } from "react";
import { normalizeApiError } from "./apiError.js";

export default function AdminDashboard({ onStatus = () => {} }) {
  const [accounts, setAccounts] = useState([]);
  const [ownerAddress, setOwnerAddress] = useState("");
  const [autopayPrivateKey, setAutopayPrivateKey] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    loadAccounts().catch((error) => onStatus(readableErrorMessage(error)));
  }, []);

  async function loadAccounts() {
    setBusy(true);
    try {
      const data = await fetchJson("/api/admin/accounts");
      setAccounts(data.accounts || []);
    } finally {
      setBusy(false);
    }
  }

  async function handleAccountSave(event) {
    event.preventDefault();
    setBusy(true);
    try {
      const data = await fetchJson("/api/admin/accounts", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          owner: ownerAddress.trim(),
          autopay_private_key: autopayPrivateKey.trim(),
        }),
      });
      setOwnerAddress("");
      setAutopayPrivateKey("");
      onStatus(`Account saved for ${shortAddress(data.owner)}.`);
      await loadAccounts();
    } catch (error) {
      onStatus(readableErrorMessage(error));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="admin-page">
      <section className="dashboard-card admin-create-card">
        <div className="section-heading">
          <h2>Add user</h2>
        </div>
        <hr className="dashboard-card-divider" />
        <div className="dashboard-card-body">
          <form className="admin-account-form" onSubmit={handleAccountSave}>
            <label htmlFor="admin-owner-address">Main wallet address</label>
            <input
              id="admin-owner-address"
              autoComplete="off"
              spellCheck="false"
              placeholder="0x..."
              value={ownerAddress}
              onChange={(event) => setOwnerAddress(event.target.value)}
            />
            <label htmlFor="admin-autopay-private-key">Autopay private key</label>
            <input
              id="admin-autopay-private-key"
              type="password"
              autoComplete="off"
              spellCheck="false"
              placeholder="0x..."
              value={autopayPrivateKey}
              onChange={(event) => setAutopayPrivateKey(event.target.value)}
            />
            <button type="submit" disabled={busy || !ownerAddress.trim() || !autopayPrivateKey.trim()}>
              {busy ? "Saving..." : "Add user"}
            </button>
          </form>
        </div>
      </section>

      <section className="dashboard-card admin-users-card">
        <div className="section-heading">
          <h2>Users</h2>
        </div>
        <hr className="dashboard-card-divider" />
        <div className="dashboard-card-body">
          {busy && <div className="status">Loading...</div>}
          <div className="audit-list admin-account-list">
            {accounts.length === 0 && <div className="empty-cell">No users yet.</div>}
            {accounts.map((row) => (
              <article className="audit-item" key={row.owner}>
                <div className="audit-main">
                  <div>
                    <span className="audit-label">Owner</span>
                    <strong className="audit-amount">{shortAddress(row.owner)}</strong>
                  </div>
                  <span className="status-badge approved">Configured</span>
                </div>
                <div className="audit-meta">
                  <span title={row.owner}>Main {shortAddress(row.owner)}</span>
                  <span title={row.autopay_wallet_address}>Autopay {shortAddress(row.autopay_wallet_address)}</span>
                  <span>Updated {formatTimestamp(row.updated_at)}</span>
                </div>
              </article>
            ))}
          </div>
        </div>
      </section>
    </div>
  );
}

async function fetchJson(url, init) {
  const response = await fetch(url, { ...init, credentials: "include" });
  const json = await response.json().catch(() => null);
  if (!response.ok) {
    throw normalizeApiError(json, response.status);
  }
  return json;
}

function readableErrorMessage(error) {
  if (!error) return "Request failed.";
  if (typeof error === "string") return error;
  if (error instanceof Error) return error.message || "Request failed.";
  if (typeof error === "object") {
    const message = readableString(error.message)
      || readableString(error.shortMessage)
      || readableString(error.reason)
      || readableString(error.details)
      || readableString(error.data?.message);
    if (message) return message;
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

function shortAddress(value) {
  if (!value || value.length < 12) return value || "";
  return `${value.slice(0, 5)}...${value.slice(-4)}`;
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
