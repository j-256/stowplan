"use client";

import {
  ChevronDown,
  ChevronRight,
  GripVertical,
  X,
} from "lucide-react";
import {
  useEffect,
  useRef,
  useState,
} from "react";
import type * as React from "react";
import { expectationsForCommand } from "../domain/expectations";
import type {
  FieldExpectation,
  Location,
  WorkspaceState,
} from "../domain/types";
import {
  COMPLETE_CAPTURE_STATUSES,
  LOCATION_POSITION,
  dismissFeedback,
  nextOrder,
  orderAfter,
  orderBefore,
  perform,
  showFeedback,
  sortLocations,
} from "./workspace-view-helpers";
import type {
  Commit,
  DragPayload,
  DropTarget,
  LocationChangeCommand,
  LocationHierarchyCommand,
  LocationPlacementCommand,
  LocationPlacementResult,
  PendingHierarchyChange,
  TreeEntry,
} from "./workspace-view-types";

const dragType = "application/x-stowplan-record";
const REORDER_DROP_MIDPOINT = 0.5;
const TOUCH_TAP_DISTANCE_PX = 8;

export function expectationFingerprint(
  expectations: FieldExpectation[],
): string {
  return JSON.stringify([...expectations].sort((left, right) =>
    `${left.target}:${left.id}:${left.path}`.localeCompare(
      `${right.target}:${right.id}:${right.path}`,
    )
  ));
}
export function flattenLocationTree(locations: Location[]): TreeEntry[] {
  const entries: TreeEntry[] = [];
  const seen = new Set<string>();
  const byId = new Map(locations.map((location) => [location.id, location]));
  const visitLocation = (location: Location, depth: number) => {
    if (seen.has(location.id)) return;
    seen.add(location.id);
    const children = sortLocations(locations.filter((candidate) => candidate.parentId === location.id));
    entries.push({ childCount: children.length, depth, location });
    for (const child of children) visitLocation(child, depth + 1);
  };
  for (const root of sortLocations(locations.filter((location) => location.parentId === null))) visitLocation(root, 0);
  for (const orphan of sortLocations(locations.filter((location) => location.parentId !== null && !byId.has(location.parentId)))) visitLocation(orphan, 0);
  for (const malformed of sortLocations(locations.filter((location) => !seen.has(location.id)))) visitLocation(malformed, 0);
  return entries;
}
export function locationPath(locations: Location[], locationId: string): Location[] {
  const byId = new Map(locations.map((location) => [location.id, location]));
  const path: Location[] = [];
  const seen = new Set<string>();
  let current = byId.get(locationId);
  while (current && !seen.has(current.id)) {
    seen.add(current.id);
    path.unshift(current);
    current = current.parentId ? byId.get(current.parentId) : undefined;
  }
  return path;
}
export function dropTargetAt(clientX: number, clientY: number): DropTarget | null {
  const target = document.elementFromPoint(clientX, clientY)?.closest<HTMLElement>("[data-drop-target]");
  if (!target) return null;
  const kind = target.dataset.dropTarget as DropTarget["kind"];
  const id = target.dataset.dropId || null;
  if (kind === "root") return { id: null, intent: "inside", kind };
  if ((kind !== "item" && kind !== "location") || !id) return null;
  const rectangle = target.getBoundingClientRect();
  const position = rectangle.height ? (clientY - rectangle.top) / rectangle.height : .5;
  if (kind === "item") {
    return { id, intent: position < .5 ? "before" : "after", kind };
  }
  return { id, intent: position < .28 ? "before" : position > .72 ? "after" : "inside", kind };
}
export function reorderDropTarget(
  element: HTMLElement,
  clientY: number,
  kind: "item" | "location",
  id: string,
): DropTarget {
  const rectangle = element.getBoundingClientRect();
  const position = rectangle.height
    ? (clientY - rectangle.top) / rectangle.height
    : REORDER_DROP_MIDPOINT;
  return {
    id,
    intent: position < REORDER_DROP_MIDPOINT ? "before" : "after",
    kind,
  };
}
export function reorderTargetAt(
  clientX: number,
  clientY: number,
  kind: "item" | "location",
): DropTarget | null {
  const target = document.elementFromPoint(clientX, clientY)?.closest<HTMLElement>(
    `[data-drop-target="${kind}"]`,
  );
  const id = target?.dataset.dropId;
  return target && id
    ? reorderDropTarget(target, clientY, kind, id)
    : null;
}
export function TouchDragHandle({
  expanded,
  label,
  onActiveChange,
  onDrop,
  onInvalidDrop,
  onTap,
  targetAt = dropTargetAt,
}: {
  expanded?: boolean;
  label: string;
  onActiveChange?: (active: boolean) => void;
  onDrop: (target: DropTarget) => void;
  onInvalidDrop?: () => void;
  onTap?: () => void;
  targetAt?: (clientX: number, clientY: number) => DropTarget | null;
}) {
  const active = useRef(false);
  const activeChange = useRef(onActiveChange);
  const activePointerId = useRef<number | null>(null);
  const autoScrollFrame = useRef<number | null>(null);
  const displayedTarget = useRef<DropTarget | null>(null);
  const highlighted = useRef<HTMLElement | null>(null);
  const pointer = useRef<{ clientX: number; clientY: number } | null>(null);
  const scrollContainer = useRef<HTMLElement | null>(null);
  const suppressTapClick = useRef(false);
  const touchStart = useRef<{ clientX: number; clientY: number } | null>(null);
  useEffect(() => {
    activeChange.current = onActiveChange;
  }, [onActiveChange]);
  useEffect(() => () => {
    active.current = false;
    if (autoScrollFrame.current !== null) {
      cancelAnimationFrame(autoScrollFrame.current);
    }
    activeChange.current?.(false);
    highlighted.current?.removeAttribute("data-touch-drop-active");
    highlighted.current?.removeAttribute("data-touch-drop-intent");
    document.documentElement.removeAttribute("data-touch-dragging");
  }, []);
  const clear = () => {
    active.current = false;
    if (autoScrollFrame.current !== null) {
      cancelAnimationFrame(autoScrollFrame.current);
      autoScrollFrame.current = null;
    }
    onActiveChange?.(false);
    highlighted.current?.removeAttribute("data-touch-drop-active");
    highlighted.current?.removeAttribute("data-touch-drop-intent");
    highlighted.current = null;
    displayedTarget.current = null;
    activePointerId.current = null;
    pointer.current = null;
    scrollContainer.current = null;
    touchStart.current = null;
    document.documentElement.removeAttribute("data-touch-dragging");
  };
  const highlight = (clientX: number, clientY: number) => {
    const dropTarget = targetAt(clientX, clientY);
    const candidate = document.elementFromPoint(clientX, clientY)?.closest<HTMLElement>("[data-drop-target]") ?? null;
    const target = dropTarget ? candidate : null;
    displayedTarget.current = target ? dropTarget : null;
    highlighted.current?.removeAttribute("data-touch-drop-active");
    highlighted.current?.removeAttribute("data-touch-drop-intent");
    highlighted.current = target;
    target?.setAttribute("data-touch-drop-active", "true");
    if (dropTarget) target?.setAttribute("data-touch-drop-intent", dropTarget.intent);
  };
  const scrollAtEdge = (clientY: number): boolean => {
    const scrollable = scrollContainer.current;
    if (scrollable) {
      const bounds = scrollable.getBoundingClientRect();
      if (clientY < bounds.top + 48) {
        scrollable.scrollBy({ top: -18, behavior: "auto" });
        return true;
      }
      if (clientY > bounds.bottom - 48) {
        scrollable.scrollBy({ top: 18, behavior: "auto" });
        return true;
      }
      return false;
    }
    if (clientY < 72) {
      window.scrollBy({ top: -18, behavior: "auto" });
      return true;
    }
    if (clientY > window.innerHeight - 92) {
      window.scrollBy({ top: 18, behavior: "auto" });
      return true;
    }
    return false;
  };
  const autoScroll = () => {
    const current = pointer.current;
    if (!active.current || !current) {
      autoScrollFrame.current = null;
      return;
    }
    const start = touchStart.current;
    const movedBeyondTap = Boolean(
      start &&
      Math.hypot(
        current.clientX - start.clientX,
        current.clientY - start.clientY,
      ) > TOUCH_TAP_DISTANCE_PX,
    );
    if (movedBeyondTap && scrollAtEdge(current.clientY)) {
      highlight(current.clientX, current.clientY);
    }
    autoScrollFrame.current = requestAnimationFrame(autoScroll);
  };
  const track = (clientX: number, clientY: number) => {
    pointer.current = { clientX, clientY };
    highlight(clientX, clientY);
  };
  const handleClick = (event: React.MouseEvent<HTMLElement>) => {
    if (!onTap) return;
    event.stopPropagation();
    if (suppressTapClick.current) {
      suppressTapClick.current = false;
      return;
    }
    onTap();
  };
  const handleDragStart = (event: React.DragEvent<HTMLElement>) => {
    if (!active.current) return;
    event.preventDefault();
    event.stopPropagation();
  };
  const handlePointerDown = (event: React.PointerEvent<HTMLElement>) => {
    if (event.pointerType === "mouse" || active.current) return;
    event.preventDefault();
    active.current = true;
    activePointerId.current = event.pointerId;
    touchStart.current = {
      clientX: event.clientX,
      clientY: event.clientY,
    };
    const scrollCandidates = [
      event.currentTarget.closest<HTMLElement>(".capture-tree"),
      event.currentTarget.closest<HTMLElement>(".app-shell > main"),
    ];
    scrollContainer.current = scrollCandidates.find((candidate) => {
      if (!candidate || candidate.scrollHeight <= candidate.clientHeight) {
        return false;
      }
      const overflowY = getComputedStyle(candidate).overflowY;
      return overflowY === "auto" || overflowY === "scroll";
    }) ?? null;
    onActiveChange?.(true);
    event.currentTarget.setPointerCapture(event.pointerId);
    document.documentElement.dataset.touchDragging = "true";
    track(event.clientX, event.clientY);
    autoScrollFrame.current = requestAnimationFrame(autoScroll);
  };
  const handlePointerMove = (event: React.PointerEvent<HTMLElement>) => {
    if (
      active.current &&
      event.pointerId === activePointerId.current
    ) {
      track(event.clientX, event.clientY);
    }
  };
  const handlePointerUp = (event: React.PointerEvent<HTMLElement>) => {
      if (
        !active.current ||
        event.pointerId !== activePointerId.current
      ) return;
      const start = touchStart.current;
      const tapped = Boolean(
        onTap &&
        start &&
        Math.hypot(
          event.clientX - start.clientX,
          event.clientY - start.clientY,
        ) <= TOUCH_TAP_DISTANCE_PX,
      );
      const target = displayedTarget.current ??
        targetAt(event.clientX, event.clientY);
      clear();
      if (tapped) return;
      suppressTapClick.current = true;
      setTimeout(() => {
        suppressTapClick.current = false;
      }, 0);
      if (target) onDrop(target);
      else onInvalidDrop?.();
  };
  const handlePointerCancel = (event: React.PointerEvent<HTMLElement>) => {
    if (event.pointerId === activePointerId.current) clear();
  };
  const sharedProps = {
    className: "drag-handle",
    draggable: true,
    onDragStart: handleDragStart,
    onPointerCancel: handlePointerCancel,
    onPointerDown: handlePointerDown,
    onPointerMove: handlePointerMove,
    onPointerUp: handlePointerUp,
    title: label,
  };
  const content = <>
    <GripVertical aria-hidden />
    {onTap && (expanded
      ? <ChevronDown aria-hidden />
      : <ChevronRight aria-hidden />)}
  </>;
  return onTap
    ? <button
        {...sharedProps}
        type="button"
        aria-expanded={expanded}
        aria-label={label}
        data-collapsible="true"
        onClick={handleClick}
      >
        {content}
      </button>
    : <span {...sharedProps} aria-hidden="true">{content}</span>;
}
export function writeDrag(event: React.DragEvent, payload: DragPayload): void {
  const value = JSON.stringify(payload);
  event.dataTransfer.effectAllowed = "move";
  event.dataTransfer.setData(dragType, value);
  event.dataTransfer.setData("text/plain", value);
}
export function readDrag(event: React.DragEvent): DragPayload | null {
  try {
    const parsed = JSON.parse(event.dataTransfer.getData(dragType) || event.dataTransfer.getData("text/plain")) as DragPayload;
    return parsed && (parsed.type === "item" || parsed.type === "location") ? parsed : null;
  } catch {
    return null;
  }
}

