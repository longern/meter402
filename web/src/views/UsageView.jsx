import CardSection from "../CardSection";
import DataList, { DataListItem } from "../DataList";
import { RefreshIcon } from "../icons";
import { formatDateTime, shortId } from "../utils";

export default function UsageView({
  requests,
  lastInvoices,
  isBusy,
  busy,
  loadRequests,
  loadInvoices,
  autopayInvoice,
}) {
  return (
    <>
      <CardSection
        title="Model Calls"
        actions={
          <button
            className="icon-button plain"
            type="button"
            aria-label="Refresh model calls"
            disabled={busy === "loadRequests"}
            onClick={loadRequests}
          >
            <RefreshIcon />
          </button>
        }
      >
        {requests.length ? (
          <DataList>
            {requests.map((item) => (
              <DataListItem key={item.id}>
                <div>
                  <strong>{item.model || "Unknown model"}</strong>
                  <span>
                    {item.started_at ? `${formatDateTime(item.started_at)} · ` : ""}
                    {item.status} · {item.total_tokens ?? 0} tokens · {item.final_cost || "0.000000"}
                  </span>
                </div>
                <span className="mono">{shortId(item.id)}</span>
              </DataListItem>
            ))}
          </DataList>
        ) : (
          <p className="muted">No metered gateway requests yet.</p>
        )}
      </CardSection>

      <CardSection
        title="Invoices"
        actions={
          <button
            className="icon-button plain"
            type="button"
            aria-label="Refresh invoices"
            disabled={busy === "loadInvoices"}
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
          <DataList>
            {lastInvoices.map((item) => (
              <DataListItem key={item.id}>
                <div>
                  <strong>{item.amount_due} {item.currency}</strong>
                  <span>{item.status} · {shortId(item.id)}</span>
                </div>
              </DataListItem>
            ))}
          </DataList>
        ) : (
          <p className="muted">No unpaid usage charges yet.</p>
        )}
      </CardSection>
    </>
  );
}
