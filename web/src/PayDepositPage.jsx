import { useEffect, useState } from "react";
import CardSection from "./CardSection";

function readableError(error) {
  if (error instanceof Error && error.message) return error.message;
  if (error?.error?.message) return error.error.message;
  if (error?.message) return error.message;
  if (typeof error === "string") return error;
  try {
    const json = JSON.stringify(error, null, 2);
    return json && json !== "{}" ? json : "Request failed.";
  } catch {
    return "Request failed.";
  }
}

async function fetchJson(path, options = {}) {
  const response = await fetch(path, options);
  const text = await response.text();
  const json = text ? JSON.parse(text) : null;
  if (!response.ok) throw json || new Error(`Request failed with HTTP ${response.status}`);
  return json;
}

function shortAddress(value) {
  if (!value || value.length <= 14) return value || "";
  return `${value.slice(0, 6)}...${value.slice(-4)}`;
}

function paymentCurrency(accept) {
  return accept?.extra?.currency || "USDC";
}

function decodeBase64Url(value) {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized.padEnd(
    normalized.length + ((4 - (normalized.length % 4)) % 4),
    "=",
  );
  return atob(padded);
}

function parseQuoteToken(token) {
  const [payload] = token.split(".");
  if (!payload) return null;
  const quote = JSON.parse(decodeBase64Url(payload));
  const accept = quote.payment_requirement?.accepts?.[0];
  const auth = quote.authorization;
  if (!accept || !auth) return null;
  return {
    accept,
    auth: {
      to: accept.payTo,
      v: accept.amount,
      va: auth.valid_after,
      vb: auth.valid_before,
      n: auth.nonce,
    },
  };
}

async function parseUrlData() {
  const params = new URLSearchParams(window.location.search);
  const intent = params.get("i");
  if (intent) {
    const token = decodeURIComponent(intent);
    const expanded = await fetchJson(`/api/deposits/intent?i=${encodeURIComponent(token)}`);
    const accept = expanded.payment_requirement?.accepts?.[0];
    const auth = expanded.authorization;
    if (!expanded.payment_id || !accept || !auth) return null;
    return {
      pid: expanded.payment_id,
      intent: expanded.deposit_intent || token,
      accept,
      auth: {
        to: auth.to,
        v: auth.value,
        va: auth.valid_after,
        vb: auth.valid_before,
        n: auth.nonce,
      },
    };
  }
  const encoded = params.get("d");
  if (!encoded) return null;
  try {
    const json = decodeBase64Url(decodeURIComponent(encoded));
    const data = JSON.parse(json);
    if (data.pid && data.qt && data.auth && data.accept) return data;
    const pid = data.p || data.pid;
    const qt = data.q || data.qt;
    if (!pid || !qt) return null;
    const quoteData = parseQuoteToken(qt);
    if (!quoteData) return null;
    return {
      pid,
      qt,
      ...quoteData,
    };
  } catch {
    return null;
  }
}

