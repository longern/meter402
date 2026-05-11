import { useState, useEffect } from "react";
import QRCode from "qrcode";
import Modal from "./Modal";

function hasEthereumBrowser() {
  return typeof window !== "undefined" && Boolean(window.ethereum);
}

function readableErrorFromError(error) {
  if (error instanceof Error && error.message) return error.message;
  if (error?.message) return error.message;
  if (typeof error === "string") return error;
  try {
    const json = JSON.stringify(error, null, 2);
    return json && json !== "{}" ? json : "Request failed.";
  } catch {
    return "Request failed.";
  }
}

function encodeUsdcTransfer(recipient, amount) {
  const cleanRecipient = recipient.replace(/^0x/, "").toLowerCase().padStart(64, "0");
  const amountHex = BigInt(amount).toString(16).padStart(64, "0");
  return `0xa9059cbb${cleanRecipient}${amountHex}`;
}

// Wallet deep link builders
function buildCoinbaseWalletLink(url) {
  return `https://go.cb-w.com/dapp?cb_url=${encodeURIComponent(url)}`;
}
function buildOkxWalletLink(url) {
  const deepLink = `okx://wallet/dapp/url?dappUrl=${encodeURIComponent(url)}`;
  return `https://web3.okx.com/download?deeplink=${encodeURIComponent(deepLink)}`;
}
function buildMetaMaskLink(url) {
  return `https://metamask.app.link/dapp/${encodeURIComponent(url)}`;
}
function buildRainbowLink(url) {
  return `https://rnbwapp.com/${encodeURIComponent(url)}`;
}
function buildTrustWalletLink(url) {
  return `https://link.trustwallet.com/open_url?coin_id=60&url=${encodeURIComponent(url)}`;
}

function buildPayDepositUrl(quote) {
  return `${window.location.origin}/pay-deposit?i=${encodeURIComponent(quote.intent_token)}`;
}

function paymentCurrencyFromAccept(accept) {
  return accept?.extra?.currency || "USDC";
}

