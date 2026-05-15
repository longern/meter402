import { useState } from "react";

const MUTATING_BUSY_LABELS = new Set([
  "updateAutopay",
  "createCapability",
  "revokeCapability",
  "createApiKey",
  "disableApiKey",
  "enableApiKey",
  "deleteApiKey",
  "autopayInvoice",
  "directPayment",
  "walletPayment",
]);

const INITIAL_LOADING = {
  account: false,
  apiKeys: false,
  invoices: false,
  requests: false,
  walletBalance: false,
};

export default function useConsoleBusy({ onBusyError }) {
  const [busy, setBusy] = useState("");
  const [loading, setLoading] = useState(INITIAL_LOADING);

  async function withBusy(label, fn) {
    setBusy(label);
    try {
      await fn();
    } catch (error) {
      onBusyError?.(label, error);
    } finally {
      setBusy("");
    }
  }

  function setLoadingFlag(key, value) {
    setLoading((current) => ({ ...current, [key]: value }));
  }

  return {
    busy,
    setBusy,
    loading,
    setLoadingFlag,
    withBusy,
    isMutating: MUTATING_BUSY_LABELS.has(busy),
  };
}
