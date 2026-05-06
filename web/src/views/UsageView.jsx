import CardSection from "../CardSection";
import { formatDateTime, shortId } from "../utils";

export default function UsageView({
  account,
  requests,
  lastInvoices,
  isBusy,
  loadAccount,
  loadRequests,
  loadInvoices,
  autopayInvoice,
}) {
  return (
    <>
      <CardSection title="Account">
        <div className="row">
          <button className="primary" disabled={isBusy} onClick={loadAccount}>Load account</button>
          <button disabled={isBusy} className="primary" onClick={loadRequests}>Load calls</button>
          <button disabled={isBusy} className="primary" onClick={loadInvoices}>Load invoices</button>
          <button disabled={isBusy} className="primary" onClick={autopayInvoice}>Pay invoice</button>
        </div>
        {account && (
          <dl className="summary-grid">
            <dt>Balance</dt><dd>{account.deposit_balance}</dd>
            <dt>Unpaid</dt><dd>{account.unpaid_invoice_total}</dd>
            <dt>Status</dt><dd>{account.status}</dd>
          </dl>
        )}
      </CardSection>

      <CardSection title="Model Calls">
        {requests.length ? (
          <div className="data-list">
            {requests.map((item) => (
              <div className="data-row" key={item.id}>
                <div>
                  <strong>{item.model || "Unknown model"}</strong>
                  <span>{item.status} · {item.total_tokens ?? 0} tokens · {item.final_cost || "0.000000"}</span>
                </div>
                <span className="mono">{shortId(item.id)}</span>
              </div>
            ))}
          </div>
        ) : (
          <p className="muted">Load calls to see recent metered gateway requests.</p>
        )}
      </CardSection>

      <CardSection title="Invoices">
        {lastInvoices.length ? (
          <div className="data-list">
            {lastInvoices.map((item) => (
              <div className="data-row" key={item.id}>
                <div>
                  <strong>{item.amount_due} {item.currency}</strong>
                  <span>{item.status} · {shortId(item.id)}</span>
                </div>
              </div>
            ))}
          </div>
        ) : (
          <p className="muted">Load invoices to see unpaid usage charges.</p>
        )}
      </CardSection>
    </>
  );
}
