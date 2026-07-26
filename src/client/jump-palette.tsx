"use client";

import {
  Activity,
  Boxes,
  ClipboardList,
  Map as MapIcon,
  PackagePlus,
  Search,
  Settings,
} from "lucide-react";
import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type {
  ItemRecord,
  Location,
  WorkspaceState,
} from "../domain/types";
import type { WorkspaceView } from "../domain/app-url";

type JumpResult = {
  action: () => void;
  detail: string;
  icon: typeof Boxes;
  id: string;
  kind: "item" | "space" | "view";
  label: string;
  searchText: string;
};

const MAX_JUMP_RESULTS = 14;
const JUMP_SCROLL_MARGIN_PX = 2;
const jumpViews: {
  icon: typeof Boxes;
  id: WorkspaceView;
  label: string;
  terms: string;
}[] = [
  { id: "capture", label: "Capture", icon: PackagePlus, terms: "add count record" },
  { id: "spaces", label: "Spaces", icon: MapIcon, terms: "rooms containers edit hierarchy" },
  { id: "inventory", label: "Inventory", icon: Boxes, terms: "items records search" },
  { id: "plan", label: "Plan", icon: ClipboardList, terms: "moves organize recommendations" },
  { id: "activity", label: "Activity", icon: Activity, terms: "history undo changes" },
  { id: "settings", label: "Settings", icon: Settings, terms: "preferences account backup" },
];

function locationLabel(
  location: Location,
  locations: readonly Location[],
): string {
  const byId = new Map(locations.map((candidate) => [candidate.id, candidate]));
  const parts: string[] = [];
  const seen = new Set<string>();
  let current: Location | undefined = location;
  while (current && !seen.has(current.id)) {
    seen.add(current.id);
    parts.unshift(current.name);
    current = current.parentId ? byId.get(current.parentId) : undefined;
  }
  return parts.join(" / ");
}

function itemLocation(
  item: ItemRecord,
  locations: readonly Location[],
): string {
  const location = locations.find((candidate) => candidate.id === item.locationId);
  return location ? locationLabel(location, locations) : "Unplaced";
}