export function descendantIds(state: WorkspaceState, locationId: string): string[] {
  const found: string[] = [];
  const seen = new Set([locationId]);
  const queue = [locationId];
  while (queue.length) {
    const parent = queue.shift() as string;
    for (const child of state.locations.filter((location) => location.parentId === parent)) {
      if (seen.has(child.id)) continue;
      seen.add(child.id);
      found.push(child.id);
      queue.push(child.id);
    }
  }
  return found;
}

function displayedLocationParentId(
  locations: Location[],
  location: Location,
): string | null {
  return location.parentId &&
      locations.some((candidate) => candidate.id === location.parentId)
    ? location.parentId
    : null;
}

export function locationPlacementForDrop(
  state: WorkspaceState,
  sourceId: string,
  target: DropTarget,
): LocationPlacementResult {
  const live = state.locations.filter((location) => !location.archivedAt);
  const source = live.find((location) => location.id === sourceId);
  if (!source) return { error: "That space is no longer available" };
  const forbiddenParentIds = new Set([
    source.id,
    ...descendantIds(state, source.id),
  ]);
  if (target.kind === "root") {
    if (source.parentId === null) {
      return { error: `${source.name} is already at the top level` };
    }
    const siblings = live.filter((candidate) =>
      displayedLocationParentId(live, candidate) === null &&
      candidate.id !== source.id
    );
    return {
      command: {
        type: "location.move",
        id: source.id,
        parentId: null,
        order: nextOrder(siblings),
      },
      destinationParentId: null,
    };
  }
  if (target.kind !== "location" || !target.id) {
    return {
      error: "Spaces can only be dropped onto another space or the top-level target",
    };
  }
  if (source.id === target.id) {
    return { error: `Choose a different destination for ${source.name}` };
  }
  const destination = live.find((location) => location.id === target.id);
  if (!destination) return { error: "That destination is no longer available" };
  const destinationParentId = target.intent === "inside"
    ? destination.id
    : displayedLocationParentId(live, destination);
  if (
    destinationParentId !== null &&
    forbiddenParentIds.has(destinationParentId)
  ) {
    return { error: `${source.name} cannot be moved inside itself` };
  }
  const siblings = live.filter((candidate) =>
    displayedLocationParentId(live, candidate) === destinationParentId &&
    candidate.id !== source.id
  );
  const order = target.intent === "inside"
    ? nextOrder(siblings)
    : target.intent === "before"
      ? orderBefore(siblings, source.id, destination.id)
      : orderAfter(siblings, source.id, destination.id);
  if (order === null) {
    return { error: `Choose a different destination for ${source.name}` };
  }
  return {
    command: source.parentId === destinationParentId
      ? { type: "location.reorder", id: source.id, order }
      : {
          type: "location.move",
          id: source.id,
          parentId: destinationParentId,
          order,
        },
    destinationParentId,
  };
}

