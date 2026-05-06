import styles from "./CardSection.module.css";

export default function CardSection({
  title,
  titleId,
  subtitle,
  actions,
  children,
  className = "",
  as: Component = "section",
  ...sectionProps
}) {
  const cardClassName = className
    ? `${styles.cardSection} ${className}`
    : styles.cardSection;

  return (
    <Component className={cardClassName} {...sectionProps}>
      <div className={styles.header}>
        <div>
          <h2 className={styles.title} id={titleId}>{title}</h2>
          {subtitle && <p className={styles.subtitle}>{subtitle}</p>}
        </div>
        {actions && <div className={styles.actions}>{actions}</div>}
      </div>
      <hr className={styles.divider} />
      <div className={styles.content}>
        {children}
      </div>
    </Component>
  );
}
