import React from "react";

export default function Modal({ open, onClose, title, subtitle, className = "", children, titleId }) {
  if (!open) return null;
  const id = titleId || "modal-title";
  return (
    <div className="modal-layer" role="presentation">
      <button className="modal-scrim" type="button" aria-label="Close dialog" onClick={onClose} />
      <section
        className={`modal-panel ${className}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby={id}
      >
        <div className="modal-header">
          <div>
            <h2 id={id}>{title}</h2>
            {subtitle && <p className="muted">{subtitle}</p>}
          </div>
          <button className="icon-button modal-close" type="button" aria-label="Close" onClick={onClose}>
            <svg className="close-icon" viewBox="0 0 24 24" aria-hidden="true">
              <path d="M7 7l10 10M17 7L7 17" />
            </svg>
          </button>
        </div>
        <div className="modal-body">
          {children}
        </div>
      </section>
    </div>
  );
}