export function useHierarchyChanges({
  commit,
  findSourceTrigger,
  onApplied,
  state,
}: {
  commit: Commit;
  findSourceTrigger: (id: string) => HTMLElement | null;
  onApplied: (command: LocationChangeCommand) => void;
  state: WorkspaceState;
}) {
  const [busy, setBusy] = useState(false);
  const [movingLocationId, setMovingLocationId] = useState<string | null>(null);
  const [pending, setPending] = useState<PendingHierarchyChange | null>(null);
  const busyRef = useRef(false);
  const moveDialog = useRef<HTMLElement | null>(null);
  const reviewDialog = useRef<HTMLElement | null>(null);
  const trigger = useRef<HTMLElement | null>(null);
  const live = state.locations.filter((location) => !location.archivedAt);
  const movingLocation = movingLocationId
    ? live.find((location) => location.id === movingLocationId) ?? null
    : null;
  const pendingLocation = pending
    ? live.find((location) => location.id === pending.command.id) ?? null
    : null;
  const pendingCompletedParents = pending
    ? pending.completedParentIds
        .map((id) => live.find((location) => location.id === id))
        .filter((location): location is Location => Boolean(location))
    : [];
  const activeDialog = pending && pendingLocation
    ? "review"
    : movingLocation
      ? "move"
      : null;
  const completedParentIds = (
    command: LocationHierarchyCommand,
  ): string[] => {
    const location = live.find((candidate) => candidate.id === command.id);
    if (!location) return [];
    const parentId = command.type === "location.move"
      ? command.parentId
      : command.changes.parentId !== undefined
        ? command.changes.parentId
        : location.parentId;
    if (parentId === location.parentId) return [];
    return [...new Set([location.parentId, parentId])]
      .filter((id): id is string => Boolean(id))
      .filter((id) => {
        const parent = live.find((candidate) => candidate.id === id);
        return Boolean(
          parent &&
          COMPLETE_CAPTURE_STATUSES.has(parent.captureStatus),
        );
      });
  };
  const applyHierarchyChange = async (
    command: LocationHierarchyCommand,
    reopenCompletedParents = false,
  ): Promise<boolean> => {
    if (busyRef.current) {
      showFeedback("The hierarchy change is still in progress", "info");
      return false;
    }
    if (reopenCompletedParents && pending) {
      const currentExpectations = expectationsForCommand(state, command);
      if (
        expectationFingerprint(currentExpectations) !==
        expectationFingerprint(pending.expectations)
      ) {
        setPending(null);
        showFeedback(
          "This space changed while the move was open. Review its latest position before moving it.",
          "info",
        );
        return false;
      }
      const currentCompletedParentIds = completedParentIds(command);
      if (
        currentCompletedParentIds.length !== pending.completedParentIds.length ||
        currentCompletedParentIds.some(
          (id) => !pending.completedParentIds.includes(id),
        )
      ) {
        if (currentCompletedParentIds.length === 0) {
          setPending(null);
          return applyHierarchyChange(command);
        }
        setPending({
          command,
          completedParentIds: currentCompletedParentIds,
          expectations: currentExpectations,
        });
        showFeedback(
          "The affected completed spaces changed. Review the updated list before moving.",
          "info",
        );
        return false;
      }
    }
    busyRef.current = true;
    setBusy(true);
    const prepared: LocationHierarchyCommand = {
      ...command,
      reopenCompletedParents,
    };
    const applied = await perform(commit, prepared);
    busyRef.current = false;
    setBusy(false);
    if (applied) {
      setPending(null);
      setMovingLocationId(null);
      onApplied(command);
      const location = live.find((candidate) => candidate.id === command.id);
      showFeedback(
        `${location?.code ?? "Space"} · ${location?.name ?? "Space"} moved`,
        "success",
      );
    }
    return applied;
  };
  const requestHierarchyChange = async (
    command: LocationHierarchyCommand,
    sourceTrigger?: HTMLElement | null,
  ): Promise<boolean> => {
    const completed = completedParentIds(command);
    if (completed.length > 0) {
      trigger.current = sourceTrigger?.isConnected
        ? sourceTrigger
        : findSourceTrigger(command.id);
      dismissFeedback();
      setPending({
        command,
        completedParentIds: completed,
        expectations: expectationsForCommand(state, command),
      });
      return false;
    }
    return applyHierarchyChange(command);
  };
  const openMoveDialog = (
    location: Location,
    sourceTrigger: HTMLElement,
  ) => {
    trigger.current = sourceTrigger;
    setPending(null);
    setMovingLocationId(location.id);
  };
  const reviewPlacement = async (
    command: LocationPlacementCommand,
  ): Promise<void> => {
    setMovingLocationId(null);
    if (command.type === "location.move") {
      await requestHierarchyChange(command, trigger.current);
      return;
    }
    const applied = await perform(commit, command);
    if (!applied) return;
    onApplied(command);
    const location = live.find((candidate) => candidate.id === command.id);
    showFeedback(
      `${location?.code ?? "Space"} · ${location?.name ?? "Space"} reordered`,
      "success",
    );
  };
  useEffect(() => {
    if (!activeDialog) return;
    const dialog = activeDialog === "review"
      ? reviewDialog.current
      : moveDialog.current;
    const sourceTrigger = trigger.current;
    const frame = requestAnimationFrame(() =>
      dialog
        ?.querySelector<HTMLElement>("[data-dialog-initial-focus]")
        ?.focus()
    );
    const previousBodyOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        if (busyRef.current) {
          showFeedback("The hierarchy change is still in progress", "info");
          return;
        }
        if (activeDialog === "review") setPending(null);
        else setMovingLocationId(null);
        return;
      }
      if (event.key !== "Tab" || !dialog) return;
      const focusable = Array.from(
        dialog.querySelectorAll<HTMLElement>(
          "button:not(:disabled), select:not(:disabled), input:not(:disabled), textarea:not(:disabled), [href], [tabindex]:not([tabindex='-1'])",
        ),
      );
      if (focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    addEventListener("keydown", handleKeyDown);
    return () => {
      cancelAnimationFrame(frame);
      removeEventListener("keydown", handleKeyDown);
      document.body.style.overflow = previousBodyOverflow;
      if (sourceTrigger?.isConnected) sourceTrigger.focus();
    };
  }, [activeDialog]);
  return {
    applyHierarchyChange,
    busy,
    closeMoveDialog: () => setMovingLocationId(null),
    closeReviewDialog: () => setPending(null),
    moveDialog,
    movingLocation,
    openMoveDialog,
    pending,
    pendingCompletedParents,
    pendingLocation,
    requestHierarchyChange,
    reviewDialog,
    reviewPlacement,
  };
}