export default function DepositDialog({
  open,
  onClose,
  request,
  withBusy,
  isBusy,
  show,
  identity,
  autopayUrl,
  setNewApiKey,
  waitForAutopayAuthorization,
  loadAccount,
}) {
  const [amount, setAmount] = useState("5.00");
  const [phase, setPhase] = useState("input"); // 'input' | 'creating' | 'waiting' | 'success'
  const [qrUrl, setQrUrl] = useState("");
  const [paymentUrl, setPaymentUrl] = useState("");
  const [paymentId, setPaymentId] = useState("");
  const [autopayState, setAutopayState] = useState("");
  const [websocketUrl, setWebsocketUrl] = useState("");
  const [error, setError] = useState("");
  const [paymentCurrency, setPaymentCurrency] = useState("USDC");

  useEffect(() => {
    if (open) {
      setPhase("input");
      setQrUrl("");
      setPaymentUrl("");
      setPaymentId("");
      setAutopayState("");
      setWebsocketUrl("");
      setError("");
      setPaymentCurrency("USDC");
    }
  }, [open]);

  // When returning from wallet browser, immediately check status
  useEffect(() => {
    function handleVisibilityChange() {
      if (document.visibilityState === "visible" && phase === "waiting" && paymentId && autopayState) {
        checkStatus();
      }
    }
    document.addEventListener("visibilitychange", handleVisibilityChange);
    return () => document.removeEventListener("visibilitychange", handleVisibilityChange);
  }, [phase, paymentId, autopayState]);

  async function checkStatus() {
    // After user returns from wallet browser, refresh account to see if deposit was made
    if (!paymentId) return;
    try {
      await loadAccount();
      onClose();
    } catch (e) {
      console.error("Refresh failed", e);
    }
  }

  async function payWithBrowserWallet() {
    await withBusy("directPayment", async () => {
      const quote = await request("/api/deposits/quote", {
        method: "POST",
        body: JSON.stringify({
          amount: amount.trim(),
          autopay_url: autopayUrl?.trim() || undefined,
        }),
      });
      const pid = quote.payment_id;
      const qToken = quote.quote_token;
      const accept = quote.payment_requirement?.accepts?.[0];
      if (!accept) throw new Error("Invalid payment requirement from server.");
      const currency = paymentCurrencyFromAccept(accept);
      setPaymentCurrency(currency);

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

      const auth = quote.authorization;
      if (!auth) throw new Error("Missing authorization data from server.");

      // Construct EIP-712 typed data for the selected token transferWithAuthorization
      const typedData = {
        types: {
          TransferWithAuthorization: [
            { name: "from", type: "address" },
            { name: "to", type: "address" },
            { name: "value", type: "uint256" },
            { name: "validAfter", type: "uint256" },
            { name: "validBefore", type: "uint256" },
            { name: "nonce", type: "bytes32" },
          ],
          EIP712Domain: [
            { name: "name", type: "string" },
            { name: "version", type: "string" },
            { name: "chainId", type: "uint256" },
            { name: "verifyingContract", type: "address" },
          ],
        },
        domain: {
          name: accept.extra?.name ?? "USD Coin",
          version: accept.extra?.version ?? "2",
          chainId: parseInt(accept.network?.replace("eip155:", "") ?? "8453"),
          verifyingContract: accept.asset,
        },
        primaryType: "TransferWithAuthorization",
        message: {
          from,
          to: auth.to,
          value: auth.value,
          validAfter: auth.valid_after,
          validBefore: auth.valid_before,
          nonce: auth.nonce,
        },
      };

      const signature = await window.ethereum.request({
        method: "eth_signTypedData_v4",
        params: [from, JSON.stringify(typedData)],
      });

      // Construct x402 payload (v2 format) — mirror DepositDialog exactly
      const x402Payload = {
        x402Version: 2,
        accepted: accept,
        payload: {
          signature,
          authorization: {
            from,
            to: auth.to,
            value: auth.value,
            validAfter: auth.valid_after,
            validBefore: auth.valid_before,
            nonce: auth.nonce,
          },
        },
      };

      let settleJson;
      try {
        settleJson = await request("/api/deposits/settle", {
          method: "POST",
          body: JSON.stringify({
            payment_id: pid,
            quote_token: qToken,
            payment_payload: x402Payload,
          }),
        });
      } catch (e) {
        setError(readableErrorFromError(e) || "Payment settlement failed.");
        throw e;
      }
      if (settleJson.api_key) setNewApiKey(settleJson.api_key);
      show(settleJson);
      await loadAccount();
      onClose();
    });
  }

  async function startWalletPayment() {
    await withBusy("walletPayment", async () => {
      setError("");
      setPhase("creating");

      try {
        const quote = await request("/api/deposits/quote", {
          method: "POST",
          body: JSON.stringify({
            amount: amount.trim(),
            autopay_url: autopayUrl?.trim() || undefined,
          }),
        });
        setPaymentCurrency(
          paymentCurrencyFromAccept(quote.payment_requirement?.accepts?.[0]),
        );

        const payUrl = buildPayDepositUrl(quote);
        setPaymentId(quote.payment_id);

        const qr = await QRCode.toDataURL(payUrl, {
          margin: 1,
          scale: 8,
          color: { dark: "#111827", light: "#ffffff" },
        });

        setQrUrl(qr);
        setPaymentUrl(payUrl);
        setPhase("waiting");
      } catch (e) {
        const message = readableErrorFromError(e) || "Payment preparation failed.";
        console.error("Failed to prepare wallet payment", e);
        setError(message);
        setPhase("input");
        throw e;
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
    <Modal open={open} onClose={onClose} title="Add Deposit" titleId="deposit-title">
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
            <span className="input-suffix">{paymentCurrency}</span>
          </div>
        </label>
      </div>

      <div className="deposit-payment-area">
        {phase === "input" && (
          <>
            {hasEthereumBrowser() ? (
              <button disabled={isBusy} className="primary" onClick={payWithBrowserWallet}>
                Pay {amount} {paymentCurrency}
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
            {/* Desktop: QR code to pay-deposit page */}
            <div className="qr-desktop">
              {qrUrl ? (
                <img src={qrUrl} alt="Scan to pay deposit" className="qr-image" />
              ) : (
                <p className="muted">Generating QR code...</p>
              )}
              <p className="muted">Scan with your wallet app to sign and pay</p>
            </div>

            {/* Mobile: Wallet deeplink buttons to pay-deposit page */}
            <div className="qr-mobile">
              <p className="muted" style={{ marginBottom: 12 }}>Open in wallet app:</p>
              <div className="wallet-deeplink-actions">
                <a
                  className="wallet-icon-link"
                  href={paymentUrl ? buildMetaMaskLink(paymentUrl) : undefined}
                  aria-disabled={!paymentUrl}
                  aria-label="Open in MetaMask"
                  onClick={(e) => { if (!paymentUrl) e.preventDefault(); }}
                >
                  <img src="/wallet-icons/metamask.svg" alt="MetaMask" />
                </a>
                <a
                  className="wallet-icon-link"
                  href={paymentUrl ? buildCoinbaseWalletLink(paymentUrl) : undefined}
                  aria-disabled={!paymentUrl}
                  aria-label="Open in Coinbase Wallet"
                  onClick={(e) => { if (!paymentUrl) e.preventDefault(); }}
                >
                  <img src="/wallet-icons/coinbase-wallet.svg" alt="Coinbase Wallet" />
                </a>
                <a
                  className="wallet-icon-link"
                  href={paymentUrl ? buildOkxWalletLink(paymentUrl) : undefined}
                  aria-disabled={!paymentUrl}
                  aria-label="Open in OKX Wallet"
                  onClick={(e) => { if (!paymentUrl) e.preventDefault(); }}
                >
                  <img src="/wallet-icons/okx-wallet.svg" alt="OKX Wallet" />
                </a>
                <a
                  className="wallet-icon-link"
                  href={paymentUrl ? buildRainbowLink(paymentUrl) : undefined}
                  aria-disabled={!paymentUrl}
                  aria-label="Open in Rainbow"
                  onClick={(e) => { if (!paymentUrl) e.preventDefault(); }}
                >
                  <img src="/wallet-icons/rainbow.svg" alt="Rainbow" />
                </a>
                <a
                  className="wallet-icon-link"
                  href={paymentUrl ? buildTrustWalletLink(paymentUrl) : undefined}
                  aria-disabled={!paymentUrl}
                  aria-label="Open in Trust Wallet"
                  onClick={(e) => { if (!paymentUrl) e.preventDefault(); }}
                >
                  <img src="/wallet-icons/trust-wallet.svg" alt="Trust Wallet" />
                </a>
              </div>
            </div>

            <p className="muted" style={{ marginTop: 12 }}>
              After signing in your wallet, your deposit will be submitted automatically.
            </p>
            <button
              disabled={isBusy}
              className="secondary"
              style={{ marginTop: 8 }}
              onClick={checkStatus}
            >
              I&apos;ve paid — Refresh
            </button>
          </>
        )}

        {error && <p className="form-error">{error}</p>}
      </div>
    </Modal>
  );
}
