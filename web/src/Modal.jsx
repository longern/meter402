import React from "react";
import CardSection from "./CardSection";

export default function Modal({ open, onClose, title, subtitle, className = "", children, titleId }) {
  if (!open) return null;
  const id = titleId || "modal-title";
  const closeAction = (
    <button className="icon-button modal-close" type="button" aria-label="Close" onClick={onClose}>
      <svg className="close-icon" viewBox="0 0 24 24" aria-hidden="true">
        <path d="M7 7l10 10M17 7L7 17" />
      </svg>
    </button>
  );

  return (
    <div className="modal-layer" role="presentation">
      <button className="modal-scrim" type="button" aria-label="Close dialog" onClick={onClose} />
      <CardSection
        as="section"
        className={`modal-panel ${className}`}
        title={title}
        titleId={id}
        subtitle={subtitle}
        actions={closeAction}
        role="dialog"
        aria-modal="true"
        aria-labelledby={id}
      >
        {children}
      </CardSection>
    </div>
  );
}