export function HierarchyChangeDialogs({
  controller,
  state,
}: {
  controller: ReturnType<typeof useHierarchyChanges>;
  state: WorkspaceState;
}) {
  const {
    applyHierarchyChange,
    busy,
    closeMoveDialog,
    closeReviewDialog,
    moveDialog,
    movingLocation,
    pending,
    pendingCompletedParents,
    pendingLocation,
    reviewDialog,
    reviewPlacement,
  } = controller;
  return <>
    {movingLocation && <div
      className="modal-backdrop hierarchy-modal-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !busy) {
          closeMoveDialog();
        }
      }}
    >
      <LocationMoveDialog
        dialogRef={moveDialog}
        location={movingLocation}
        onCancel={closeMoveDialog}
        onReview={reviewPlacement}
        state={state}
      />
    </div>}
    {pending && pendingLocation && <div
      className="modal-backdrop hierarchy-modal-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !busy) {
          closeReviewDialog();
        }
      }}
    >
      <section
        aria-describedby="hierarchy-review-description"
        aria-labelledby="hierarchy-review-title"
        aria-modal="true"
        className="modal hierarchy-review-dialog"
        ref={reviewDialog}
        role="dialog"
      >
        <header>
          <div>
            <p className="eyebrow">Capture safeguard</p>
            <h2 id="hierarchy-review-title">Reopen completed spaces?</h2>
          </div>
        </header>
        <p id="hierarchy-review-description">{`Moving ${pendingLocation.code} · ${pendingLocation.name} changes what was recorded inside these completed spaces. The move and reopen will be one undoable Activity entry.`}</p>
        <ul className="hierarchy-review-list">
          {pendingCompletedParents.map((location) => <li key={location.id}>
            <strong>{location.code} · {location.name}</strong>
            <span>Reopen as in progress</span>
          </li>)}
        </ul>
        <footer className="hierarchy-dialog-actions">
          <button
            type="button"
            data-dialog-initial-focus
            disabled={busy}
            onClick={closeReviewDialog}
          >
            Cancel
          </button>
          <button
            type="button"
            className="primary"
            disabled={busy}
            onClick={() => void applyHierarchyChange(pending.command, true)}
          >
            {busy ? "Moving..." : "Move and reopen"}
          </button>
        </footer>
      </section>
    </div>}
  </>;
}

