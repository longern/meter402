import styles from "./CardSection.module.css";

export default function CardSection({
  title,
  titleId,
  actions,
  children,
  className = "",
  contentClassName = "",
  as: Component = "section",
  ...sectionProps
}) {
  const cardClassName = className
    ? `${styles.cardSection} ${className}`
    : styles.cardSection;
  const contentClass = contentClassName
    ? `${styles.content} ${contentClassName}`
    : styles.content;

  return (
    <Component className={cardClassName} {...sectionProps}>
      <div className={styles.header}>
        <div>
          <h2 className={styles.title} id={titleId}>{title}</h2>
        </div>
        {actions && <div className={styles.actions}>{actions}</div>}
      </div>
      <hr className={styles.divider} />
      <div className={contentClass}>
        {children}
      </div>
    </Component>
  );
}
