import { useEffect, useState } from "react";
import QRCode from "qrcode";
import ActionMenu, {
  actionMenuButtonClassName,
  actionMenuShellClassName,
  getActionMenuPosition,
} from "../ActionMenu";
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
  const [openCapabilityActionMenu, setOpenCapabilityActionMenu] = useState(null);

  useEffect(() => {
    function closeActionMenu(event) {
      if (event.target.closest?.("[data-action-menu-shell], [data-action-menu-root]")) return;
      setOpenCapabilityActionMenu(null);
    }

    function closeActionMenuOnEscape(event) {
      if (event.key === "Escape") setOpenCapabilityActionMenu(null);
    }

    function closeFloatingActionMenu() {
      setOpenCapabilityActionMenu(null);
    }

    document.addEventListener("click", closeActionMenu);
    document.addEventListener("keydown", closeActionMenuOnEscape);
    window.addEventListener("resize", closeFloatingActionMenu);
    window.addEventListener("scroll", closeFloatingActionMenu, true);

    return () => {
      document.removeEventListener("click", closeActionMenu);
      document.removeEventListener("keydown", closeActionMenuOnEscape);
      window.removeEventListener("resize", closeFloatingActionMenu);
      window.removeEventListener("scroll", closeFloatingActionMenu, true);
    };
  }, []);

  function handleCapabilityAction(action, id) {
    setOpenCapabilityActionMenu(null);
    action(id);
  }

  function toggleCapabilityActionMenu(event, id) {
    const position = getActionMenuPosition(event.currentTarget, { height: 48 });
    setOpenCapabilityActionMenu((current) => (current?.id === id ? null : { id, position }));
  }

  function renderCapabilityStatus(status) {
    return (
      <span className={`status-chip ${status}`}>
        {status}
      </span>
    );
  }

  function renderCapabilityActionMenu(item) {
    return (
      <div className={actionMenuShellClassName()} data-action-menu-shell>
        <button
          className={actionMenuButtonClassName("icon-button plain")}
          type="button"
          aria-label={`Open actions for pre-approval ${shortAddress(item.owner_address)}`}
          aria-expanded={openCapabilityActionMenu?.id === item.id}
          disabled={isBusy}
          onClick={(event) => toggleCapabilityActionMenu(event, item.id)}
        >
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <circle cx="5" cy="12" r="1.7" />
            <circle cx="12" cy="12" r="1.7" />
            <circle cx="19" cy="12" r="1.7" />
          </svg>
        </button>
        <ActionMenu
          open={openCapabilityActionMenu?.id === item.id}
          position={openCapabilityActionMenu?.position}
        >
          <button
            type="button"
            role="menuitem"
            className="danger"
            disabled={item.status === "revoked"}
            onClick={() => handleCapabilityAction(revokeCapability, item.id)}
          >
            Revoke
          </button>
        </ActionMenu>
      </div>
    );
  }

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
            disabled={capabilitiesLoading}
            onClick={loadCapabilities}
          >
            <RefreshIcon />
          </button>
        }
      >
        <div className="card-action-row">
          <button disabled={isBusy} className="primary" onClick={openCapCreate}>Create limit</button>
        </div>
        <p className="muted">Scoped autopay authorizations: amount limits, validity period, and remaining budget.</p>

        {capabilities.length ? (
          <>
            <div className="autopay-table-wrap">
              <table className="data-table autopay-table">
                <thead>
                  <tr>
                    <th>Limit</th>
                    <th className="numeric">Remaining</th>
                    <th className="numeric">Max / tx</th>
                    <th>Status</th>
                    <th>Expires</th>
                    <th>Wallet</th>
                    <th className="actions">Action</th>
                  </tr>
                </thead>
                <tbody>
                  {capabilities.map((item) => (
                    <tr key={item.id}>
                      <td><strong>{item.total_budget} USDC</strong></td>
                      <td className="numeric">{item.remaining_budget} USDC</td>
                      <td className="numeric">{item.max_single_amount} USDC</td>
                      <td>{renderCapabilityStatus(item.status)}</td>
                      <td>{item.valid_before ? formatDateTime(item.valid_before) : "Never"}</td>
                      <td className="mono">{shortAddress(item.owner_address)}</td>
                      <td className="actions">
                        {renderCapabilityActionMenu(item)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <DataList className="autopay-mobile-list">
              {capabilities.map((item) => (
                <DataListItem className="autopay-mobile-item" key={item.id}>
                  <div className="autopay-mobile-main">
                    <div className="autopay-mobile-title-row">
                      <strong>{item.total_budget} USDC limit</strong>
                      <span className="autopay-mobile-remaining">{item.remaining_budget} left</span>
                    </div>
                    <div className="autopay-mobile-meta-row">
                      <span>max {item.max_single_amount}/tx</span>
                      <span className="mono">{shortAddress(item.owner_address)}</span>
                    </div>
                    <div className="autopay-mobile-status-row">
                      {renderCapabilityStatus(item.status)}
                      <span>{item.valid_before ? `expires ${formatDateTime(item.valid_before)}` : "Never expires"}</span>
                    </div>
                  </div>
                  {renderCapabilityActionMenu(item)}
                </DataListItem>
              ))}
            </DataList>
          </>
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