function LocationMoveDialog({
  dialogRef,
  location,
  onCancel,
  onReview,
  state,
}: {
  dialogRef: React.RefObject<HTMLElement | null>;
  location: Location;
  onCancel: () => void;
  onReview: (command: LocationPlacementCommand) => Promise<void>;
  state: WorkspaceState;
}) {
  const [message, setMessage] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const invalidParentIds = new Set([
    location.id,
    ...descendantIds(state, location.id),
  ]);
  const live = state.locations.filter((candidate) => !candidate.archivedAt);
  const parentOptions = flattenLocationTree(
    live.filter((candidate) => !invalidParentIds.has(candidate.id)),
  );
  const [selectedParentId, setSelectedParentId] = useState(
    location.parentId ?? "",
  );
  const openedParentId = useRef(location.parentId);
  useEffect(() => {
    if (openedParentId.current === location.parentId) return;
    openedParentId.current = location.parentId;
    setSelectedParentId(location.parentId ?? "");
    setMessage(
      "This space moved while the dialog was open. Choose its position again.",
    );
  }, [location.parentId]);
  const positionSiblings = sortLocations(live.filter((candidate) =>
    candidate.parentId === (selectedParentId || null) &&
    candidate.id !== location.id
  ));
  const defaultPosition = positionSiblings.length
    ? `${LOCATION_POSITION.AFTER_PREFIX}${positionSiblings[positionSiblings.length - 1].id}`
    : LOCATION_POSITION.FIRST;
  const review = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (submitting) return;
    const data = new FormData(event.currentTarget);
    const parentId = String(data.get("parentId")) || null;
    const position = String(data.get("position"));
    const currentSiblings = sortLocations(
      live.filter((candidate) =>
        candidate.parentId === location.parentId
      ),
    );
    const currentIndex = currentSiblings.findIndex(
      (candidate) => candidate.id === location.id,
    );
    const siblings = sortLocations(live.filter((candidate) =>
      candidate.parentId === parentId &&
      candidate.id !== location.id
    ));
    const afterId = position.startsWith(LOCATION_POSITION.AFTER_PREFIX)
      ? position.slice(LOCATION_POSITION.AFTER_PREFIX.length)
      : null;
    const afterIndex = afterId
      ? siblings.findIndex((candidate) => candidate.id === afterId)
      : -1;
    if (
      position !== LOCATION_POSITION.FIRST &&
      (!afterId || afterIndex < 0)
    ) {
      setMessage("Choose an available position");
      return;
    }
    const desiredIndex = position === LOCATION_POSITION.FIRST
      ? 0
      : afterIndex + 1;
    const alreadyPlaced =
      parentId === location.parentId &&
      desiredIndex === currentIndex;
    if (alreadyPlaced) {
      setMessage(`${location.name} is already in that position`);
      return;
    }
    const order = position === LOCATION_POSITION.FIRST
      ? (siblings[0]?.order ?? 1) - 1
      : orderAfter(siblings, location.id, afterId as string);
    if (order === null) {
      setMessage("Choose an available position");
      return;
    }
    setSubmitting(true);
    await onReview(
      parentId === location.parentId
        ? { type: "location.reorder", id: location.id, order }
        : {
            type: "location.move",
            id: location.id,
            parentId,
            order,
          },
    );
    setSubmitting(false);
  };
  return <section
    aria-describedby="location-move-description"
    aria-labelledby="location-move-title"
    aria-modal="true"
    className="modal hierarchy-move-dialog"
    ref={dialogRef}
    role="dialog"
  >
    <header>
      <div>
        <p className="eyebrow">Hierarchy</p>
        <h2 id="location-move-title">Move {location.name}</h2>
      </div>
      <button
        type="button"
        className="icon"
        aria-label={`Close Move ${location.name}`}
        disabled={submitting}
        onClick={onCancel}
      >
        <X />
      </button>
    </header>
    <p id="location-move-description">Choose a parent and the exact position for this space.</p>
    <form className="hierarchy-move-form" onSubmit={review}>
      <label>
        Parent space
        <select
          data-dialog-initial-focus
          name="parentId"
          value={selectedParentId}
          onChange={(event) => {
            setMessage("");
            setSelectedParentId(event.currentTarget.value);
          }}
        >
          <option value="">Top level</option>
          {parentOptions.map(({ depth, location: candidate }) =>
            <option key={candidate.id} value={candidate.id}>
              {`${"  ".repeat(depth)}${depth ? "↳ " : ""}${candidate.code} · ${locationPath(live, candidate.id).map((part) => part.name).join(" › ")}`}
            </option>
          )}
        </select>
      </label>
      <label>
        Position
        <select
          key={selectedParentId || "root"}
          name="position"
          defaultValue={defaultPosition}
        >
          <option value={LOCATION_POSITION.FIRST}>First in parent</option>
          {positionSiblings.map((candidate) =>
            <option
              key={candidate.id}
              value={`${LOCATION_POSITION.AFTER_PREFIX}${candidate.id}`}
            >
              After {candidate.code} · {candidate.name}
            </option>
          )}
        </select>
      </label>
      {message && <output className="form-message">{message}</output>}
      <footer className="hierarchy-dialog-actions">
        <button type="button" disabled={submitting} onClick={onCancel}>
          Cancel
        </button>
        <button className="primary" disabled={submitting}>
          {submitting ? "Reviewing..." : "Review move"}
        </button>
      </footer>
    </form>
  </section>;
}
