import { useEffect, useRef, useState } from "react";
import CardSection from "../CardSection";
import DataList, { DataListItem } from "../DataList";
import Modal from "../Modal";
import { RefreshIcon } from "../icons";
import { formatDateTime } from "../utils";
import { GATEWAY_PROVIDERS, providerUrl } from "../gatewayProviders";

const API_KEY_DURATION_OPTIONS = [
  { value: "30d", label: "30 days" },
  { value: "90d", label: "90 days" },
  { value: "1y", label: "1 year" },
  { value: "10y", label: "10 years" },
  { value: "never", label: "No expiration" },
];

function CopyIcon({ copied }) {
  if (copied) {
    return (
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path d="M5 13l4 4L19 7" />
      </svg>
    );
  }

  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <rect x="9" y="9" width="10" height="10" rx="2" />
      <path d="M6 15H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v1" />
    </svg>
  );
}

export default function KeysView({
  apiKeys,
  isBusy,
  busy,
  loadApiKeys,
  openCreateKeyDialog,
  disableApiKey,
  enableApiKey,
  deleteApiKey,
  navigateConsoleView,
  createKeyOpen,
  closeCreateKeyDialog,
  createManagedApiKey,
  newKeyName,
  setNewKeyName,
  newKeyDuration,
  setNewKeyDuration,
  newKeySpendLimit,
  setNewKeySpendLimit,
  newApiKey,
  keyDialogError,
  formatMoneyCompact,
}) {
  const [copiedBaseUrl, setCopiedBaseUrl] = useState("");
  const [selectedProviderPath, setSelectedProviderPath] = useState(GATEWAY_PROVIDERS[0]?.path || "");
  const [openActionMenu, setOpenActionMenu] = useState("");
  const baseUrlCopyTimerRef = useRef(null);
  const selectedProvider =
    GATEWAY_PROVIDERS.find((provider) => provider.path === selectedProviderPath) ||
    GATEWAY_PROVIDERS[0];
  const selectedProviderBaseUrl = selectedProvider ? providerUrl(selectedProvider.path) : "";

  useEffect(() => {
    function closeActionMenu(event) {
      if (event.target.closest?.(".api-key-action-menu-shell")) return;
      setOpenActionMenu("");
    }

    function closeActionMenuOnEscape(event) {
      if (event.key === "Escape") setOpenActionMenu("");
    }

    document.addEventListener("click", closeActionMenu);
    document.addEventListener("keydown", closeActionMenuOnEscape);

    return () => {
      document.removeEventListener("click", closeActionMenu);
      document.removeEventListener("keydown", closeActionMenuOnEscape);
      if (baseUrlCopyTimerRef.current) {
        window.clearTimeout(baseUrlCopyTimerRef.current);
      }
    };
  }, []);

  async function copyBaseUrl(url) {
    try {
      await navigator.clipboard.writeText(url);
      setCopiedBaseUrl(url);
      if (baseUrlCopyTimerRef.current) {
        window.clearTimeout(baseUrlCopyTimerRef.current);
      }
      baseUrlCopyTimerRef.current = window.setTimeout(() => {
        setCopiedBaseUrl("");
        baseUrlCopyTimerRef.current = null;
      }, 1400);
    } catch (error) {
      console.error("Failed to copy base URL", error);
    }
  }

  function handleApiKeyAction(action, id) {
    setOpenActionMenu("");
    action(id);
  }

  function renderApiKeyStatus(status) {
    return (
      <span className={`api-key-status-chip ${status}`}>
        {status}
      </span>
    );
  }

  function renderApiKeyActionMenu(item) {
    const isDisabled = item.status === "disabled";
    const toggleAction = isDisabled ? enableApiKey : disableApiKey;
    const toggleLabel = isDisabled ? "Enable" : "Disable";

    return (
      <div className="api-key-action-menu-shell">
        <button
          className="icon-button plain api-key-action-button"
          type="button"
          aria-label={`Open actions for ${item.name || item.key_suffix}`}
          aria-expanded={openActionMenu === item.id}
          disabled={isBusy}
          onClick={() => setOpenActionMenu((current) => current === item.id ? "" : item.id)}
        >
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <circle cx="5" cy="12" r="1.7" />
            <circle cx="12" cy="12" r="1.7" />
            <circle cx="19" cy="12" r="1.7" />
          </svg>
        </button>
        {openActionMenu === item.id && (
          <div className="api-key-action-menu" role="menu">
            <button type="button" role="menuitem" onClick={() => handleApiKeyAction(toggleAction, item.id)}>
              {toggleLabel}
            </button>
            <button type="button" role="menuitem" className="danger" onClick={() => handleApiKeyAction(deleteApiKey, item.id)}>
              Delete
            </button>
          </div>
        )}
      </div>
    );
  }

  return (
    <>
      <CardSection title="Base URL">
        <div className="endpoint-picker">
          <label>
            <span>Provider</span>
            <select
              value={selectedProviderPath}
              onChange={(event) => {
                setSelectedProviderPath(event.target.value);
                setCopiedBaseUrl("");
              }}
            >
              {GATEWAY_PROVIDERS.map((provider) => (
                <option key={provider.path} value={provider.path}>
                  {provider.label}
                </option>
              ))}
            </select>
          </label>
          {selectedProvider && (
            <div className="approval-link-box endpoint-current">
              <div className="approval-link-header">
                <span>{selectedProvider.label} · {selectedProvider.sdk}</span>
                <button
                  className={`approval-copy-button${copiedBaseUrl === selectedProviderBaseUrl ? " copied" : ""}`}
                  type="button"
                  onClick={() => copyBaseUrl(selectedProviderBaseUrl)}
                  aria-label={
                    copiedBaseUrl === selectedProviderBaseUrl
                      ? "Base URL copied"
                      : `Copy ${selectedProvider.label} base URL`
                  }
                  title={copiedBaseUrl === selectedProviderBaseUrl ? "Copied" : "Copy base URL"}
                >
                  <CopyIcon copied={copiedBaseUrl === selectedProviderBaseUrl} />
                </button>
              </div>
              <code>{selectedProviderBaseUrl}</code>
            </div>
          )}
        </div>
      </CardSection>

      <CardSection
        title="API Keys"
        actions={
          <button
            className="icon-button plain"
            type="button"
            aria-label="Refresh API keys"
            disabled={busy === "loadApiKeys"}
            onClick={loadApiKeys}
          >
            <RefreshIcon />
          </button>
        }
      >
        <div style={{ marginBottom: 12 }}>
          <button disabled={isBusy} className="primary" onClick={openCreateKeyDialog}>Create key</button>
        </div>

        {apiKeys.length ? (
          <>
            <div className="api-key-table-wrap">
              <table className="api-key-table">
                <thead>
                  <tr>
                    <th>Name</th>
                    <th>Key</th>
                    <th>Status</th>
                    <th>Expires</th>
                    <th className="numeric">Cost</th>
                    <th className="numeric">Limit</th>
                    <th className="actions">Action</th>
                  </tr>
                </thead>
                <tbody>
                  {apiKeys.map((item) => (
                    <tr key={item.id}>
                      <td>
                        <strong>{item.name || `${item.prefix}_...${item.key_suffix}`}</strong>
                      </td>
                      <td className="mono">{item.prefix}_...{item.key_suffix}</td>
                      <td>{renderApiKeyStatus(item.status)}</td>
                      <td>{item.expires_at ? formatDateTime(item.expires_at) : "Never"}</td>
                      <td className="numeric">{formatMoneyCompact(item.total_cost ?? 0)}</td>
                      <td className="numeric">{item.spend_limit == null ? "Unlimited" : formatMoneyCompact(item.spend_limit)}</td>
                      <td className="actions">
                        {renderApiKeyActionMenu(item)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <DataList className="api-key-mobile-list" dividerClassName="api-key-mobile-divider">
              {apiKeys.map((item) => (
                <DataListItem className="api-key-mobile-item" key={item.id}>
                  <div className="api-key-mobile-main">
                    <div className="api-key-mobile-title-row">
                      <strong>{item.name || `${item.prefix}_...${item.key_suffix}`}</strong>
                      <span className="api-key-mobile-cost">{formatMoneyCompact(item.total_cost ?? 0)}</span>
                    </div>
                    <div className="api-key-mobile-key-row">
                      <span className="mono">{item.prefix}_...{item.key_suffix}</span>
                    </div>
                    <div className="api-key-mobile-status-row">
                      {renderApiKeyStatus(item.status)}
                      <span>{item.expires_at ? `expires ${formatDateTime(item.expires_at)}` : "Never expires"}</span>
                      {item.spend_limit != null && (
                        <span>Limit {formatMoneyCompact(item.spend_limit)}</span>
                      )}
                    </div>
                  </div>
                  {renderApiKeyActionMenu(item)}
                </DataListItem>
              ))}
            </DataList>
          </>
        ) : (
          <div className="empty-state">
            <strong>No keys</strong>
            <p>Create a deposit first. The Worker will generate the initial API key after settlement.</p>
            <button type="button" className="primary" onClick={() => navigateConsoleView("recharge")}>Go to Recharge</button>
          </div>
        )}
      </CardSection>

      {createKeyOpen && (
        <Modal
          open={createKeyOpen}
          onClose={closeCreateKeyDialog}
          title="Create API Key"
          titleId="create-key-title"
        >
          <form onSubmit={createManagedApiKey}>
            <div className="dialog-form">
              <label>
                <span>Name</span>
                <input value={newKeyName} placeholder="Auto-generated if empty" onChange={(event) => setNewKeyName(event.target.value)} />
              </label>
              <label>
                <span>Valid for</span>
                <select value={newKeyDuration} onChange={(event) => setNewKeyDuration(event.target.value)}>
                  {API_KEY_DURATION_OPTIONS.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                <span>Spend limit (USDC)</span>
                <input
                  value={newKeySpendLimit}
                  inputMode="decimal"
                  placeholder="Unlimited"
                  onChange={(event) => setNewKeySpendLimit(event.target.value)}
                />
              </label>
            </div>
            {keyDialogError && <p className="form-error">{keyDialogError}</p>}
            {newApiKey && (
              <div className="generated-key">
                <span>New key</span>
                <code>{newApiKey}</code>
              </div>
            )}
            <div className="dialog-actions">
              <button type="button" className="secondary" onClick={closeCreateKeyDialog}>Close</button>
              <button type="submit" className="primary" disabled={busy === "createApiKey"}>
                {busy === "createApiKey" ? "Creating..." : "Create key"}
              </button>
            </div>
          </form>
        </Modal>
      )}
    </>
  );
}
