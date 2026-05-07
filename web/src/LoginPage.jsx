import React, { useEffect, useRef, useState } from "react";
import QRCode from "qrcode";
import {
  buildCoinbaseWalletLink,
  buildOkxWalletLink,
  readableError,
} from "./utils";

const LOGIN_SUCCESS_REDIRECT_DELAY_MS = 500;

export function LoginPage({ returnTo = "", onSessionChange = () => {} }) {
  const [hasWallet, setHasWallet] = useState(false);
  const [walletChecked, setWalletChecked] = useState(false);
  const [isMobile, setIsMobile] = useState(false);
  const [scan, setScan] = useState(null);
  const [verificationQr, setVerificationQr] = useState("");
  const [identity, setIdentity] = useState(null);
  const [status, setStatus] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [authExpired, setAuthExpired] = useState(false);
  const loginSocketRef = useRef(null);
  const scanAttemptRef = useRef(0);

  useEffect(() => {
    setIsMobile(isMobileBrowser());
    let attempts = 0;
    const timer = window.setInterval(() => {
      attempts += 1;
      if (window.ethereum || attempts >= 20) {
        setHasWallet(Boolean(window.ethereum));
        setWalletChecked(true);
        window.clearInterval(timer);
      }
    }, 100);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    if (!walletChecked || hasWallet) return undefined;
    startScanLogin();
    return () => closeLoginSocket();
  }, [hasWallet, walletChecked]);

  async function startDirectLogin() {
    setBusy(true);
    setError("");
    setStatus("Waiting for wallet signature...");
    try {
      const completed = await signLoginWithWallet("/api/login/challenge", "/api/login/complete");
      finishLogin(completed);
    } catch (error) {
      const message = readableError(error);
      setError(message);
      setStatus(message);
    } finally {
      setBusy(false);
    }
  }

  async function startScanLogin() {
    const attempt = ++scanAttemptRef.current;
    closeLoginSocket();
    setBusy(true);
    setError("");
    setAuthExpired(false);
    setStatus("Preparing login...");
    setVerificationQr("");
    try {
      const started = await fetchJson("/api/login/scan/start", { method: "POST" });
      if (scanAttemptRef.current !== attempt) return;
      setScan(started);
      const qr = await QRCode.toDataURL(started.verification_uri_complete, {
        margin: 1,
        scale: 8,
        color: { dark: "#111827", light: "#ffffff" },
      });
      if (scanAttemptRef.current !== attempt) return;
      setVerificationQr(qr);
      setStatus("Waiting for wallet signature...");
      waitForScanLogin(started, attempt);
    } catch (error) {
      if (scanAttemptRef.current !== attempt) return;
      const message = readableError(error);
      setError(message);
      setStatus(message);
    } finally {
      if (scanAttemptRef.current === attempt) setBusy(false);
    }
  }

  function waitForScanLogin(started, attempt) {
    const socket = new WebSocket(started.websocket_uri_complete);
    loginSocketRef.current = socket;
    socket.onmessage = (event) => {
      if (scanAttemptRef.current !== attempt) return;
      const message = parseSocketMessage(event.data);
      setScan((current) => current ? { ...current, ...message } : current);
      if (message.status === "scanned") {
        setStatus("Wallet page opened. Waiting for signature...");
        return;
      }
      if (message.status === "signing") {
        setStatus("Wallet opened. Confirm the signature there.");
        return;
      }
      if (message.status === "approved") {
        socket.close();
        completeScanLogin(started.request_id, attempt);
        return;
      }
      if (message.status === "denied") {
        socket.close();
        setError("Login denied.");
        setStatus("Login denied.");
        return;
      }
      if (message.status === "expired") {
        socket.close();
        setAuthExpired(true);
        setStatus("QR code expired.");
      }
    };
    socket.onerror = () => {
      if (scanAttemptRef.current === attempt) setStatus("Login connection interrupted.");
    };
  }

  async function completeScanLogin(requestId, attempt) {
    try {
      const completed = await fetchJson(`/api/login/scan/${encodeURIComponent(requestId)}/complete`, {
        method: "POST",
      });
      if (scanAttemptRef.current !== attempt) return;
      if (completed.status === "approved") finishLogin(completed);
    } catch (error) {
      if (scanAttemptRef.current !== attempt) return;
      const message = readableError(error);
      setError(message);
      setStatus(message);
    }
  }

  function finishLogin(completed) {
    const nextIdentity = {
      owner: completed.owner,
      autopay_url: completed.autopay_url,
      expires_at: completed.expires_at,
    };
    setIdentity(nextIdentity);
    onSessionChange(nextIdentity);
    setStatus("Signed in.");
    window.setTimeout(() => {
      window.location.assign(returnTo || "/console");
    }, LOGIN_SUCCESS_REDIRECT_DELAY_MS);
  }

  function closeLoginSocket() {
    if (loginSocketRef.current) {
      loginSocketRef.current.close();
      loginSocketRef.current = null;
    }
  }

  const verificationUrl = scan?.verification_uri_complete || "";
  const scanStatus = scan?.status || "pending";
  const isWalletOpen = scanStatus === "scanned" || scanStatus === "signing";

  return (
    <main className="login-main">
      <nav className="compact-nav">
        <a className="brand" href="/">Meteria402</a>
        <a href="/">Home</a>
      </nav>

      <section className="login-panel">
        <div className="login-heading">
          <h1>Sign in</h1>
          <p>Use your wallet</p>
        </div>

        <div className="login-step-viewport">
          <div className="login-step-card forward">
            <div className="login-authorization">
              {hasWallet ? (
                <div className="login-direct">
                  <h2>Wallet detected</h2>
                  <p>Sign with your wallet to open the console.</p>
                  {error && <p className="login-error" role="alert">{error}</p>}
                  <div className="login-actions">
                    <button className="primary" type="button" disabled={busy} onClick={startDirectLogin}>
                      {busy ? "Signing..." : "Sign in"}
                    </button>
                  </div>
                </div>
              ) : (
                <>
                  <div className="login-authorization-header">
                    <h2>
                      <span className="desktop-login-title">Scan with your wallet</span>
                      <span className="mobile-login-title">Open in wallet</span>
                    </h2>
                  </div>

                  {!isMobile && (
                    <div className="login-approval-option login-scan-option">
                      {authExpired ? (
                        <button className="login-qr-expired" type="button" onClick={startScanLogin} disabled={busy}>
                          <span aria-hidden="true" />
                          <strong>QR expired</strong>
                          <small>{busy ? "Refreshing..." : "Click to refresh"}</small>
                        </button>
                      ) : isWalletOpen ? (
                        <div className="login-scan-active" role="status">
                          <span aria-hidden="true" />
                          <strong>Wallet opened</strong>
                          <small>{scanStatus === "signing" ? "Confirm the signature in your wallet." : "Waiting for signature."}</small>
                        </div>
                      ) : verificationQr ? (
                        <img src={verificationQr} alt="Wallet login QR code" />
                      ) : (
                        <div className="login-qr-placeholder" aria-label="Preparing login" />
                      )}
                    </div>
                  )}

                  {isMobile && (
                    <div className="login-mobile-approval">
                      <div className="wallet-deeplink-actions" aria-label="Open in wallet app">
                        <a className="wallet-icon-link" href={verificationUrl ? buildCoinbaseWalletLink(verificationUrl) : undefined} aria-disabled={!verificationUrl} aria-label="Open in Coinbase Wallet">
                          <img src="/wallet-icons/coinbase-wallet.svg" alt="" />
                        </a>
                        <a className="wallet-icon-link" href={verificationUrl ? buildOkxWalletLink(verificationUrl) : undefined} aria-disabled={!verificationUrl} aria-label="Open in OKX Wallet">
                          <img src="/wallet-icons/okx-wallet.svg" alt="" />
                        </a>
                      </div>
                    </div>
                  )}

                  {error && <p className="login-error" role="alert">{error}</p>}
                  {status && !error && <p className="status-line">{status}</p>}
                  <div className="login-actions login-authorize-actions">
                    <button className="secondary" type="button" onClick={startScanLogin} disabled={busy}>
                      Refresh
                    </button>
                  </div>
                </>
              )}

              {identity && (
                <div className="login-complete">
                  <h2>Signed in</h2>
                  <dl>
                    <dt>Owner</dt>
                    <dd>{identity.owner}</dd>
                  </dl>
                </div>
              )}
            </div>
          </div>
        </div>
      </section>
    </main>
  );
}

