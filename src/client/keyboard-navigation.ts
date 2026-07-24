"use client";

import { useEffect } from "react";

const ACTIVE_MODAL_SELECTOR = 'dialog[open],[aria-modal="true"]';
const FOCUS_VIEWPORT_MARGIN = 4;
const FOCUSABLE_SELECTOR = [
  "a[href]",
  "audio[controls]",
  "button",
  "input:not([type='hidden'])",
  "select",
  "summary",
  "textarea",
  "video[controls]",
  "[contenteditable]:not([contenteditable='false'])",
  "[tabindex]",
].join(",");
const NATIVE_ARROW_SELECTOR = [
  "audio[controls]",
  "input:not([type='checkbox'])",
  "select",
  "textarea",
  "video[controls]",
  "[contenteditable]:not([contenteditable='false'])",
  "[data-arrow-keys='native']",
  "[role='combobox']",
  "[role='grid']",
  "[role='listbox']",
  "[role='menu']",
  "[role='menubar']",
  "[role='option']",
  "[role='radiogroup']",
  "[role='scrollbar']",
  "[role='slider']",
  "[role='spinbutton']",
  "[role='tablist']",
  "[role='tree']",
].join(",");
const ARROW_DIRECTIONS = Object.freeze({
  ArrowDown: 1,
  ArrowLeft: -1,
  ArrowRight: 1,
  ArrowUp: -1,
} as const);

function isRendered(element: HTMLElement): boolean {
  if (
    !element.isConnected ||
    element.closest("[aria-hidden='true'],[inert]")
  ) {
    return false;
  }
  const styles = getComputedStyle(element);
  return (
    element.getClientRects().length > 0 &&
    styles.display !== "none" &&
    styles.visibility !== "hidden"
  );
}

function isAvailable(element: HTMLElement): boolean {
  return (
    element.tabIndex >= 0 &&
    !element.matches(":disabled") &&
    element.getAttribute("aria-disabled") !== "true" &&
    isRendered(element)
  );
}

function activeScope(): HTMLElement {
  const modals = [
    ...document.querySelectorAll<HTMLElement>(ACTIVE_MODAL_SELECTOR),
  ];
  return modals.reverse().find(isRendered) ?? document.body;
}

function focusableElements(scope: HTMLElement): HTMLElement[] {
  const elements = [
    ...scope.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR),
  ];
  if (scope.matches(FOCUSABLE_SELECTOR)) elements.unshift(scope);
  return elements.filter(isAvailable);
}

function nextFromDocumentPosition(
  elements: readonly HTMLElement[],
  active: HTMLElement,
  direction: 1 | -1,
): HTMLElement | undefined {
  if (direction === 1) {
    return elements.find((element) =>
      Boolean(
        active.compareDocumentPosition(element) &
          Node.DOCUMENT_POSITION_FOLLOWING,
      )
    ) ?? elements[0];
  }
  return elements.findLast((element) =>
    Boolean(
      active.compareDocumentPosition(element) &
        Node.DOCUMENT_POSITION_PRECEDING,
    )
  ) ?? elements.at(-1);
}

export function useArrowKeyNavigation(): void {
  useEffect(() => {
    const navigate = (event: KeyboardEvent) => {
      const direction =
        ARROW_DIRECTIONS[event.key as keyof typeof ARROW_DIRECTIONS];
      if (
        !direction ||
        event.defaultPrevented ||
        event.isComposing ||
        event.altKey ||
        event.ctrlKey ||
        event.metaKey ||
        event.shiftKey
      ) {
        return;
      }
      const target = event.target instanceof Element ? event.target : null;
      if (target?.closest(NATIVE_ARROW_SELECTOR)) return;

      const scope = activeScope();
      const available = focusableElements(scope);
      if (!available.length) return;
      const active = document.activeElement instanceof HTMLElement
        ? document.activeElement
        : document.body;
      const activeIndex = available.indexOf(active);
      const next = activeIndex >= 0
        ? available[
          (activeIndex + direction + available.length) % available.length
        ]
        : nextFromDocumentPosition(available, active, direction);
      if (!next) return;
      event.preventDefault();
      next.focus({ preventScroll: true });
      next.scrollIntoView({ block: "nearest", inline: "nearest" });
      const bounds = next.getBoundingClientRect();
      const bottomOverflow =
        bounds.bottom + FOCUS_VIEWPORT_MARGIN - innerHeight;
      if (bottomOverflow > 0) {
        scrollBy(0, Math.ceil(bottomOverflow));
      } else {
        const topOverflow = bounds.top - FOCUS_VIEWPORT_MARGIN;
        if (topOverflow < 0) scrollBy(0, Math.floor(topOverflow));
      }
    };
    addEventListener("keydown", navigate);
    return () => removeEventListener("keydown", navigate);
  }, []);
}

export function KeyboardNavigation(): null {
  useArrowKeyNavigation();
  return null;
}
