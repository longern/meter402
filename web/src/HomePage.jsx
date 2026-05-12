import { GATEWAY_PROVIDERS } from "./gatewayProviders";

export default function HomePage() {
  const v1BaseURL = new URL("/v1", window.location.origin).toString();

  return (
    <div className="home">
      <nav className="home-nav">
        <a className="brand" href="/">Meteria402</a>
        <div className="nav-actions">
          <a href="/console">Console</a>
        </div>
      </nav>

      <main className="home-main">
        <section className="hero">
          <div className="hero-copy">
            <p className="eyebrow">OpenAI-compatible metered gateway</p>
            <h1>Meteria402</h1>
            <p className="hero-lead">
              A deposit-backed AI API gateway that creates x402 invoices from actual token usage.
            </p>
            <div className="hero-actions">
              <a className="button-link primary" href="/console">Open console</a>
              <a className="button-link secondary" href="/compat/chat/completions">Compat endpoint</a>
            </div>
          </div>

          <div className="flow-panel" aria-label="Meteria402 request flow">
            <div className="flow-row">
              <span>Client</span>
              <strong>/v1 or /compat</strong>
            </div>
            <div className="flow-line" />
            <div className="flow-row">
              <span>Meteria402</span>
              <strong>deposit + invoice gate</strong>
            </div>
            <div className="flow-line" />
            <div className="flow-row">
              <span>Cloudflare AI Gateway</span>
              <strong>model response + usage</strong>
            </div>
            <div className="flow-line" />
            <div className="flow-row accent">
              <span>x402</span>
              <strong>pay invoices with wallet approval</strong>
            </div>
          </div>
        </section>

        <section className="home-section">
          <h2>How It Works</h2>
          <div className="feature-grid">
            <article>
              <span className="step">01</span>
              <h3>Deposit</h3>
              <p>Create a refundable deposit quote and receive a one-time API key after x402 settlement.</p>
            </article>
            <article>
              <span className="step">02</span>
              <h3>Meter</h3>
              <p>Use any OpenAI-compatible client while the Worker records request usage through Cloudflare AI Gateway.</p>
            </article>
            <article>
              <span className="step">03</span>
              <h3>Invoice</h3>
              <p>Each successful request creates an unpaid usage invoice that must be settled before the next request.</p>
            </article>
            <article>
              <span className="step">04</span>
              <h3>Autopay</h3>
              <p>Approve scoped wallet payments for deposit and invoice settlement without exposing your owner wallet key.</p>
            </article>
          </div>
        </section>

        <section className="home-section split">
          <div>
            <h2>Gateway Endpoint</h2>
            <p>Point each provider SDK at the matching Meteria402 path.</p>
          </div>
          <pre className="code-sample">{`const client = new OpenAI({
  apiKey: "mia2_xxx",
  baseURL: "${v1BaseURL}",
});`}</pre>
        </section>

        <section className="home-section">
          <h2>Provider Paths</h2>
          <div className="provider-path-grid">
            {GATEWAY_PROVIDERS.slice(0, 10).map((provider) => (
              <article key={provider.path}>
                <strong>{provider.path}</strong>
                <span>{provider.label}</span>
              </article>
            ))}
          </div>
        </section>
      </main>
    </div>
  );
}
