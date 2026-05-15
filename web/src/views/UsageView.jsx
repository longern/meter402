import { useEffect, useRef, useState } from "react";
import CardSection from "../CardSection";
import DataList, { DataListItem } from "../DataList";
import { ChevronIcon, RefreshIcon } from "../icons";
import { formatDateTime, shortId } from "../utils";

function InvoiceCopyIcon({ copied }) {
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

export default function UsageView({
  requests,
  lastInvoices,
  isBusy,
  loading,
  loadRequests,
  loadPreviousRequestsPage,
  loadNextRequestsPage,
  requestsPage,
  hasPreviousRequestsPage,
  hasNextRequestsPage,
  loadInvoices,
  autopayInvoice,
}) {
  const [copiedInvoiceId, setCopiedInvoiceId] = useState("");
  const invoiceCopyTimerRef = useRef(null);

  useEffect(() => () => {
    if (invoiceCopyTimerRef.current) {
      window.clearTimeout(invoiceCopyTimerRef.current);
    }
  }, []);

  async function copyInvoiceId(id) {
    try {
      await navigator.clipboard.writeText(id);
      setCopiedInvoiceId(id);
      if (invoiceCopyTimerRef.current) {
        window.clearTimeout(invoiceCopyTimerRef.current);
      }
      invoiceCopyTimerRef.current = window.setTimeout(() => {
        setCopiedInvoiceId("");
        invoiceCopyTimerRef.current = null;
      }, 1400);
    } catch (error) {
      console.error("Failed to copy invoice ID", error);
    }
  }

  function renderRequestStatus(status) {
    return (
      <span className={`status-chip ${status || "unknown"}`}>
        {status || "unknown"}
      </span>
    );
  }

  function formatRequestCost(item) {
    if (item.status !== "completed" || item.final_cost == null || item.final_cost === "") {
      return "--";
    }
    return `$${item.final_cost}`;
  }

  function renderInvoiceStatus(status) {
    return (
      <span className={`status-chip ${status || "unknown"}`}>
        {status || "unknown"}
      </span>
    );
  }

  return (
    <>
      <CardSection
        title="Model Calls"
        actions={
          <button
            className="icon-button plain"
            type="button"
            aria-label="Refresh model calls"
            disabled={loading.requests}
            onClick={() => loadRequests()}
          >
            <RefreshIcon />
          </button>
        }
      >
        {requests.length ? (
          <>
            <div className="usage-table-wrap">
              <table className="data-table usage-table">
                <thead>
                  <tr>
                    <th>Model</th>
                    <th>Status</th>
                    <th className="numeric">Tokens</th>
                    <th className="numeric">Cost</th>
                    <th>Started</th>
                    <th>ID</th>
                  </tr>
                </thead>
                <tbody>
                  {requests.map((item) => (
                    <tr key={item.id}>
                      <td><strong>{item.model || "Unknown model"}</strong></td>
                      <td>{renderRequestStatus(item.status)}</td>
                      <td className="numeric">{item.total_tokens ?? 0}</td>
                      <td className="numeric">{formatRequestCost(item)}</td>
                      <td>{item.started_at ? formatDateTime(item.started_at) : "--"}</td>
                      <td className="mono">{shortId(item.id)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <DataList className="usage-mobile-list">
              {requests.map((item) => (
                <DataListItem className="usage-mobile-item" key={item.id}>
                  <div className="usage-mobile-primary">
                    <strong>{item.model || "Unknown model"}</strong>
                    {renderRequestStatus(item.status)}
                  </div>
                  <div className="usage-mobile-meta">
                    <span>{item.started_at ? formatDateTime(item.started_at) : "--"}</span>
                    <span className="mono">{shortId(item.id)}</span>
                  </div>
                  <div className="usage-mobile-metrics">
                    <span>{item.total_tokens ?? 0} tokens</span>
                    <span>{formatRequestCost(item)}</span>
                  </div>
                </DataListItem>
              ))}
            </DataList>
          </>
        ) : (
          <p className="muted">No metered gateway requests yet.</p>
        )}
        <div className="pagination-row" aria-label="Model calls pagination">
          <button
            type="button"
            className="pagination-icon-button"
            aria-label="Previous page"
            disabled={loading.requests || !hasPreviousRequestsPage}
            onClick={loadPreviousRequestsPage}
          >
            <ChevronIcon direction="left" />
          </button>
          <span>Page {requestsPage}</span>
          <button
            type="button"
            className="pagination-icon-button"
            aria-label="Next page"
            disabled={loading.requests || !hasNextRequestsPage}
            onClick={loadNextRequestsPage}
          >
            <ChevronIcon direction="right" />
          </button>
        </div>
      </CardSection>

      <CardSection
        title="Invoices"
        actions={
          <button
            className="icon-button plain"
            type="button"
            aria-label="Refresh invoices"
            disabled={loading.invoices}
            onClick={loadInvoices}
          >
            <RefreshIcon />
          </button>
        }
      >
        <div className="card-action-row">
          <button disabled={isBusy} className="primary" onClick={autopayInvoice}>Pay invoice</button>
        </div>
        {lastInvoices.length ? (
          <>
            <div className="invoice-table-wrap">
              <table className="data-table invoice-table">
                <thead>
                  <tr>
                    <th>Amount</th>
                    <th>Status</th>
                    <th>Created</th>
                    <th>Paid</th>
                    <th>ID</th>
                  </tr>
                </thead>
                <tbody>
                  {lastInvoices.map((item) => (
                    <tr key={item.id}>
                      <td><strong>{item.amount_due} {item.currency}</strong></td>
                      <td>{renderInvoiceStatus(item.status)}</td>
                      <td>{item.created_at ? formatDateTime(item.created_at) : "--"}</td>
                      <td>{item.paid_at ? formatDateTime(item.paid_at) : "--"}</td>
                      <td className="mono">{shortId(item.id)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <DataList className="invoice-mobile-list">
              {lastInvoices.map((item) => (
                <DataListItem className="invoice-mobile-item" key={item.id}>
                  <div className="invoice-mobile-main">
                    <strong>{item.amount_due} {item.currency}</strong>
                    <span className="invoice-mobile-id-row">
                      <span className="mono">{shortId(item.id)}</span>
                      <button
                        type="button"
                        className={`invoice-copy-button${copiedInvoiceId === item.id ? " copied" : ""}`}
                        aria-label={copiedInvoiceId === item.id ? "Invoice ID copied" : "Copy invoice ID"}
                        title={copiedInvoiceId === item.id ? "Copied" : "Copy invoice ID"}
                        onClick={() => copyInvoiceId(item.id)}
                      >
                        <InvoiceCopyIcon copied={copiedInvoiceId === item.id} />
                      </button>
                    </span>
                  </div>
                  <div className="invoice-mobile-status">
                    {renderInvoiceStatus(item.status)}
                  </div>
                </DataListItem>
              ))}
            </DataList>
          </>
        ) : (
          <p className="muted">No unpaid usage charges yet.</p>
        )}
      </CardSection>
    </>
  );
}
