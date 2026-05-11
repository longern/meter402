import { useState, useRef } from "react";
import QRCode from "qrcode";
import CardSection from "../CardSection";
import DataList, { DataListItem } from "../DataList";
import Modal from "../Modal";
import { RefreshIcon } from "../icons";
import {
  formatDateTime,
  shortAddress,
  buildCoinbaseWalletLink,
  buildOkxWalletLink,
} from "../utils";

export default function AutopayView({
  capabilities,
  capabilitiesLoading,
  isBusy,
  busy,
  loadCapabilities,
  openCapCreate,
  revokeCapability,
  capCreateOpen,
  closeCapCreate,
  createCapability,
  capDialog,
  closeCapDialog,
  capTotalBudget,
  setCapTotalBudget,
  capMaxSingleAmount,
  setCapMaxSingleAmount,
  capTtlDays,
  setCapTtlDays,
  capApprovalCopied,
  copyCapApprovalLink,
}) {
  return (
    <>
      <CardSection
        title="Pre-approvals"
        actions={
          <button
            className="icon-button plain"
            type="button"
            aria-label="Refresh autopay limits"
            title="Refresh autopay limits"
            disabled={isBusy || capabilitiesLoading}
            onClick={loadCapabilities}
          >
            <RefreshIcon />
          </button>
        }
      >
        <div style={{ marginBottom: 12 }}>
          <button disabled={isBusy} className="primary" onClick={openCapCreate}>Create limit</button>
        </div>
        <p className="muted">Scoped autopay authorizations: amount limits, validity period, and remaining budget.</p>

        {capabilities.length ? (
          <DataList>
            {capabilities.map((item) => (
              <DataListItem className={item.status} key={item.id}>
                <div>
                  <strong>{item.total_budget} USDC limit</strong>
                  <span>
                    {item.status} · {item.remaining_budget} remaining · max {item.max_single_amount}/tx
                    {item.valid_before ? ` · expires ${formatDateTime(item.valid_before)}` : ""}
                  </span>
                  <span className="mono">{shortAddress(item.owner_address)}</span>
                </div>
                <button
                  className="secondary danger"
                  disabled={isBusy || item.status === "revoked"}
                  onClick={() => revokeCapability(item.id)}
                >
                  Revoke
                </button>
              </DataListItem>
            ))}
          </DataList>
        ) : (
          <p className="muted">No autopay limits. Create one to enable scoped wallet pre-approval.</p>
        )}
      </CardSection>

      {capCreateOpen && (
        <Modal
          open={capCreateOpen}
          onClose={closeCapCreate}
          title="Create Autopay Limit"
          titleId="create-cap-title"
        >
          <form onSubmit={createCapability}>
            <div className="dialog-form">
              <label>
                <span>Total budget (USDC)</span>
                <input value={capTotalBudget} inputMode="decimal" onChange={(e) => setCapTotalBudget(e.target.value)} />
              </label>
              <label>
                <span>Max per transaction (USDC)</span>
                <input value={capMaxSingleAmount} inputMode="decimal" onChange={(e) => setCapMaxSingleAmount(e.target.value)} />
              </label>
              <label>
                <span>Valid for (days)</span>
                <input type="number" min={1} max={30} value={capTtlDays} onChange={(e) => setCapTtlDays(parseInt(e.target.value, 10) || 7)} />
              </label>
            </div>
            <div className="dialog-actions">
              <button type="button" className="secondary" onClick={closeCapCreate}>Cancel</button>
              <button type="submit" className="primary" disabled={isBusy}>
                {busy === "createCapability" ? "Creating..." : "Create limit"}
              </button>
            </div>
          </form>
        </Modal>
      )}

      {capDialog && (
        <Modal
          open={!!capDialog}
          onClose={closeCapDialog}
          title={capDialog.status === "done" ? "Limit created" : "Approve limit"}
          className="payment-modal"
          titleId="cap-title"
        >
          <div className="payment-qr-panel">
            <div className="cap-qr-desktop">
              {capDialog.qr ? (
                <img src={capDialog.qr} alt="Wallet approval QR code" />
              ) : (
                <div className="payment-qr-placeholder">Preparing QR</div>
              )}
              <p className="wallet-qr-hint">Scan this QR code with your wallet app.</p>
            </div>
            <div className="cap-qr-mobile">
              <div className="wallet-row">
                {capDialog.url && (
                  <>
                    <a className="wallet-icon-link" href={capDialog.url} target="_blank" rel="noreferrer" aria-label="Open approval link">
                      <svg viewBox="0 0 24 24" aria-hidden="true" width="22" height="22">
                        <path d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" stroke="currentColor" strokeWidth="2" fill="none" strokeLinecap="round" strokeLinejoin="round"/>
                      </svg>
                    </a>
                    <a className="wallet-icon-link" href={buildCoinbaseWalletLink(capDialog.url)} target="_blank" rel="noreferrer" aria-label="Open in Coinbase Wallet">
                      <img src="/wallet-icons/coinbase-wallet.svg" alt="" width="22" height="22" />
                    </a>
                    <a className="wallet-icon-link" href={buildOkxWalletLink(capDialog.url)} target="_blank" rel="noreferrer" aria-label="Open in OKX Wallet">
                      <img src="/wallet-icons/okx-wallet.svg" alt="" width="22" height="22" />
                    </a>
                  </>
                )}
              </div>
              <p className="wallet-mobile-fallback">Open this link in your wallet app.</p>
              <div className="approval-link-box">
                <div className="approval-link-header">
                  <span>Approval link</span>
                  <button className={`approval-copy-button${capApprovalCopied ? " copied" : ""}`} type="button" onClick={copyCapApprovalLink} disabled={!capDialog.url} aria-label={capApprovalCopied ? "Copied" : "Copy approval link"} title={capApprovalCopied ? "Copied" : "Copy approval link"}>
                    {capApprovalCopied ? (
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
                <code>{capDialog.url || "Preparing link..."}</code>
              </div>
            </div>
            {capDialog.status !== "waiting" && (
              <div className="cap-approval-status">
                <strong>{capDialog.status === "done" ? "Done" : "Failed"}</strong>
                <p className="muted">
                  {capDialog.status === "done"
                    ? "The pre-approval is now active."
                    : "Something went wrong. You can try creating the limit again."}
                </p>
                {capDialog.error && <p className="form-error">{capDialog.error}</p>}
                <div className="wallet-row">
                  <button type="button" className="secondary" onClick={closeCapDialog}>Close</button>
                </div>
              </div>
            )}
          </div>
        </Modal>
      )}
    </>
  );
}
