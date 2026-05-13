import { useEffect, useState } from "react";
import { useI18n } from "../i18n";
import CardSection from "../CardSection";
import Modal from "../Modal";
import { readableError, shortAddress } from "../utils";

export default function SettingsView({
  identity,
  account,
  isBusy,
  busy,
  request,
  show,
  onSessionChange,
  loadAccount,
}) {
  const { t } = useI18n();
  const [newOwner, setNewOwner] = useState("");
  const [status, setStatus] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [rebindOpen, setRebindOpen] = useState(false);
  const [minRechargeAmount, setMinRechargeAmount] = useState(
    account?.autopay_min_recharge_amount || "0.01",
  );
  const [minRechargeStatus, setMinRechargeStatus] = useState("");
  const [savingMinRecharge, setSavingMinRecharge] = useState(false);
  const [minRechargeOpen, setMinRechargeOpen] = useState(false);

  useEffect(() => {
    setMinRechargeAmount(account?.autopay_min_recharge_amount || "0.01");
  }, [account?.autopay_min_recharge_amount]);

  async function rebindOwner(event) {
    event.preventDefault();
    setStatus("");
    setSubmitting(true);
    try {
      const provider = window.ethereum;
      if (!provider) throw new Error("Open this page in an Ethereum wallet browser.");
      const accounts = await provider.request({ method: "eth_requestAccounts" });
      const signer = accounts?.[0] || "";
      if (!signer) throw new Error("No wallet account selected.");
      if (signer.toLowerCase() !== identity.owner.toLowerCase()) {
        throw new Error("Connect the current sign-in wallet before signing.");
      }

      setStatus("Preparing signature...");
      const challenge = await request("/api/account/owner-rebind/challenge", {
        method: "POST",
        body: JSON.stringify({ new_owner: newOwner.trim() }),
      });
      const signature = await signPersonalMessage(provider, signer, challenge.message);
      setStatus("Confirming rebind...");
      const result = await request("/api/account/owner-rebind/complete", {
        method: "POST",
        body: JSON.stringify({
          challenge_token: challenge.challenge_token,
          message: challenge.message,
          signature,
        }),
      });
      setRebindOpen(false);
      show(result);
      onSessionChange(null);
      window.location.assign("/login");
    } catch (error) {
      const message = readableError(error);
      setStatus(message);
      show(message);
    } finally {
      setSubmitting(false);
    }
  }

  async function saveMinRechargeAmount(event) {
    event.preventDefault();
    setMinRechargeStatus("");
    const normalizedAmount = minRechargeAmount.trim();
    const parsedAmount = Number(normalizedAmount);
    if (!Number.isFinite(parsedAmount) || parsedAmount < 0.01) {
      setMinRechargeStatus("Minimum recharge amount must be at least 0.01 USDC.");
      return;
    }

    setSavingMinRecharge(true);
    try {
      const result = await request("/api/account", {
        method: "PATCH",
        body: JSON.stringify({ autopay_min_recharge_amount: normalizedAmount }),
      });
      setMinRechargeAmount(result.autopay_min_recharge_amount || normalizedAmount);
      setMinRechargeStatus("Saved.");
      show(result);
      await loadAccount();
      setMinRechargeOpen(false);
    } catch (error) {
      const message = readableError(error);
      setMinRechargeStatus(message);
      show(message);
    } finally {
      setSavingMinRecharge(false);
    }
  }

  return (
    <>
      <CardSection
        title={t("Sign-in Wallet")}
      >
        <div className="settings-wallet-warning" role="alert">
          <strong>Keep your wallet private key safe.</strong>
          <p>
            If this sign-in wallet's private key is lost, you may lose access to this account and
            will not be able to rebind the wallet or manage existing autopay authorizations.
          </p>
        </div>
        <div className="settings-owner-panel">
          <p className="settings-field-label">Current sign-in wallet</p>
          <strong>{identity?.owner ? shortAddress(identity.owner) : "Not connected"}</strong>
          {identity?.owner && <code>{identity.owner}</code>}
          <div className="settings-actions">
            <button
              type="button"
              className="secondary"
              disabled={isBusy || !account}
              onClick={() => {
                setStatus("");
                setNewOwner("");
                setRebindOpen(true);
              }}
            >
              Rebind
            </button>
          </div>
        </div>
      </CardSection>

      <CardSection
        title={t("Auto-Recharge")}
      >
        <div className="settings-owner-panel">
          <p className="settings-field-label">Current minimum</p>
          <strong>{account?.autopay_min_recharge_amount || "0.01"} USDC</strong>
          <div className="settings-actions">
            <button
              type="button"
              className="secondary"
              disabled={isBusy || !account}
              onClick={() => {
                setMinRechargeStatus("");
                setMinRechargeAmount(account?.autopay_min_recharge_amount || "0.01");
                setMinRechargeOpen(true);
              }}
            >
              Edit
            </button>
          </div>
        </div>
      </CardSection>

      <Modal
        open={rebindOpen}
        onClose={() => {
          if (!submitting) setRebindOpen(false);
        }}
        title={t("Rebind Sign-in Wallet")}
        titleId="rebind-wallet-title"
      >
        <div className="settings-dialog-content">
          <div className="settings-owner-panel">
            <p className="settings-field-label">Current sign-in wallet</p>
            <strong>{identity?.owner ? shortAddress(identity.owner) : "Not connected"}</strong>
            {identity?.owner && <code>{identity.owner}</code>}
          </div>
          <div className="settings-wallet-warning settings-rebind-warning" role="alert">
            <ul>
              <li>
                Copy and paste the <strong>public wallet address</strong>. Do not paste your private key.
              </li>
              <li>After rebinding, existing autopay limits will be revoked.</li>
            </ul>
          </div>
          <form className="settings-rebind-form" onSubmit={rebindOwner}>
            <label>
              <span>New sign-in wallet address</span>
              <input
                value={newOwner}
                inputMode="text"
                autoComplete="off"
                spellCheck="false"
                placeholder="0x..."
                onChange={(event) => setNewOwner(event.target.value)}
              />
            </label>
            {status && <p className="form-status">{status}</p>}
            <div className="settings-actions">
              <button
                type="submit"
                className="primary"
                disabled={submitting || isBusy || !account || !newOwner.trim()}
              >
                {submitting ? "Confirming..." : "Rebind wallet"}
              </button>
            </div>
          </form>
        </div>
      </Modal>

      <Modal
        open={minRechargeOpen}
        onClose={() => {
          if (!savingMinRecharge) setMinRechargeOpen(false);
        }}
        title="Edit Auto-Recharge"
        titleId="edit-auto-recharge-title"
      >
        <div className="settings-dialog-content">
          <div className="settings-owner-panel">
            <p className="settings-field-label">Current minimum</p>
            <strong>{account?.autopay_min_recharge_amount || "0.01"} USDC</strong>
          </div>

          <form className="settings-rebind-form" onSubmit={saveMinRechargeAmount}>
            <label>
              <span>Minimum recharge amount</span>
              <input
                type="number"
                min="0.01"
                step="0.01"
                value={minRechargeAmount}
                inputMode="decimal"
                autoComplete="off"
                onChange={(event) => setMinRechargeAmount(event.target.value)}
              />
            </label>
            <p className="muted">Values below 0.01 USDC are rejected.</p>
            {minRechargeStatus && <p className="form-status">{minRechargeStatus}</p>}
            <div className="settings-actions">
              <button
                type="submit"
                className="primary"
                disabled={savingMinRecharge || isBusy || !account || !minRechargeAmount.trim()}
              >
                {savingMinRecharge ? "Saving..." : "Save minimum"}
              </button>
            </div>
          </form>
        </div>
      </Modal>
    </>
  );
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
