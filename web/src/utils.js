export function readableError(error) {
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

export function shortAddress(value) {
  if (!value || value.length <= 14) return value || "";
  return `${value.slice(0, 6)}...${value.slice(-4)}`;
}

export function shortId(value) {
  if (!value || value.length <= 16) return value || "";
  return `${value.slice(0, 8)}...${value.slice(-4)}`;
}

export function formatDateTime(value) {
  try {
    return new Intl.DateTimeFormat(undefined, {
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    }).format(new Date(value));
  } catch {
    return value;
  }
}

export function formatCompactNumber(value) {
  const n = Number(value);
  if (Number.isNaN(n)) return "0";
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

export function formatMoneyCompact(microUsd) {
  const usd = Number(microUsd) / 1_000_000;
  if (usd >= 1) return `$${usd.toFixed(2)}`;
  if (usd >= 0.01) return `$${usd.toFixed(3)}`;
  return `$${usd.toFixed(6)}`;
}

export function apiKeyDurationToIso(value) {
  if (!value || value === "never") return undefined;
  const match = /^(\d+)([dmy])$/.exec(value);
  if (!match) return undefined;

  const amount = Number(match[1]);
  const unit = match[2];
  const date = new Date();

  if (unit === "d") date.setDate(date.getDate() + amount);
  if (unit === "m") date.setMonth(date.getMonth() + amount);
  if (unit === "y") date.setFullYear(date.getFullYear() + amount);

  return Number.isFinite(date.getTime()) ? date.toISOString() : undefined;
}

export function getConsoleView(pathname) {
  if (pathname === "/console/keys") return "keys";
  if (pathname === "/console/usage") return "usage";
  if (pathname === "/console/autopay") return "autopay";
  if (pathname === "/console/settings") return "settings";
  return "recharge";
}

export function consoleViewSubtitle(view) {
  if (view === "keys") return "Create and revoke keys used by clients calling the metered AI gateway.";
  if (view === "usage") return "Inspect account balance, model call records, and payable invoices.";
  if (view === "autopay") return "Manage autopay pre-approvals and spending limits.";
  if (view === "settings") return "Manage account-level settings.";
  return "Create a refundable deposit and receive an API key for metered model calls.";
}

export function buildCoinbaseWalletLink(url) {
  return `https://go.cb-w.com/dapp?cb_url=${encodeURIComponent(url)}`;
}

export function buildOkxWalletLink(url) {
  const deepLink = `okx://wallet/dapp/url?dappUrl=${encodeURIComponent(url)}`;
  return `https://web3.okx.com/download?deeplink=${encodeURIComponent(deepLink)}`;
}

export function readStoredAutopayEndpoint(storageKey) {
  try {
    return localStorage.getItem(storageKey) || "";
  } catch {
    return "";
  }
}

export function writeStoredAutopayEndpoint(storageKey, value) {
  try {
    localStorage.setItem(storageKey, value);
  } catch {
    // Login still works if the browser blocks localStorage.
  }
}
