import React, { useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import "./styles.css";

const requestId = new URLSearchParams(window.location.search).get("request_id") || "";

function App() {
  const [authRequest, setAuthRequest] = useState(null);
  const [allowedOwners, setAllowedOwners] = useState([]);
  const [ownerAddress, setOwnerAddress] = useState("");
  const [activeProvider, setActiveProvider] = useState(null);
  const [walletStatus, setWalletStatus] = useState("");
  const [result, setResult] = useState("");
  const [busy, setBusy] = useState(false);

  const ownerAllowed = useMemo(() => {
    if (!ownerAddress || allowedOwners.length === 0) return true;
    const owner = ownerAddress.toLowerCase();
    return allowedOwners.map((item) => item.toLowerCase()).includes(owner);
  }, [allowedOwners, ownerAddress]);

  useEffect(() => {
    init().catch(showError);

    async function init() {
      if (!requestId) return;
      const [details, capabilities] = await Promise.all([
        fetchJson(`/api/auth/requests/${encodeURIComponent(requestId)}`),
        fetchJson("/api/capabilities"),
      ]);
      setAuthRequest(details);
      setAllowedOwners(capabilities.allowed_owner_addresses || []);
      setWalletStatus("Connect an owner wallet to continue.");
      autoConnectWallet();
    }
  }, []);

  useEffect(() => {
    if (!authRequest) return;
    if (!ownerAddress) {
      setWalletStatus("Connect an owner wallet to continue.");
      return;
    }
    setWalletStatus(ownerAllowed
      ? "Connected wallet is allowed to sign."
      : "Connected wallet is not allowed to authorize this worker.");
  }, [authRequest, ownerAddress, ownerAllowed]);

  async function loadWalletAuth() {
    return await import("./walletAuth.js");
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
      const { checksumAddress } = await loadWalletAuth();
      setOwnerAddress(accounts[0] ? checksumAddress(accounts[0]) : "");
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

      setResult(JSON.stringify(approved, null, 2));
      setWalletStatus("Authorization approved. Return to the requester page.");
    } finally {
      setBusy(false);
    }
  }

  async function denyAuthorization() {
    if (!requestId) return;
    setBusy(true);
    try {
      const denied = await fetchJson(`/api/auth/requests/${encodeURIComponent(requestId)}/deny`, { method: "POST" });
      setResult(JSON.stringify(denied, null, 2));
      setWalletStatus("Authorization denied.");
    } finally {
      setBusy(false);
    }
  }

  function showError(error) {
    const message = error instanceof Error ? error.message : String(error);
    setWalletStatus(message);
    setResult(error instanceof Error ? error.stack || error.message : String(error));
    setBusy(false);
  }

  const policy = authRequest?.policy;
  const canSign = Boolean(authRequest && ownerAddress && ownerAllowed && !busy && !result);

  return (
    <main>
      <header>
        <h1>meter402 Autopay</h1>
        <p>{requestId
          ? "Review and sign an autopay authorization with your owner wallet."
          : "Approve scoped x402 autopay requests with your owner wallet."}</p>
      </header>

      <div className="content">
        {!requestId && (
          <section className="empty">
            <h2>Autopay Authorization</h2>
            <p>Use this page to approve scoped x402 autopay requests with your owner wallet. Start from a payment requester QR code or authorization link.</p>
          </section>
        )}

        {policy && (
          <section>
            <h2>Request</h2>
            <dl>
              <dt>Status</dt><dd>{authRequest.status}</dd>
              <dt>Expires</dt><dd>{authRequest.expires_at}</dd>
              <dt>Network</dt><dd>{policy.network}</dd>
              <dt>Asset</dt><dd>{policy.asset}</dd>
              <dt>Max amount</dt><dd>{policy.maxSingleAmount}</dd>
              <dt>Policy valid before</dt><dd>{policy.validBefore}</dd>
              <dt>Origins</dt><dd>{policy.allowedOrigins.join(", ")}</dd>
              <dt>Recipients</dt><dd>{policy.allowedPayTo.join(", ")}</dd>
              <dt>Payment hash</dt><dd>{authRequest.payment_requirement_hash || "Not bound"}</dd>
            </dl>
          </section>
        )}

        {authRequest && (
          <section>
            <h2>Wallet</h2>
            <dl>
              <dt>Owner wallet</dt><dd>{ownerAddress || "Not connected"}</dd>
              <dt>Allowed owners</dt><dd>{allowedOwners.length ? allowedOwners.join(", ") : "Any valid SIWE signer"}</dd>
            </dl>
            <div className="status">{walletStatus}</div>
          </section>
        )}

        {result && (
          <section>
            <h2>Result</h2>
            <textarea readOnly value={result} />
          </section>
        )}
      </div>

      {authRequest && (
        <div className="actions">
          {!ownerAddress && <button disabled={busy} onClick={() => connectWallet().catch(showError)}>Connect</button>}
          {ownerAddress && <button disabled={!canSign} onClick={() => approveAuthorization().catch(showError)}>Sign</button>}
          <button className="danger" disabled={busy || Boolean(result)} onClick={() => denyAuthorization().catch(showError)}>Deny</button>
        </div>
      )}
    </main>
  );
}

async function personalSign(provider, message, address) {
  try {
    return await provider.request({ method: "personal_sign", params: [message, address] });
  } catch {
    return await provider.request({ method: "personal_sign", params: [address, message] });
  }
}

async function fetchJson(url, init) {
  const response = await fetch(url, init);
  const json = await response.json().catch(() => null);
  if (!response.ok) {
    const message = json?.error?.message || `Request failed with HTTP ${response.status}.`;
    throw new Error(message);
  }
  return json;
}

createRoot(document.getElementById("root")).render(<App />);
