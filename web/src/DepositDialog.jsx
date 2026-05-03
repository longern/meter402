import { useState, useEffect } from "react";
import QRCode from "qrcode";

function hasEthereumBrowser() {
  return typeof window !== "undefined" && Boolean(window.ethereum);
}

function encodeUsdcTransfer(recipient, amount) {
  const cleanRecipient = recipient.replace(/^0x/, "").toLowerCase().padStart(64, "0");
  const amountHex = BigInt(amount).toString(16).padStart(64, "0");
  return `0xa9059cbb${cleanRecipient}${amountHex}`;
}

export default function DepositDialog({
  open,
  onClose,
  request,
  withBusy,
  isBusy,
  show,
  identity,
  setNewApiKey,
  waitForAutopayAuthorization,
  loadAccount,
}) {
  const [amount, setAmount] = useState("5.00");
  const [phase, setPhase] = useState("input"); // 'input' | 'creating' | 'waiting' | 'success'
  const [qrUrl, setQrUrl] = useState("");
  const [paymentUrl, setPaymentUrl] = useState("");
  const [paymentId, setPaymentId] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    if (open) {
      setPhase("input");
      setQrUrl("");
      setPaymentUrl("");
      setPaymentId("");
      setError("");
    }
  }, [open]);

  async function payWithBrowserWallet() {
    await withBusy("directPayment", async () => {
      const quote = await request("/api/deposits/quote", {
        method: "POST",
        body: JSON.stringify({ amount: amount.trim() }),
      });
      const pid = quote.payment_id;
      const qToken = quote.quote_token;
      const accept = quote.payment_requirement?.accepts?.[0];
      if (!accept) throw new Error("Invalid payment requirement from server.");

      const tokenAddress = accept.asset;
      const recipient = accept.payTo;
      const value = accept.amount;
      const chainId = "0x2105";

      const accounts = await window.ethereum.request({ method: "eth_requestAccounts" });
      const from = accounts[0];

      try {
        await window.ethereum.request({
          method: "wallet_switchEthereumChain",
          params: [{ chainId }],
        });
      } catch (switchError) {
        if (switchError.code === 4902) {
          await window.ethereum.request({
            method: "wallet_addEthereumChain",
            params: [{
              chainId,
              chainName: "Base",
              rpcUrls: ["https://mainnet.base.org"],
              nativeCurrency: { name: "ETH", symbol: "ETH", decimals: 18 },
              blockExplorerUrls: ["https://basescan.org"],
            }],
          });
        } else {
          throw switchError;
        }
      }

      const data = encodeUsdcTransfer(recipient, value);
      const txHash = await window.ethereum.request({
        method: "eth_sendTransaction",
        params: [{ from, to: tokenAddress, data }],
      });

      const json = await request("/api/deposits/settle", {
        method: "POST",
        body: JSON.stringify({
          payment_id: pid,
          quote_token: qToken,
          tx_hash: txHash,
          owner_address: from,
          autopay_url: identity?.autopay_url || undefined,
        }),
      });
      if (json.api_key) setNewApiKey(json.api_key);
      show(json);
      await loadAccount();
      onClose();
    });
  }

  async function startWalletPayment() {
    await withBusy("walletPayment", async () => {
      setError("");
      setPhase("creating");

      const quote = await request("/api/deposits/quote", {
        method: "POST",
        body: JSON.stringify({ amount: amount.trim() }),
      });
      const pid = quote.payment_id;
      const qToken = quote.quote_token;

      setPaymentId(pid);

      const started = await request(`/api/deposits/${encodeURIComponent(pid)}/autopay/start`, {
        method: "POST",
        body: JSON.stringify({
          quote_token: qToken,
          autopay_url: identity?.autopay_url || "",
        }),
      });

      const qr = started.verification_uri_complete
        ? await QRCode.toDataURL(started.verification_uri_complete, {
            margin: 1,
            scale: 8,
            color: { dark: "#111827", light: "#ffffff" },
          })
        : "";

      setQrUrl(qr);
      setPaymentUrl(started.verification_uri_complete || "");
      setPhase("waiting");

      const settled = await waitForAutopayAuthorization(
        `/api/deposits/${encodeURIComponent(pid)}/autopay/complete`,
        { autopay_state: started.autopay_state },
        started.websocket_uri_complete,
      );

      if (settled?.settlement?.api_key) {
        setNewApiKey(settled.settlement.api_key);
      }
      if (settled?.status === "settled") {
        setPhase("success");
        await loadAccount();
        onClose();
      }
    });
  }

  function openWalletDeeplink() {
    if (paymentUrl) {
      window.open(paymentUrl, "_blank");
    }
  }

  if (!open) return null;

  return (
    <div className="modal-layer" role="presentation">
      <button className="modal-scrim" type="button" aria-label="Close deposit dialog" onClick={onClose} />
      <section className="modal-panel" role="dialog" aria-modal="true" aria-labelledby="deposit-title">
        <div className="modal-header">
          <div>
            <h2 id="deposit-title">Add Deposit</h2>
          </div>
          <button className="icon-button modal-close" type="button" aria-label="Close" onClick={onClose}>
            <svg className="close-icon" viewBox="0 0 24 24" aria-hidden="true">
              <path d="M7 7l10 10M17 7L7 17" />
            </svg>
          </button>
        </div>
        <div className="modal-body">
          <div className="grid single">
            <label>
              <span>Deposit amount</span>
              <div className="input-row">
                <input
                  value={amount}
                  inputMode="decimal"
                  onChange={(event) => setAmount(event.target.value)}
                  disabled={phase !== "input"}
                />
                <span className="input-suffix">USDC</span>
              </div>
            </label>
          </div>

          <div className="deposit-payment-area">
            {phase === "input" && (
              <>
                {hasEthereumBrowser() ? (
                  <button disabled={isBusy} className="primary" onClick={payWithBrowserWallet}>
                    Pay {amount} USDC
                  </button>
                ) : (
                  <button disabled={isBusy} className="primary" onClick={startWalletPayment}>
                    Pay with wallet
                  </button>
                )}
              </>
            )}

            {phase === "creating" && (
              <p className="muted">Preparing payment...</p>
            )}

            {phase === "waiting" && (
              <>
                {/* Desktop: QR code */}
                <div className="qr-desktop">
                  {qrUrl ? (
                    <img src={qrUrl} alt="Scan to pay" className="qr-image" />
                  ) : (
                    <p className="muted">Generating QR code...</p>
                  )}
                  <p className="muted">Scan with your wallet app</p>
                </div>

                {/* Mobile: Wallet deeplink button */}
                <div className="qr-mobile">
                  <button disabled={isBusy || !paymentUrl} className="wallet-deeplink" onClick={openWalletDeeplink}>
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="wallet-icon">
                      <path d="M20 12V8H6a2 2 0 00-2 2v8a2 2 0 002 2h14v-4" />
                      <path d="M16 12h4v4h-4z" />
                    </svg>
                    Open wallet
                  </button>
                </div>

                <p className="muted" style={{ marginTop: 12 }}>Waiting for signature...</p>
              </>
            )}

            {error && <p className="form-error">{error}</p>}
          </div>
        </div>
      </section>
    </div>
  );
}
