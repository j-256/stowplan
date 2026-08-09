"use client";

import {
  useEffect,
  useId,
  useRef,
  type MouseEvent,
  type RefObject,
  type ReactNode,
} from "react";
import styles from "./modal-dialog.module.css";

const FOCUSABLE_SELECTOR = [
  "a[href]",
  "button:not([disabled])",
  "input:not([disabled]):not([type='hidden'])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  "[tabindex]:not([tabindex='-1'])",
].join(",");

const FOCUS_FALLBACK_SELECTOR = [
  "[data-dialog-focus-fallback]",
  "main",
  "[role='main']",
  "section[aria-label]",
  "section[aria-labelledby]",
  "[role='region']",
].join(",");

function restorationAncestors(
  element: HTMLElement | null,
): HTMLElement[] {
  const ancestors: HTMLElement[] = [];
  let ancestor = element?.parentElement ?? null;
  while (ancestor && ancestor !== document.body) {
    ancestors.push(ancestor);
    ancestor = ancestor.parentElement;
  }
  return ancestors;
}

function restorationTarget(
  invokingElement: HTMLElement | null,
  ancestors: readonly HTMLElement[],
): HTMLElement | null {
  if (invokingElement?.isConnected) return invokingElement;
  return ancestors.find((ancestor) =>
    ancestor.isConnected && ancestor.matches(FOCUS_FALLBACK_SELECTOR)
  ) ?? document.querySelector<HTMLElement>(
    "[data-dialog-focus-fallback], main, [role='main']",
  );
}

function focusRestorationTarget(target: HTMLElement): void {
  const needsTemporaryTabIndex = !target.matches(FOCUSABLE_SELECTOR) &&
    !target.hasAttribute("tabindex");
  if (needsTemporaryTabIndex) target.setAttribute("tabindex", "-1");
  target.focus({ preventScroll: true });
  if (!needsTemporaryTabIndex) return;
  if (document.activeElement !== target) {
    target.removeAttribute("tabindex");
    return;
  }
  target.addEventListener("blur", () => {
    if (target.getAttribute("tabindex") === "-1") {
      target.removeAttribute("tabindex");
    }
  }, { once: true });
}

export interface ModalDialogProps {
  busy?: boolean;
  children: ReactNode;
  description?: ReactNode;
  destructive?: boolean;
  mobileSheet?: "content" | "full";
  onClose: () => void;
  open: boolean;
  returnFocusRef?: RefObject<HTMLElement | null>;
  title: string;
}

export function ModalDialog({
  busy = false,
  children,
  description,
  destructive = false,
  mobileSheet,
  onClose,
  open,
  returnFocusRef,
  title,
}: ModalDialogProps) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const invokingElementRef = useRef<HTMLElement | null>(null);
  const restorationAncestorsRef = useRef<HTMLElement[]>([]);
  const busyRef = useRef(busy);
  const onCloseRef = useRef(onClose);
  const titleId = useId();
  const descriptionId = useId();

  useEffect(() => {
    busyRef.current = busy;
    onCloseRef.current = onClose;
  }, [busy, onClose]);

  useEffect(() => {
    if (!open) return;
    const invokingElement = returnFocusRef?.current ??
      (
        document.activeElement instanceof HTMLElement
          ? document.activeElement
          : null
      );
    invokingElementRef.current = invokingElement;
    restorationAncestorsRef.current = restorationAncestors(invokingElement);
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const frame = requestAnimationFrame(() => {
      const dialog = dialogRef.current;
      if (!dialog) return;
      const initial = dialog.querySelector<HTMLElement>(
        "[data-dialog-initial-focus]",
      );
      const first = dialog.querySelector<HTMLElement>(FOCUSABLE_SELECTOR);
      (initial ?? first ?? dialog).focus();
    });
    const keydown = (event: KeyboardEvent) => {
      const dialog = dialogRef.current;
      if (!dialog) return;
      if (event.key === "Escape") {
        if (busyRef.current) return;
        event.preventDefault();
        onCloseRef.current();
        return;
      }
      if (event.key !== "Tab") return;
      const focusable = [...dialog.querySelectorAll<HTMLElement>(
        FOCUSABLE_SELECTOR,
      )].filter((element) => !element.hidden);
      if (focusable.length === 0) {
        event.preventDefault();
        dialog.focus();
        return;
      }
      const first = focusable[0];
      const last = focusable.at(-1);
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last?.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    addEventListener("keydown", keydown, true);
    return () => {
      cancelAnimationFrame(frame);
      removeEventListener("keydown", keydown, true);
      document.body.style.overflow = previousOverflow;
      const invokingElement = invokingElementRef.current;
      const ancestors = restorationAncestorsRef.current;
      requestAnimationFrame(() => {
        if (
          document.querySelector("[aria-modal='true'][role='dialog']") ||
          (
            document.activeElement instanceof HTMLElement &&
            document.activeElement !== document.body &&
            document.activeElement.isConnected
          )
        ) {
          return;
        }
        const target = restorationTarget(invokingElement, ancestors);
        if (target) focusRestorationTarget(target);
      });
    };
  }, [open, returnFocusRef]);

  if (!open) return null;

  const closeBackdrop = (event: MouseEvent<HTMLDivElement>) => {
    if (event.target === event.currentTarget && !busy) onClose();
  };

  return <div
    className={styles.backdrop}
    data-mobile-sheet={mobileSheet}
    onMouseDown={closeBackdrop}
  >
    <div
      aria-describedby={description ? descriptionId : undefined}
      aria-labelledby={titleId}
      aria-modal="true"
      className={styles.dialog}
      data-destructive={destructive}
      data-mobile-sheet={mobileSheet}
      ref={dialogRef}
      role="dialog"
      tabIndex={-1}
    >
      <header>
        <h2 id={titleId}>{title}</h2>
        {description && <div className={styles.description} id={descriptionId}>
          {description}
        </div>}
      </header>
      <div className={styles.content}>{children}</div>
    </div>
  </div>;
}
