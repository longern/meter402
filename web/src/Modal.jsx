import React from "react";
import CardSection from "./CardSection";
import styles from "./Modal.module.css";

export default function Modal({ open, onClose, title, className = "", children, titleId }) {
  if (!open) return null;
  const id = titleId || "modal-title";
  const panelClassName = className ? `${styles.panel} ${className}` : styles.panel;
  const closeAction = (
    <button className={styles.close} type="button" aria-label="Close" onClick={onClose}>
      <svg className="close-icon" viewBox="0 0 24 24" aria-hidden="true">
        <path d="M7 7l10 10M17 7L7 17" />
      </svg>
    </button>
  );

  return (
    <div className={styles.layer} role="presentation">
      <button className={styles.scrim} type="button" aria-label="Close dialog" onClick={onClose} />
      <CardSection
        as="section"
        className={panelClassName}
        contentClassName={styles.content}
        title={title}
        titleId={id}
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
