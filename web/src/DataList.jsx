import { Children, Fragment } from "react";

function classNames(...values) {
  return values.filter(Boolean).join(" ");
}

export function DataListItem({ children, className = "", ...props }) {
  return (
    <li className={classNames("data-row", className)} {...props}>
      {children}
    </li>
  );
}

export default function DataList({ children, className = "", dividerClassName = "", ...props }) {
  const items = Children.toArray(children).filter(Boolean);

  return (
    <ul className={classNames("data-list", className)} {...props}>
      {items.map((child, index) => (
        <Fragment key={child.key ?? index}>
          {child}
          {index < items.length - 1 && (
            <li
              className={classNames("data-list-divider", dividerClassName)}
              aria-hidden="true"
            />
          )}
        </Fragment>
      ))}
    </ul>
  );
}
