import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import styles from "./ActionMenu.module.css";

const MENU_WIDTH = 124;
const MENU_GAP = 6;
const VIEWPORT_PADDING = 8;
const MENU_EXIT_MS = 110;

export function getActionMenuPosition(anchor, { height = 96, width = MENU_WIDTH } = {}) {
  const rect = anchor.getBoundingClientRect();
  const maxLeft = Math.max(VIEWPORT_PADDING, window.innerWidth - VIEWPORT_PADDING - width);
  const left = Math.min(Math.max(rect.right - width, VIEWPORT_PADDING), maxLeft);
  const belowTop = rect.bottom + MENU_GAP;
  const aboveTop = rect.top - MENU_GAP - height;
  const top =
    belowTop + height <= window.innerHeight - VIEWPORT_PADDING
      ? belowTop
      : Math.max(VIEWPORT_PADDING, aboveTop);

  return { left, top };
}

export default function ActionMenu({ children, className = "", open, position }) {
  const [shouldRender, setShouldRender] = useState(open && !!position);
  const [isClosing, setIsClosing] = useState(false);
  const lastPositionRef = useRef(position);

  useEffect(() => {
    if (position) lastPositionRef.current = position;
  }, [position]);

  useEffect(() => {
    if (open && position) {
      setShouldRender(true);
      setIsClosing(false);
      return undefined;
    }

    if (!shouldRender) return undefined;

    setIsClosing(true);
    const timeout = window.setTimeout(() => {
      setShouldRender(false);
      setIsClosing(false);
    }, MENU_EXIT_MS);

    return () => window.clearTimeout(timeout);
  }, [open, position, shouldRender]);

  const menuPosition = position || lastPositionRef.current;
  if (!shouldRender || !menuPosition) return null;

  return createPortal(
    <div
      className={`${styles.menu}${isClosing ? ` ${styles.closing}` : ""}${className ? ` ${className}` : ""}`}
      data-action-menu-root
      role="menu"
      style={{ left: menuPosition.left, top: menuPosition.top }}
    >
      {children}
    </div>,
    document.body,
  );
}

export function actionMenuShellClassName(className = "") {
  return `${styles.shell}${className ? ` ${className}` : ""}`;
}

export function actionMenuButtonClassName(className = "") {
  return `${styles.button}${className ? ` ${className}` : ""}`;
}
