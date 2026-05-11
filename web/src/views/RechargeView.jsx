import { useState } from "react";
import CardSection from "../CardSection";
import Modal from "../Modal";
import DepositDialog from "../DepositDialog";
import { RefreshIcon } from "../icons";
import { formatDateTime, shortAddress } from "../utils";

export default function RechargeView({
  account,
  deposits,
  identity,
  autopayWalletBalance,
  autopayWalletBalanceError,
  isBusy,
  busy,
  loadAccount,
  loadDeposits,
  loadAutopayWalletBalance,
  openDepositDialog,
  closeDepositDialog,
  editEndpointOpen,
  closeEditEndpointDialog,
  openEditEndpointDialog,
  autopayUrl,
  setAutopayUrl,
  updateAutopayEndpoint,
  depositDialogOpen,
  paymentDialog,
  closePaymentDialog,
  request,
  withBusy,
  show,
  setNewApiKey,
  waitForAutopayAuthorization,
}) {
  const autopayEndpoint = account?.autopay_url || "";
  const [addressCopied, setAddressCopied] = useState(false);

  async function copyAddress() {
    const addr = autopayWalletBalance?.address;
    if (!addr) return;
    try {
      await navigator.clipboard.writeText(addr);
      setAddressCopied(true);
      window.setTimeout(() => setAddressCopied(false), 1400);
    } catch {
      setAddressCopied(false);
    }
  }

  return (
    <>
      <CardSection title="Account Balance">
        {account ? (
          <div className="balance-panel">
            <span className="balance-label">Deposit Balance</span>
            <span className="balance-value">{account.deposit_balance} USDC</span>
            <span className="balance-label">Unpaid Invoices</span>
            <span className="balance-value">{account.unpaid_invoice_total} USDC</span>
            <span className="balance-label">Status</span>
            <span className="balance-value">{account.status}</span>
          </div>
        ) : (
          <p className="muted">Loading account...</p>
        )}
        <div className="row" style={{ marginTop: 12 }}>
          <button disabled={isBusy} className="primary" onClick={() => openDepositDialog()}>
            Add deposit
          </button>
        </div>
      </CardSection>

      <CardSection
        title="Autopay Wallet"
        actions={
          identity?.owner && autopayEndpoint ? (
            <button
              className="icon-button plain"
              type="button"
              aria-label="Refresh balance"
              disabled={busy === "loadWalletBalance"}
              onClick={loadAutopayWalletBalance}
            >
              <RefreshIcon />
            </button>
          ) : undefined
        }
      >
        {identity?.owner ? (
          <>
            <div className="balance-panel">
              <span className="balance-label">Endpoint</span>
              <div className="endpoint-row">
                <span className={`balance-value mono${autopayEndpoint ? "" : " muted"}`}>
                  {autopayEndpoint || "Not configured"}
                </span>
                <div className="endpoint-actions">
                  <a
                    href={autopayEndpoint || undefined}
                    target="_blank"
                    rel="noreferrer"
                    className="icon-button open-link"
                    aria-label="Open endpoint"
                    aria-disabled={!autopayEndpoint}
                    onClick={(e) => { if (!autopayEndpoint) e.preventDefault(); }}
                  >
                    <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">
                      <path d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" stroke="currentColor" strokeWidth="2" fill="none" strokeLinecap="round" strokeLinejoin="round"/>
                    </svg>
                  </a>
                  <button
                    type="button"
                    className="icon-button open-link"
                    aria-label="Edit endpoint"
                    onClick={() => openEditEndpointDialog()}
                  >
                    <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">
                      <g transform="translate(2.4 2.4) scale(0.8)">
                        <path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7" stroke="currentColor" strokeWidth="2" fill="none" strokeLinecap="round" strokeLinejoin="round"/>
                        <path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z" stroke="currentColor" strokeWidth="2" fill="none" strokeLinecap="round" strokeLinejoin="round"/>
                      </g>
                    </svg>
                  </button>
                </div>
              </div>
              {autopayEndpoint && autopayWalletBalance?.address && (
                <>
                  <span className="balance-label">Address</span>
                  <div className="address-row">
                    <span className="balance-value mono">
                      {shortAddress(autopayWalletBalance.address)}
                    </span>
                    <button
                      type="button"
                      className={`address-copy-button${addressCopied ? " copied" : ""}`}
                      aria-label={addressCopied ? "Copied" : "Copy address"}
                      title={addressCopied ? "Copied" : "Copy address"}
                      onClick={copyAddress}
                    >
                      {addressCopied ? (
                        <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true">
                          <path d="M5 13l4 4L19 7" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
                        </svg>
                      ) : (
                        <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true">
                          <rect x="9" y="9" width="10" height="10" rx="2" fill="none" stroke="currentColor" strokeWidth="2"/>
                          <path d="M6 15H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v1" fill="none" stroke="currentColor" strokeWidth="2"/>
                        </svg>
                      )}
                    </button>
                  </div>
                  <span className="balance-label">Balance</span>
                  <span className="balance-value">
                    {`${autopayWalletBalance.balance} ${autopayWalletBalance.symbol}`}
                  </span>
                </>
              )}
            </div>
            {autopayWalletBalanceError && <p className="form-error">{autopayWalletBalanceError}</p>}
          </>
        ) : (
          <p className="muted">No payer wallet is available for this login.</p>
        )}
      </CardSection>

      <CardSection
        title="Deposit History"
        actions={
          <button
            className="icon-button plain"
            type="button"
            aria-label="Refresh deposit history"
            disabled={isBusy}
            onClick={loadDeposits}
          >
            <RefreshIcon />
          </button>
        }
      >
        {deposits.length ? (
          <div className="deposit-list">
            {deposits.map((item) => (
              <div className="deposit-item" key={item.id}>
                <div className="deposit-left">
                  <div className="deposit-top">
                    <div className="deposit-coin-icon">U</div>
                    <div className="deposit-main">
                      <div className="deposit-amount">{item.amount} {item.currency}</div>
                      <div className={`deposit-status ${item.status}`}>{item.status}</div>
                    </div>
                    {item.settled_at && (
                      <span className="deposit-time">
                        {formatDateTime(item.settled_at)}
                      </span>
                    )}
                  </div>
                  <div className="deposit-bottom">
                    <span className="deposit-network">Base</span>
                    {item.payer_address && (
                      <span className="deposit-address">{shortAddress(item.payer_address)}</span>
                    )}
                  </div>
                </div>
                <div className="deposit-right">
                  {item.tx_hash && (
                    <a
                      className="icon-button open-link"
                      href={`https://basescan.org/tx/${item.tx_hash}`}
                      target="_blank"
                      rel="noreferrer"
                      aria-label="View transaction"
                    >
                      <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">
                        <path d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" stroke="currentColor" strokeWidth="2" fill="none" strokeLinecap="round" strokeLinejoin="round"/>
                      </svg>
                    </a>
                  )}
                </div>
              </div>
            ))}
          </div>
        ) : (
          <p className="muted">No deposits yet. Add a deposit to get started.</p>
        )}
      </CardSection>

      {editEndpointOpen && (
        <Modal open={editEndpointOpen} onClose={closeEditEndpointDialog} title="Edit Autopay Endpoint" titleId="edit-endpoint-title">
          <div className="dialog-form">
            <label>
              <span>Endpoint URL</span>
              <input value={autopayUrl} autoComplete="url" onChange={(event) => setAutopayUrl(event.target.value)} />
            </label>
          </div>
          <div className="dialog-actions">
            <button type="button" className="secondary" onClick={closeEditEndpointDialog}>Cancel</button>
            <button type="button" className="primary" disabled={isBusy || !autopayUrl.trim()} onClick={updateAutopayEndpoint}>Save</button>
          </div>
        </Modal>
      )}

      {depositDialogOpen && (
        <DepositDialog
          open={depositDialogOpen}
          onClose={closeDepositDialog}
          request={request}
          withBusy={withBusy}
          isBusy={isBusy}
          show={show}
          identity={identity}
          autopayUrl={account?.autopay_url || autopayUrl}
          setNewApiKey={setNewApiKey}
          waitForAutopayAuthorization={waitForAutopayAuthorization}
          loadAccount={loadAccount}
        />
      )}

      {paymentDialog && (
        <Modal
          open={!!paymentDialog}
          onClose={closePaymentDialog}
          title="Pay Deposit"
          subtitle="Scan with your wallet app or open the link on this device."
          className="payment-modal"
          titleId="payment-title"
        >
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
                  <button type="button" className="secondary" onClick={closePaymentDialog}>Close</button>
                )}
              </div>
            </div>
          </div>
        </Modal>
      )}
    </>
  );
}
