export default function CardSection({ title, actions, children }) {
  return (
    <section className="card-section">
      <div className="section-header">
        <h2>{title}</h2>
        {actions && <div className="section-actions">{actions}</div>}
      </div>
      {children}
    </section>
  );
}