export default function PayDepositPage() {
  const [data, setData] = useState(null);
  const [status, setStatus] = useState("loading"); // loading, ready, signing, settling, success, error
  const [error, setError] = useState("");
  const [result, setResult] = useState(null);
  const [debugInfo, setDebugInfo] = useState("");

  useEffect(() => {
    let cancelled = false;
    parseUrlData()
      .then((urlData) => {
        if (cancelled) return;
        if (!urlData || !urlData.pid || (!urlData.qt && !urlData.intent) || !urlData.auth) {
          setStatus("error");
          setError("Invalid or missing payment data in URL. Please go back and try again.");
          return;
        }
        setData(urlData);
        setStatus("ready");
      })
      .catch((e) => {
        if (cancelled) return;
        console.error("Failed to prepare deposit payment", e);
        setStatus("error");
        setError(readableError(e));
      });
    return () => {
      cancelled = true;
    };
  }, []);

  async function startPayment() {
    if (!data) return;

    setStatus("signing");
    setError("");

    try {
      // Check ethereum provider
      if (!window.ethereum) {
        throw new Error("No Ethereum wallet detected. Please open this page in a Web3 browser like MetaMask, Coinbase Wallet, or OKX Wallet.");
      }

      // Request accounts
      const accounts = await window.ethereum.request({ method: "eth_requestAccounts" });
      const from = accounts[0];
      if (!from) {
        throw new Error("No account selected. Please connect your wallet.");
      }

      // Switch to Base network
      const chainId = "0x2105";
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

      const { auth } = data;
      const accept = data.accept;
      const networkId = accept?.network?.replace("eip155:", "") ?? "8453";

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
          name: accept?.extra?.name ?? "USD Coin",
          version: accept?.extra?.version ?? "2",
          chainId: parseInt(networkId),
          verifyingContract: accept?.asset,
        },
        primaryType: "TransferWithAuthorization",
        message: {
          from,
          to: auth.to,
          value: auth.v,
          validAfter: auth.va,
          validBefore: auth.vb,
          nonce: auth.n,
        },
      };

      setDebugInfo(`Requesting EIP-712 signature from ${shortAddress(from)}...`);

      // Request signature
      const signature = await window.ethereum.request({
        method: "eth_signTypedData_v4",
        params: [from, JSON.stringify(typedData)],
      });

      setDebugInfo("Signature received. Submitting settlement...");

      // Construct x402 payload (v2 format) — mirror DepositDialog exactly
      const x402Payload = {
        x402Version: 2,
        accepted: accept,
        payload: {
          signature,
          authorization: {
            from,
            to: auth.to,
            value: auth.v,
            validAfter: auth.va,
            validBefore: auth.vb,
            nonce: auth.n,
          },
        },
      };

      setStatus("settling");

      // Submit settlement
      const settleJson = await fetchJson("/api/deposits/settle", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          payment_id: data.pid,
          ...(data.intent ? { deposit_intent: data.intent } : { quote_token: data.qt }),
          payment_payload: x402Payload,
          owner_address: from,
        }),
      });

      setResult(settleJson);
      setStatus("success");
    } catch (e) {
      console.error("Payment failed:", e);
      setError(readableError(e));
      setStatus("error");
    }
  }

  function goToConsole() {
    window.location.href = "/console";
  }

  function goHome() {
    window.location.href = "/";
  }

  if (status === "loading") {
    return (
      <div className="pay-deposit-page">
        <nav className="compact-nav">
          <a className="brand" href="/">Meteria402</a>
        </nav>
        <main className="pay-deposit-main">
          <CardSection title="Loading...">
            <p className="muted">Preparing payment...</p>
          </CardSection>
        </main>
      </div>
    );
  }

  if (status === "error" && !data) {
    return (
      <div className="pay-deposit-page">
        <nav className="compact-nav">
          <a className="brand" href="/">Meteria402</a>
        </nav>
        <main className="pay-deposit-main">
          <CardSection title="Invalid Payment Link">
            <p className="form-error">{error}</p>
            <div className="pay-deposit-actions" style={{ marginTop: 24 }}>
              <button onClick={goHome}>Go Home</button>
            </div>
          </CardSection>
        </main>
      </div>
    );
  }

  const amount = data ? (Number(data.auth?.v) / 1e6).toFixed(2) : "0.00";
  const currency = paymentCurrency(data?.accept);

  return (
    <div className="pay-deposit-page">
      <nav className="compact-nav">
        <a className="brand" href="/">
          <img src="/logo-transparent.png" alt="" className="brand-icon" />
          Meteria402
        </a>
      </nav>

      <main className="pay-deposit-main">
        {status === "ready" && (
          <CardSection title="Confirm Deposit">
            <div className="pay-deposit-summary">
              <div className="data-row">
                <span>Amount</span>
                <strong>{amount} {currency}</strong>
              </div>
              <div className="data-row">
                <span>Network</span>
                <span>Base</span>
              </div>
              {data?.accept?.asset && (
                <div className="data-row">
                  <span>Token</span>
                  <span className="mono">{shortAddress(data.accept.asset)}</span>
                </div>
              )}
            </div>

            <p className="muted" style={{ marginTop: 16 }}>
              Click below to sign the payment authorization with your wallet.
              This will create an EIP-712 signature that authorizes the {currency} transfer.
            </p>

            {error && <p className="form-error" style={{ marginTop: 12 }}>{error}</p>}

            <div className="pay-deposit-actions">
              <button className="primary" onClick={startPayment}>
                Sign & Pay {amount} {currency}
              </button>
              <button className="text-button" onClick={goHome}>
                Cancel
              </button>
            </div>
          </CardSection>
        )}

        {(status === "signing" || status === "settling") && (
          <CardSection title="Processing Payment...">
            <div className="pay-deposit-processing">
              <div className="spinner" />
              <p className="muted">
                {status === "signing" ? "Waiting for wallet signature..." : "Submitting to server..."}
              </p>
              {debugInfo && <p className="muted small">{debugInfo}</p>}
            </div>
            <p className="muted small" style={{ marginTop: 16 }}>
              Please confirm the transaction in your wallet if prompted.
            </p>
          </CardSection>
        )}

        {status === "success" && result && (
          <CardSection title="Payment Successful!">
            <div className="pay-deposit-success">
              <div className="success-icon">✓</div>
              <p>Your deposit of <strong>{amount} {currency}</strong> has been received.</p>

              {result.api_key && (
                <div className="api-key-box" style={{ marginTop: 16 }}>
                  <p><strong>Your API Key (save this now - it won&apos;t be shown again):</strong></p>
                  <code className="mono" style={{ 
                    display: "block", 
                    padding: 12, 
                    background: "#f3f4f6", 
                    borderRadius: 8,
                    marginTop: 8,
                    wordBreak: "break-all"
                  }}>
                    {result.api_key}
                  </code>
                </div>
              )}

              <div className="pay-deposit-summary" style={{ marginTop: 16 }}>
                <div className="data-row">
                  <span>Account ID</span>
                  <span className="mono">{result.account_id}</span>
                </div>
                <div className="data-row">
                  <span>Deposit Balance</span>
                  <strong>{result.deposit_balance} {currency}</strong>
                </div>
              </div>
            </div>

            <div className="pay-deposit-actions" style={{ marginTop: 24 }}>
              <button className="primary" onClick={goToConsole}>
                Open Console
              </button>
              <button className="text-button" onClick={goHome}>
                Go Home
              </button>
            </div>
          </CardSection>
        )}

        {status === "error" && error && (
          <CardSection title="Payment Failed">
            <p className="form-error">{error}</p>
            {debugInfo && <p className="muted small" style={{ marginTop: 8 }}>{debugInfo}</p>}
            <div className="pay-deposit-actions" style={{ marginTop: 24 }}>
              <button onClick={() => setStatus("ready")}>Try Again</button>
              <button className="text-button" onClick={goHome}>
                Go Home
              </button>
            </div>
          </CardSection>
        )}
      </main>
    </div>
  );
}