export function JumpPalette({
  close,
  open,
  openItem,
  openLocation,
  openView,
  state,
}: {
  close: () => void;
  open: boolean;
  openItem: (id: string) => void;
  openLocation: (id: string) => void;
  openView: (view: WorkspaceView) => void;
  state: WorkspaceState;
}) {
  const [activeIndex, setActiveIndex] = useState(0);
  const [query, setQuery] = useState("");
  const dialog = useRef<HTMLElement | null>(null);
  const input = useRef<HTMLInputElement | null>(null);
  const previousFocus = useRef<HTMLElement | null>(null);

  useLayoutEffect(() => {
    if (!open) return;
    previousFocus.current = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
    input.current?.focus();
    const previousBodyOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = previousBodyOverflow;
      if (previousFocus.current?.isConnected) previousFocus.current.focus();
    };
  }, [open]);

  const results = useMemo(() => {
    const viewResults: JumpResult[] = jumpViews.map((entry) => ({
      action: () => openView(entry.id),
      detail: "Workspace page",
      icon: entry.icon,
      id: `view-${entry.id}`,
      kind: "view",
      label: entry.label,
      searchText: `${entry.label} ${entry.terms}`.toLocaleLowerCase(),
    }));
    const spaceResults: JumpResult[] = state.locations
      .filter((location) => !location.archivedAt)
      .map((location) => {
        const path = locationLabel(location, state.locations);
        return {
          action: () => openLocation(location.id),
          detail: `${location.code} · ${path}`,
          icon: MapIcon,
          id: `space-${location.id}`,
          kind: "space" as const,
          label: location.name,
          searchText: [
            location.code,
            path,
            location.kind,
            ...location.tags,
          ].join(" ").toLocaleLowerCase(),
        };
      });
    const itemResults: JumpResult[] = state.items
      .filter((item) => !item.archivedAt)
      .map((item) => {
        const location = itemLocation(item, state.locations);
        return {
          action: () => openItem(item.id),
          detail: `${item.quantity} ${item.unit} · ${location}`,
          icon: Boxes,
          id: `item-${item.id}`,
          kind: "item" as const,
          label: item.name,
          searchText: [
            item.name,
            item.category,
            item.notes,
            location,
            ...item.tags,
            ...item.constraints.requiredTags,
          ].join(" ").toLocaleLowerCase(),
        };
      });
    const normalized = query.trim().toLocaleLowerCase();
    const all = [...viewResults, ...spaceResults, ...itemResults];
    return (normalized
      ? all.filter((result) =>
          `${result.label.toLocaleLowerCase()} ${result.searchText}`
            .includes(normalized))
      : all
    ).slice(0, MAX_JUMP_RESULTS);
  }, [openItem, openLocation, openView, query, state]);

  useEffect(() => {
    if (!open) return;
    const activeResult = results[activeIndex] ?? results[0];
    if (!activeResult) return;
    const option = document.getElementById(`jump-option-${activeResult.id}`);
    if (option && dialog.current?.contains(option)) {
      const resultList = option.closest<HTMLElement>(".jump-results");
      const optionBounds = option.getBoundingClientRect();
      const listBounds = resultList?.getBoundingClientRect();
      if (resultList && listBounds) {
        const visibleTop = listBounds.top + JUMP_SCROLL_MARGIN_PX;
        const visibleBottom = listBounds.bottom - JUMP_SCROLL_MARGIN_PX;
        if (optionBounds.top < visibleTop) {
          resultList.scrollTop -= Math.ceil(visibleTop - optionBounds.top);
        } else if (optionBounds.bottom > visibleBottom) {
          resultList.scrollTop += Math.ceil(
            optionBounds.bottom - visibleBottom,
          );
        }
      }
    }
  }, [activeIndex, open, results]);

  if (!open) return null;
  const choose = (result: JumpResult | undefined) => {
    if (!result) return;
    close();
    result.action();
  };
  const activeResult = results[activeIndex] ?? results[0];

  return <div
    className="jump-backdrop"
    onMouseDown={(event) => {
      if (event.target === event.currentTarget) close();
    }}
  >
    <section
      className="jump-palette"
      ref={dialog}
      role="dialog"
      aria-modal="true"
      aria-labelledby="jump-palette-title"
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.preventDefault();
          close();
        } else if (event.key === "Tab") {
          const focusable = [
            ...(dialog.current?.querySelectorAll<HTMLElement>(
              "input:not(:disabled), button:not(:disabled)",
            ) ?? []),
          ].filter((element) => element.getClientRects().length > 0);
          const first = focusable[0];
          const last = focusable.at(-1);
          if (
            event.shiftKey &&
            (document.activeElement === first ||
              !dialog.current?.contains(document.activeElement))
          ) {
            event.preventDefault();
            last?.focus();
          } else if (
            !event.shiftKey &&
            (document.activeElement === last ||
              !dialog.current?.contains(document.activeElement))
          ) {
            event.preventDefault();
            first?.focus();
          }
        } else if (event.key === "ArrowDown") {
          event.preventDefault();
          const focusedElement = event.target instanceof HTMLElement
            ? event.target
            : null;
          const focusedIndex = focusedElement
            ? results.findIndex((result) =>
                focusedElement.id === `jump-option-${result.id}`
              )
            : -1;
          const currentIndex = focusedIndex >= 0 ? focusedIndex : activeIndex;
          const nextIndex = results.length
            ? (currentIndex + 1) % results.length
            : 0;
          setActiveIndex(nextIndex);
          if (event.target !== input.current) {
            document.getElementById(
              `jump-option-${results[nextIndex]?.id}`,
            )?.focus();
          }
        } else if (event.key === "ArrowUp") {
          event.preventDefault();
          const focusedElement = event.target instanceof HTMLElement
            ? event.target
            : null;
          const focusedIndex = focusedElement
            ? results.findIndex((result) =>
                focusedElement.id === `jump-option-${result.id}`
              )
            : -1;
          const currentIndex = focusedIndex >= 0 ? focusedIndex : activeIndex;
          const nextIndex = results.length
            ? (currentIndex - 1 + results.length) % results.length
            : 0;
          setActiveIndex(nextIndex);
          if (event.target !== input.current) {
            document.getElementById(
              `jump-option-${results[nextIndex]?.id}`,
            )?.focus();
          }
        } else if (event.key === "Enter" && event.target === input.current) {
          event.preventDefault();
          choose(activeResult);
        }
      }}
    >
      <h2 id="jump-palette-title">Search and jump</h2>
      <label className="jump-input">
        <Search />
        <input
          ref={input}
          role="combobox"
          aria-activedescendant={activeResult ? `jump-option-${activeResult.id}` : undefined}
          aria-controls="jump-results"
          aria-expanded="true"
          aria-label="Search views, spaces, and items"
          autoComplete="off"
          placeholder="Find a view, space, or item"
          value={query}
          onChange={(event) => {
            setQuery(event.target.value);
            setActiveIndex(0);
          }}
        />
        <kbd>Esc</kbd>
      </label>
      <div
        className="jump-results"
        id="jump-results"
        role="listbox"
        aria-label="Jump results"
      >
        {results.map((result, index) => {
          const Icon = result.icon;
          return <button
            type="button"
            id={`jump-option-${result.id}`}
            key={result.id}
            role="option"
            aria-selected={index === activeIndex}
            data-active={index === activeIndex}
            data-kind={result.kind}
            onClick={() => choose(result)}
            onFocus={() => setActiveIndex(index)}
            onMouseEnter={() => setActiveIndex(index)}
          >
            <span className="jump-result-icon"><Icon /></span>
            <span><strong>{result.label}</strong><small>{result.detail}</small></span>
            {result.kind !== "view" && <b>{result.kind}</b>}
          </button>;
        })}
        {!results.length && <p>No matching view, space, or item</p>}
      </div>
      <footer><span><kbd>↑</kbd><kbd>↓</kbd> move</span><span><kbd>Enter</kbd> open</span></footer>
    </section>
  </div>;
}