export function WalletLoginPage({ onSessionChange = () => {} }) {
  const requestId = new URLSearchParams(window.location.search).get("request_id") || "";
  const [hasWallet, setHasWallet] = useState(Boolean(window.ethereum));
  const [status, setStatus] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [identity, setIdentity] = useState(null);

  useEffect(() => {
    let attempts = 0;
    const timer = window.setInterval(() => {
      attempts += 1;
      if (window.ethereum || attempts >= 20) {
        setHasWallet(Boolean(window.ethereum));
        window.clearInterval(timer);
      }
    }, 100);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    if (!requestId) return;
    let cancelled = false;
    fetchJson(`/api/login/scan/${encodeURIComponent(requestId)}/details`)
      .then((details) => {
        if (!cancelled && details.status === "expired") {
          setError("Login request expired.");
          setStatus("Login request expired.");
        }
      })
      .catch((error) => {
        if (!cancelled) {
          const message = readableError(error);
          setError(message);
          setStatus(message);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [requestId]);

  async function approve() {
    if (!requestId) {
      setError("Login request is missing.");
      return;
    }
    setBusy(true);
    setError("");
    setStatus("Waiting for wallet signature...");
    try {
      const completed = await signLoginWithWallet(
        `/api/login/scan/${encodeURIComponent(requestId)}/challenge`,
        `/api/login/scan/${encodeURIComponent(requestId)}/approve`,
      );
      const nextIdentity = {
        owner: completed.owner,
        autopay_url: completed.autopay_url,
        expires_at: completed.expires_at,
      };
      setIdentity(nextIdentity);
      onSessionChange(nextIdentity);
      setStatus("Signed in.");
    } catch (error) {
      const message = readableError(error);
      setError(message);
      setStatus(message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="login-main">
      <nav className="compact-nav">
        <a className="brand" href="/">Meteria402</a>
        <a href="/login">Login</a>
      </nav>
      <section className="login-panel">
        <div className="login-heading">
          <div className="wallet-login-site">
            <img src="/logo-transparent.png" alt="" />
            <div>
              <strong>Meteria402</strong>
              <span>{window.location.host}</span>
            </div>
          </div>
          <h1>Wallet login</h1>
          <p>Sign in to the main site</p>
        </div>
        <div className="login-step-viewport">
          <div className="login-step-card forward">
            <div className="login-direct">
              <div className="wallet-login-safety" aria-label="Security reminder">
                <strong>Security check</strong>
                <ul>
                  <li>Confirm that this sign-in was initiated by you.</li>
                  <li>Do not scan QR codes from people or sites you do not trust.</li>
                  <li>Only sign if your wallet shows {window.location.host}.</li>
                </ul>
              </div>
              {error && <p className="login-error" role="alert">{error}</p>}
              {status && !error && <p className="status-line">{status}</p>}
              {!hasWallet && (
                <div className="wallet-deeplink-actions wallet-page-links" aria-label="Open in wallet app">
                  <a className="wallet-icon-link" href={buildCoinbaseWalletLink(window.location.href)} aria-label="Open in Coinbase Wallet">
                    <img src="/wallet-icons/coinbase-wallet.svg" alt="" />
                  </a>
                  <a className="wallet-icon-link" href={buildOkxWalletLink(window.location.href)} aria-label="Open in OKX Wallet">
                    <img src="/wallet-icons/okx-wallet.svg" alt="" />
                  </a>
                </div>
              )}
              {hasWallet && (
                <div className="login-actions">
                  <button className="primary" type="button" disabled={busy || !requestId} onClick={approve}>
                    {busy ? "Signing..." : "Sign in"}
                  </button>
                </div>
              )}
              {identity && (
                <dl className="login-result">
                  <dt>Owner</dt>
                  <dd>{identity.owner}</dd>
                </dl>
              )}
            </div>
          </div>
        </div>
      </section>
    </main>
  );
}

async function fetchJson(path, options = {}) {
  const response = await fetch(path, options);
  const text = await response.text();
  const json = text ? JSON.parse(text) : null;
  if (!response.ok) throw json || new Error(`Request failed with HTTP ${response.status}`);
  return json;
}

function parseSocketMessage(data) {
  if (typeof data !== "string") {
    throw new Error("Unexpected WebSocket message.");
  }
  return JSON.parse(data);
}

async function signLoginWithWallet(challengePath, completePath) {
  const provider = window.ethereum;
  if (!provider) throw new Error("Open this page in an Ethereum wallet browser.");
  const accounts = await provider.request({ method: "eth_requestAccounts" });
  const address = accounts?.[0];
  if (!address) throw new Error("No wallet account selected.");
  const challenge = await fetchJson(challengePath, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ address }),
  });
  const signature = await signPersonalMessage(provider, address, challenge.message);
  return await fetchJson(completePath, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      challenge_token: challenge.challenge_token,
      message: challenge.message,
      signature,
    }),
  });
}

async function signPersonalMessage(provider, address, message) {
  try {
    return await provider.request({ method: "personal_sign", params: [message, address] });
  } catch (error) {
    if (isPersonalSignOrderError(error)) {
      return await provider.request({ method: "personal_sign", params: [address, message] });
    }
    throw error;
  }
}

function isPersonalSignOrderError(error) {
  const message = String(error?.message || error || "").toLowerCase();
  return message.includes("invalid") && message.includes("address");
}

function isMobileBrowser() {
  return /android|iphone|ipad|ipod|mobile/i.test(navigator.userAgent || "");
}
