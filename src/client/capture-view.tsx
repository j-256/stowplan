"use client";

import {
  useEffect,
  useRef,
  useState,
} from "react";
import type * as React from "react";
import {
  ArrowDown,
  ArrowUp,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  CircleDashed,
  Edit3,
  GripVertical,
  Info,
  PackageX,
  Plus,
  RotateCcw,
  Search,
  Trash2,
  X,
} from "lucide-react";
import {
  createItem,
  createLocation,
  DEFAULT_ITEM_QUANTITY,
  DEFAULT_ITEM_UNIT,
} from "../domain/factories";
import type {
  CaptureStatus,
  ItemRecord,
  Location,
  LocationKind,
  WorkspaceState,
} from "../domain/types";
import { nextCaptureLocation } from "./capture-order";
import { USER_GUIDE_URL } from "./external-links";
import { ItemEditor } from "./item-editor";
import {
  type CompactPanel,
  ResizablePanels,
} from "./resizable-panels";
import {
  dropTargetAt,
  flattenLocationTree,
  HierarchyChangeDialogs,
  locationPath,
  locationPlacementForDrop,
  readDrag,
  reorderDropTarget,
  reorderTargetAt,
  TouchDragHandle,
  useHierarchyChanges,
  writeDrag,
} from "./workspace-hierarchy";
import {
  COMPLETE_CAPTURE_STATUSES,
  countLabel,
  DEMO_ENTRY_FOCUS_DELAY_MS,
  dismissFeedback,
  Empty,
  LocationCreateFields,
  movedOrder,
  nextOrder,
  orderAfter,
  orderBefore,
  perform,
  SEARCH_BLOCKED_EVENT,
  showFeedback,
  sortItems,
  sortLocations,
  STACKED_TOUCH_LAYOUT_QUERY,
  submitForm,
} from "./workspace-view-helpers";
import type {
  Commit,
  ContainerReview,
  DragPayload,
  DropTarget,
  LocationChangeCommand,
} from "./workspace-view-types";

export function Capture({ state, current, select, commit, demoIntro, focusEditorKey }: { state: WorkspaceState; current: Location | null; select: (id: string) => void; commit: Commit; demoIntro: boolean; focusEditorKey: number | null }) {
  const [compactPanel, setCompactPanel] = useState<CompactPanel | null>(null);
  const activeCompactPanel = compactPanel ?? (
    current ? "secondary" : "primary"
  );
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());
  const [demoIntroDismissed, setDemoIntroDismissed] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);
  const [emptying, setEmptying] = useState(false);
  const [containerReview, setContainerReview] = useState<ContainerReview | null>(null);
  const [containerReviewNotice, setContainerReviewNotice] = useState("");
  const [containerCreatorOpen, setContainerCreatorOpen] = useState(false);
  const [editorNavigationKey, setEditorNavigationKey] = useState(0);
  const [captureRevealTarget, setCaptureRevealTarget] = useState<{
    id: string;
    token: number;
  } | null>(null);
  const [hierarchyDragging, setHierarchyDragging] = useState(false);
  const [nativeReorderCue, setNativeReorderCue] = useState<DropTarget | null>(null);
  const [nativeReorderSource, setNativeReorderSource] = useState<DragPayload | null>(null);
  const [queueQuery, setQueueQuery] = useState("");
  const emptyingRef = useRef(false);
  const containerReviewDialog = useRef<HTMLElement | null>(null);
  const containerReviewTrigger = useRef<HTMLElement | null>(null);
  const containerCreator = useRef<HTMLFormElement | null>(null);
  const restoreContainerReviewFocus = useRef(true);
  const editor = useRef<HTMLElement | null>(null);
  const live = state.locations.filter((location) => !location.archivedAt);
  const tree = flattenLocationTree(live);
  const normalizedQuery = queueQuery.trim().toLocaleLowerCase();
  const visibleIds = new Set<string>();
  for (const entry of tree) {
    if (!normalizedQuery || [entry.location.code, entry.location.name, ...entry.location.tags].join(" ").toLocaleLowerCase().includes(normalizedQuery)) {
      for (const ancestor of locationPath(live, entry.location.id)) visibleIds.add(ancestor.id);
    }
  }
  const queueShown = tree.filter((entry) =>
    visibleIds.has(entry.location.id) &&
    (
      normalizedQuery ||
      !locationPath(live, entry.location.id)
        .slice(0, -1)
        .some((ancestor) => collapsed.has(ancestor.id))
    )
  );
  const done = live.filter((location) =>
    COMPLETE_CAPTURE_STATUSES.has(location.captureStatus)
  ).length;
  const items = current ? sortItems(state.items.filter((item) => item.locationId === current.id && !item.archivedAt)) : [];
  const nested = current ? sortLocations(live.filter((location) => location.parentId === current.id)) : [];
  const breadcrumbs = current ? locationPath(live, current.id) : [];
  const captureComplete = current
    ? COMPLETE_CAPTURE_STATUSES.has(current.captureStatus)
    : false;
  const nextUncounted = current
    ? nextCaptureLocation(tree, current.id)
    : undefined;
  const revealCaptureHierarchyChange = (
    command: LocationChangeCommand,
  ) => {
    const location = live.find((candidate) => candidate.id === command.id);
    if (!location) return;
    const parentId = command.type === "location.move"
      ? command.parentId
      : command.type === "location.update" &&
          command.changes.parentId !== undefined
        ? command.changes.parentId
        : location.parentId;
    const ancestorIds = parentId
      ? locationPath(live, parentId).map((ancestor) => ancestor.id)
      : [];
    setCollapsed((currentCollapsed) => {
      const next = new Set(currentCollapsed);
      for (const ancestorId of ancestorIds) next.delete(ancestorId);
      return next;
    });
    setCompactPanel("primary");
    select(location.id);
    // Focus after the reorder commits. Doing it here in a bare
    // requestAnimationFrame can fire before React commits the reordered rows,
    // so the imperative focus lands on a stale node or is dropped by
    // reconciliation and never recovers. A commit-keyed effect defers it until
    // the target row is rendered, matching the editorNavigationKey pattern
    setCaptureRevealTarget((previous) => ({
      id: location.id,
      token: (previous?.token ?? 0) + 1,
    }));
  };
  const hierarchy = useHierarchyChanges({
    commit,
    findSourceTrigger: (id) => {
      const row = Array.from(
        document.querySelectorAll<HTMLElement>(
          ".capture-location-row[data-location-id]",
        ),
      ).find((candidate) => candidate.dataset.locationId === id);
      return row?.querySelector<HTMLButtonElement>(".queue-row") ?? null;
    },
    onApplied: revealCaptureHierarchyChange,
    state,
  });
  useEffect(() => {
    if (editorNavigationKey === 0) return;
    const frame = requestAnimationFrame(() => {
      const behavior = matchMedia("(prefers-reduced-motion: reduce)").matches
        ? "auto"
        : "smooth";
      editor.current?.scrollIntoView({ behavior, block: "start" });
      editor.current?.focus({ preventScroll: true });
    });
    return () => cancelAnimationFrame(frame);
  }, [editorNavigationKey]);
  useEffect(() => {
    if (!captureRevealTarget) return;
    const frame = requestAnimationFrame(() => {
      const row = Array.from(
        document.querySelectorAll<HTMLElement>(
          ".capture-location-row[data-location-id]",
        ),
      ).find(
        (candidate) => candidate.dataset.locationId === captureRevealTarget.id,
      );
      const behavior = matchMedia("(prefers-reduced-motion: reduce)").matches
        ? "auto"
        : "smooth";
      row?.scrollIntoView({ behavior, block: "center" });
      row?.querySelector<HTMLButtonElement>(".queue-row")?.focus({
        preventScroll: true,
      });
    });
    return () => cancelAnimationFrame(frame);
  }, [captureRevealTarget]);
  useEffect(() => {
    if (focusEditorKey === null) return;
    let focusFrame = 0;
    const panelFrame = requestAnimationFrame(() => {
      setCompactPanel("secondary");
      focusFrame = requestAnimationFrame(() => {
        const behavior = matchMedia("(prefers-reduced-motion: reduce)").matches
          ? "auto"
          : "smooth";
        editor.current?.scrollIntoView({ behavior, block: "start" });
        editor.current?.focus({ preventScroll: true });
      });
    });
    return () => {
      cancelAnimationFrame(panelFrame);
      cancelAnimationFrame(focusFrame);
    };
  }, [focusEditorKey]);
  useEffect(() => {
    if (!demoIntro) return;
    const timeout = setTimeout(() => {
      editor.current?.scrollIntoView({
        behavior: "auto",
        block: "start",
      });
      editor.current?.focus({ preventScroll: true });
    }, DEMO_ENTRY_FOCUS_DELAY_MS);
    return () => clearTimeout(timeout);
  }, [demoIntro]);
  useEffect(() => {
    if (!containerReview) return;
    const trigger = containerReviewTrigger.current;
    const frame = requestAnimationFrame(() =>
      containerReviewDialog.current
        ?.querySelector<HTMLButtonElement>("[data-container-review-cancel]")
        ?.focus()
    );
    const previousBodyOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      if (emptyingRef.current) {
        showFeedback("Emptying this container is still in progress", "info");
        return;
      }
      setContainerReview(null);
    };
    const explainBlockedSearch = (event: Event) => {
      event.preventDefault();
      setContainerReviewNotice("Close this review before searching");
    };
    addEventListener("keydown", closeOnEscape);
    addEventListener(SEARCH_BLOCKED_EVENT, explainBlockedSearch);
    return () => {
      cancelAnimationFrame(frame);
      removeEventListener("keydown", closeOnEscape);
      removeEventListener(SEARCH_BLOCKED_EVENT, explainBlockedSearch);
      document.body.style.overflow = previousBodyOverflow;
      if (restoreContainerReviewFocus.current && trigger?.isConnected) trigger.focus();
    };
  }, [containerReview]);
  const selectCaptureLocation = (
    id: string,
    focusEditorOnTouch = true,
  ) => {
    const ancestorIds = locationPath(live, id)
      .slice(0, -1)
      .map((ancestor) => ancestor.id);
    setCollapsed((currentCollapsed) => {
      const next = new Set(currentCollapsed);
      for (const ancestorId of ancestorIds) next.delete(ancestorId);
      return next;
    });
    setContainerCreatorOpen(false);
    select(id);
    if (
      focusEditorOnTouch &&
      matchMedia(STACKED_TOUCH_LAYOUT_QUERY).matches
    ) {
      setCompactPanel("secondary");
      setEditorNavigationKey((value) => value + 1);
    }
  };
  const revealContainerCreator = () => {
    setCompactPanel("primary");
    setContainerCreatorOpen(true);
    requestAnimationFrame(() => {
      const form = containerCreator.current;
      const behavior = matchMedia("(prefers-reduced-motion: reduce)").matches
        ? "auto"
        : "smooth";
      form?.scrollIntoView({ behavior, block: "center" });
      form?.querySelector<HTMLInputElement>('[name="name"]')?.focus({
        preventScroll: true,
      });
    });
  };
  const addContainer = async (data: FormData) => {
    const topLevel = data.get("topLevel") === "on";
    if (captureComplete && !topLevel) {
      showFeedback(`Reopen ${current?.name ?? "this space"} before adding a container`);
      return false;
    }
    const parentId = topLevel ? null : current?.id ?? null;
    const siblings = live.filter((location) => location.parentId === parentId);
    const created = await perform(commit, { type: "location.create", location: createLocation({ code: String(data.get("code")), name: String(data.get("name")), kind: String(data.get("kind")) as LocationKind, parentId, order: nextOrder(siblings) }) });
    if (created) setContainerCreatorOpen(false);
    return created;
  };
  const addItem = async (data: FormData): Promise<boolean> => {
    if (!current) return false;
    if (captureComplete) {
      showFeedback(`Reopen ${current.name} before adding an item`);
      return false;
    }
    const siblings = state.items.filter((item) => item.locationId === current.id && !item.archivedAt);
    return perform(commit, {
      type: "item.create",
      item: createItem({
        description: String(data.get("description")),
        locationId: current.id,
        name: String(data.get("name")),
        order: nextOrder(siblings),
        quantity: Number(data.get("quantity")),
        unit: String(data.get("unit")),
      }),
    });
  };
  const finish = async (status: CaptureStatus) => {
    if (!current) return;
    const next = nextCaptureLocation(tree, current.id);
    await perform(commit, { type: "capture.status", id: current.id, status }, () => {
      showFeedback(
        status === "known_empty"
          ? `${current.name} is marked known empty`
          : `${current.name} is marked counted`,
        "success",
      );
      if (next) selectCaptureLocation(next.id);
    });
  };
  const openContainerReview = (location: Location, trigger: HTMLElement) => {
    dismissFeedback();
    setContainerReviewNotice("");
    restoreContainerReviewFocus.current = true;
    containerReviewTrigger.current = trigger;
    setContainerReview({
      items: items.map((item) => ({
        id: item.id,
        name: item.name,
        quantity: item.quantity,
        unit: item.unit,
      })),
      locationId: location.id,
      locationName: location.name,
    });
  };
  const reviewEmptyContainer = (trigger: HTMLElement) => {
    if (!current) {
      showFeedback("Select a container before emptying it");
      return;
    }
    if (nested.length) {
      showFeedback(
        `${current.name} still contains ${nested.length} nested space${nested.length === 1 ? "" : "s"}. Move or remove them before emptying this container; no records were removed.`,
      );
      return;
    }
    if (!items.length) {
      showFeedback(
        `${current.name} has no recorded items. Use Checked empty & next to record that observation.`,
        "info",
      );
      return;
    }
    openContainerReview(current, trigger);
  };
  const markKnownEmpty = async () => {
    if (!current) {
      showFeedback("Select a container before marking it known empty");
      return;
    }
    if (nested.length) {
      showFeedback(
        `${current.name} still contains ${nested.length} nested space${nested.length === 1 ? "" : "s"}. Move or remove them first; no records were removed.`,
      );
      return;
    }
    if (items.length) {
      showFeedback(
        `${current.name} still has recorded items. Move or remove them first; no records were removed.`,
      );
      return;
    }
    await finish("known_empty");
  };
  const dismissContainerReview = () => {
    if (!containerReview) return;
    if (emptyingRef.current) {
      showFeedback("Emptying this container is still in progress", "info");
      return;
    }
    setContainerReview(null);
  };
  const emptyContainer = async () => {
    if (!containerReview) {
      showFeedback("Review this container before removing its records");
      return;
    }
    if (emptyingRef.current) {
      showFeedback("Emptying this container is still in progress", "info");
      return;
    }
    emptyingRef.current = true;
    setEmptying(true);
    const next = nextCaptureLocation(tree, containerReview.locationId);
    const applied = await perform(commit, {
      type: "capture.empty",
      id: containerReview.locationId,
      itemIds: containerReview.items.map((item) => item.id),
    }, () => {
      showFeedback(
        `${containerReview.locationName} was emptied and is now known empty. Undo is available in Activity.`,
        "success",
      );
      if (next) selectCaptureLocation(next.id);
    });
    emptyingRef.current = false;
    setEmptying(false);
    if (applied) {
      restoreContainerReviewFocus.current = false;
      setContainerReview(null);
    }
  };
  const reopenCapture = async () => {
    if (!current) {
      showFeedback("Select a container before reopening capture");
      return;
    }
    const status: CaptureStatus = items.length || nested.length
      ? "in_progress"
      : "uncounted";
    await perform(commit, {
      type: "capture.status",
      id: current.id,
      status,
    });
  };
  const reorderLocation = (location: Location, direction: -1 | 1) => {
    const siblings = live.filter((candidate) => candidate.parentId === location.parentId);
    const order = movedOrder(siblings, location.id, direction);
    if (order !== null) void perform(commit, { type: "location.reorder", id: location.id, order });
  };
  const clearNativeReorder = () => {
    setNativeReorderCue(null);
    setNativeReorderSource(null);
  };
  const startNativeReorder = (event: React.DragEvent, payload: DragPayload) => {
    setNativeReorderCue(null);
    setNativeReorderSource(payload);
    writeDrag(event, payload);
  };
  const endNativeReorder = () => clearNativeReorder();
  const canDropLocation = (sourceId: string, target: DropTarget) =>
    !("error" in locationPlacementForDrop(state, sourceId, target));
  const canDropItem = (sourceId: string, targetId: string) => {
    if (sourceId === targetId) return false;
    const source = state.items.find((item) => item.id === sourceId);
    const target = state.items.find((item) => item.id === targetId);
    return Boolean(source && target && source.locationId === target.locationId);
  };
  const leaveNativeReorderTarget = (
    event: React.DragEvent<HTMLElement>,
    kind: DropTarget["kind"],
    id: string,
  ) => {
    const remainsInside = event.relatedTarget instanceof Node &&
      event.currentTarget.contains(event.relatedTarget);
    if (
      !remainsInside &&
      nativeReorderCue?.kind === kind &&
      nativeReorderCue.id === id
    ) {
      setNativeReorderCue(null);
    }
  };
  const placeLocationByDrop = (
    payload: DragPayload | null,
    target: DropTarget,
  ) => {
    if (payload?.type !== "location") {
      showFeedback("That dragged space could not be read");
      return;
    }
    const placement = locationPlacementForDrop(state, payload.id, target);
    if ("error" in placement) {
      showFeedback(placement.error);
      return;
    }
    void hierarchy.reviewPlacement(placement.command);
  };
  const dragOverLocation = (
    event: React.DragEvent<HTMLElement>,
    fallback: DropTarget,
  ) => {
    const payload = readDrag(event) ?? nativeReorderSource;
    const target = dropTargetAt(event.clientX, event.clientY) ?? fallback;
    event.preventDefault();
    if (
      payload?.type !== "location" ||
      !canDropLocation(payload.id, target)
    ) {
      event.dataTransfer.dropEffect = "none";
      setNativeReorderCue(null);
      return;
    }
    event.dataTransfer.dropEffect = "move";
    setNativeReorderCue(target);
  };
  const dropOnLocation = (
    event: React.DragEvent<HTMLElement>,
    fallback: DropTarget,
  ) => {
    const payload = readDrag(event) ?? nativeReorderSource;
    event.preventDefault();
    event.stopPropagation();
    const target = dropTargetAt(event.clientX, event.clientY) ?? fallback;
    placeLocationByDrop(payload, target);
    clearNativeReorder();
  };
  const reorder = (id: string, direction: -1 | 1) => {
    if (captureComplete) {
      showFeedback(`Reopen ${current?.name ?? "this space"} before reordering its items`);
      return;
    }
    const order = movedOrder(items, id, direction);
    if (order !== null) void perform(commit, { type: "item.reorder", id, order });
  };
  const reorderByDrop = (payload: DragPayload | null, target: DropTarget) => {
    if (captureComplete) {
      showFeedback(`Reopen ${current?.name ?? "this space"} before reordering its items`);
      return;
    }
    if (payload?.type !== "item" || target.kind !== "item" || !target.id) return;
    const source = state.items.find((item) => item.id === payload.id);
    const targetItem = state.items.find((item) => item.id === target.id);
    if (!source || !targetItem || source.locationId !== targetItem.locationId) return;
    const order = target.intent === "after"
      ? orderAfter(items, source.id, targetItem.id)
      : orderBefore(items, source.id, targetItem.id);
    if (order !== null) void perform(commit, { type: "item.reorder", id: source.id, order });
  };
  const dragOverItem = (event: React.DragEvent<HTMLElement>, targetId: string) => {
    if (
      nativeReorderSource?.type !== "item" ||
      !canDropItem(nativeReorderSource.id, targetId)
    ) {
      event.preventDefault();
      event.dataTransfer.dropEffect = "none";
      setNativeReorderCue(null);
      return;
    }
    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
    setNativeReorderCue(
      reorderDropTarget(event.currentTarget, event.clientY, "item", targetId),
    );
  };
  const dropOnItem = (event: React.DragEvent<HTMLElement>, targetId: string) => {
    const payload = readDrag(event) ?? nativeReorderSource;
    if (payload?.type !== "item" || !canDropItem(payload.id, targetId)) {
      event.preventDefault();
      showFeedback("Items can only be reordered onto a different item in the same container");
      clearNativeReorder();
      return;
    }
    event.preventDefault();
    reorderByDrop(
      payload,
      reorderDropTarget(event.currentTarget, event.clientY, "item", targetId),
    );
    clearNativeReorder();
  };

  const CaptureStatusIcon = current?.captureStatus === "known_empty"
    ? PackageX
    : current?.captureStatus === "counted"
      ? CheckCircle2
      : CircleDashed;
  const hasNestedSpaces = nested.length > 0;
  const emptyItemsTitle = hasNestedSpaces
    ? "No direct items recorded"
    : captureComplete
      ? "No items recorded"
      : "Nothing recorded yet";
  const emptyItemsText = captureComplete
    ? `Reopen capture before adding ${hasNestedSpaces ? "a direct item" : "an item"}.`
    : hasNestedSpaces
      ? `${countLabel(nested.length, "nested space")} ${nested.length === 1 ? "is" : "are"} already recorded here. Add a direct item, or mark this space counted.`
      : "Add an item, or mark this space known empty.";
  const queuePanel = <section className="panel queue"><div className="title"><div><p className="eyebrow">First-pass coverage</p><h2>{done} of {live.length} checked</h2></div><b>{live.length - done} left</b></div><div className="progress"><i style={{ width: `${live.length ? done / live.length * 100 : 0}%` }} /></div>{live.length > 5 && <label className="queue-search"><Search /><input aria-label="Find container" autoComplete="off" name="containerQuery" value={queueQuery} onChange={(event) => setQueueQuery(event.target.value)} placeholder="Jump by code or name" /></label>}{live.length > 0 && <p className="capture-order-help">Drag onto the top, middle, or bottom of a row to place before, move inside, or place after. Use Move for a precise destination.</p>}<div className="capture-tree" role="list" aria-label="Container hierarchy" data-dragging={hierarchyDragging || nativeReorderSource?.type === "location" ? "true" : undefined}>
    <div
      className="capture-root-drop"
      data-drop-target="root"
      data-drop-intent={nativeReorderCue?.kind === "root" ? "inside" : undefined}
      onDragOver={(event) => dragOverLocation(event, {
        id: null,
        intent: "inside",
        kind: "root",
      })}
      onDrop={(event) => dropOnLocation(event, {
        id: null,
        intent: "inside",
        kind: "root",
      })}
    >
      Make top level
    </div>
    {queueShown.map(({ childCount, depth, location }) => {
      const siblings = sortLocations(live.filter((candidate) => candidate.parentId === location.parentId));
      const index = siblings.findIndex((candidate) => candidate.id === location.id);
      const validDrop = nativeReorderSource?.type === "location"
        ? canDropLocation(nativeReorderSource.id, {
            id: location.id,
            intent: "inside",
            kind: "location",
          })
        : null;
      const cue = nativeReorderCue?.kind === "location" &&
        nativeReorderCue.id === location.id
        ? nativeReorderCue.intent
        : undefined;
      const isCollapsed = collapsed.has(location.id);
      const canCollapse = childCount > 0 && !normalizedQuery;
      return <div className="capture-location-node" role="listitem" key={location.id}>
        <div
          className="capture-location-row"
          data-active={current?.id === location.id}
          data-depth={depth}
          data-dragging={nativeReorderSource?.type === "location" && nativeReorderSource.id === location.id ? "true" : undefined}
          data-drop-id={location.id}
          data-drop-intent={cue}
          data-drop-target="location"
          data-drop-valid={validDrop === null ? undefined : String(validDrop)}
          data-has-children={childCount > 0 ? "true" : undefined}
          data-location-id={location.id}
          draggable
          onDragEnd={endNativeReorder}
          onDragLeave={(event) => leaveNativeReorderTarget(event, "location", location.id)}
          onDragOver={(event) => dragOverLocation(event, {
            id: location.id,
            intent: "inside",
            kind: "location",
          })}
          onDragStart={(event) => startNativeReorder(event, {
            type: "location",
            id: location.id,
          })}
          onDrop={(event) => dropOnLocation(event, {
            id: location.id,
            intent: "inside",
            kind: "location",
          })}
        >
          <TouchDragHandle
            expanded={canCollapse ? !isCollapsed : undefined}
            label={canCollapse
              ? `${isCollapsed ? "Expand" : "Collapse"} ${location.name}; drag to move or nest it`
              : `Drag ${location.name} to move or nest it`}
            onActiveChange={setHierarchyDragging}
            targetAt={(clientX, clientY) => {
              const target = dropTargetAt(clientX, clientY);
              return target && canDropLocation(location.id, target)
                ? target
                : null;
            }}
            onDrop={(target) => placeLocationByDrop({
              type: "location",
              id: location.id,
            }, target)}
            onInvalidDrop={() => showFeedback(
              `Choose a valid destination for ${location.name}`,
            )}
            onTap={canCollapse
              ? () => setCollapsed((currentCollapsed) => {
                  const next = new Set(currentCollapsed);
                  if (next.has(location.id)) next.delete(location.id);
                  else next.add(location.id);
                  return next;
                })
              : undefined}
          />
          <button
            type="button"
            className="queue-row"
            aria-current={current?.id === location.id}
            data-active={current?.id === location.id}
            data-depth={depth}
            style={{ paddingLeft: 6 + depth * 8 }}
            onClick={() => selectCaptureLocation(location.id)}
          >
            <span className="hierarchy-marker" aria-hidden>{depth ? "↳" : "●"}</span>
            <span className="queue-name"><b>{location.code}</b><span>{location.name}</span></span>
            <small>{childCount ? `${childCount} inside · ` : ""}{location.captureStatus.replace("_", " ")}</small>
          </button>
          <span className="reorder-drop-copy" aria-hidden>
            {cue === "before"
              ? "Place before"
              : cue === "after"
                ? "Place after"
                : cue === "inside"
                  ? "Move inside"
                  : ""}
          </span>
          <div className="row-actions">
            <button type="button" className="icon small" aria-label={`Move ${location.name} up`} disabled={index === 0} onClick={() => reorderLocation(location, -1)}><ArrowUp /></button>
            <button type="button" className="icon small" aria-label={`Move ${location.name} down`} disabled={index === siblings.length - 1} onClick={() => reorderLocation(location, 1)}><ArrowDown /></button>
            <button type="button" className="icon small capture-move-action" aria-label={`Move ${location.name}`} onClick={(event) => hierarchy.openMoveDialog(location, event.currentTarget)}><GripVertical /><span>Move</span></button>
          </div>
        </div>
      </div>;
    })}</div>
    {queueShown.length === 0 && <p className="muted queue-empty">
      {live.length === 0
        ? "No containers yet. Add your first space below."
        : "No containers match this search."}
    </p>}
    <div
      className="capture-space-creator"
      data-open={!current || containerCreatorOpen ? "true" : undefined}
      data-required={!current ? "true" : undefined}
      key={`${current?.id ?? "root"}-${captureComplete ? "complete" : "open"}`}
    >
      <button
        aria-expanded={!current || containerCreatorOpen}
        className="creator-trigger"
        onClick={() => setContainerCreatorOpen((open) => !open)}
        type="button"
      >
        <Plus aria-hidden="true" />
        <span>{current
          ? captureComplete
            ? "Add an unrelated space"
            : `Add a space inside ${current.name}`
          : "Add your first space"}</span>
        <ChevronDown aria-hidden="true" />
      </button>
      {captureComplete
        ? <form
            className="nested"
            onSubmit={(event) => submitForm(event, addContainer)}
            ref={containerCreator}
          >
            <LocationCreateFields
              defaultKind="room"
              existingCodes={live.map((location) => location.code)}
              kindLabel="Space type"
              namePlaceholder="Friendly name (e.g. garage)"
            />
            <input type="hidden" name="topLevel" value="on" />
            <button>Add top-level space</button>
          </form>
        : <form
            className="nested"
            onSubmit={(event) => submitForm(event, addContainer)}
            ref={containerCreator}
          >
            <LocationCreateFields
              defaultKind={current ? "box" : "room"}
              existingCodes={live.map((location) => location.code)}
              kindLabel="Container type"
              namePlaceholder={current
                ? "Friendly name (e.g. winter gear bin)"
                : "Friendly name (e.g. apartment)"}
            />
            {current && <label className="top-level">
              <input type="checkbox" name="topLevel" /> Add as another top-level space
            </label>}
            <button>{current ? `Add inside ${current.name}` : "Add first space"}</button>
          </form>}
    </div>
  </section>;
  const demoIntroPanel = demoIntro && !demoIntroDismissed
    ? <aside
        aria-label="Kitchen demo task"
        className="capture-demo-intro"
      >
        <Info aria-hidden="true" />
        <span>
          <strong>{captureComplete ? "Keep exploring" : "Try one change"}</strong>
          <small>{captureComplete
            ? "This demo container is complete. Reopen it to make another change, or reset the kitchen from Workspaces."
            : "Add a sample item below, choose Save & add next, then finish this container with Counted & next. Signed-in demos may back up online."}</small>
          <a href={USER_GUIDE_URL} rel="noreferrer" target="_blank">
            Open the step-by-step demo guide
          </a>
        </span>
        <button
          aria-label="Dismiss demo task"
          className="icon small"
          onClick={() => setDemoIntroDismissed(true)}
          type="button"
        >
          <X />
        </button>
      </aside>
    : null;
  const emptyContainerAction = !captureComplete &&
      items.length > 0 &&
      !hasNestedSpaces
    ? <button
        className="empty-container-action"
        onClick={(event) => reviewEmptyContainer(event.currentTarget)}
        type="button"
      >
        <PackageX aria-hidden="true" />
        <span>
          <strong>Container is now empty...</strong>
          <small>Review removing all recorded contents</small>
        </span>
      </button>
    : null;
  const capturePanel = <section
    aria-label={current ? `Capture inside ${current.name}` : "Capture editor"}
    className="panel capture-card"
    ref={editor}
    tabIndex={-1}
  >
    {current ? <>
      <nav className="breadcrumbs" aria-label="Current container path">
        {breadcrumbs.map((location, index) => <span key={location.id}>
          {index > 0 && <i aria-hidden>›</i>}
          <button onClick={() => selectCaptureLocation(location.id)}>
            {location.code}
          </button>
        </span>)}
      </nav>
      <div className="title">
        <div>
          <p className="eyebrow">Inside this container</p>
          <h2>{current.code} · {current.name}</h2>
        </div>
        <span
          className="tag capture-status"
          data-status={current.captureStatus}
        >
          <CaptureStatusIcon />
          <span>{current.captureStatus.replace("_", " ")}</span>
        </span>
      </div>
      {demoIntroPanel}
      {(!captureComplete || nextUncounted) && <div
        className="capture-context-actions"
        data-has-add={!captureComplete ? "true" : undefined}
      >
        {!captureComplete && <button
          className="capture-add-inside"
          onClick={revealContainerCreator}
          type="button"
        >
          <Plus aria-hidden="true" />
          <span>Add container inside {current.name}</span>
        </button>}
        {nextUncounted && <button
          className="capture-next-location"
          onClick={() => selectCaptureLocation(nextUncounted.id)}
          type="button"
        >
          <span>{captureComplete ? "Continue count" : "Skip for now"}{" "}</span>
          <strong>{nextUncounted.code} · {nextUncounted.name}</strong>
          <ChevronRight aria-hidden="true" />
        </button>}
      </div>}
      {captureComplete
        ? <div className="capture-locked" role="status">
            <CheckCircle2 />
            <span>
              <strong>Capture is complete</strong>
              <small>Reopen this space before adding, editing, or reordering its contents.</small>
            </span>
          </div>
        : <form key={current.id} className="quick" onSubmit={(event) => submitForm(event, addItem, true, '[name="name"]')}>
      <div className="quick-primary">
        <label className="grow">What is it?<input required name="name" placeholder="e.g. winter gloves" /></label>
        <label>Qty<input required type="number" min="0.01" step="any" name="quantity" defaultValue={DEFAULT_ITEM_QUANTITY} /></label>
        <button className="primary">Save & add next</button>
      </div>
      <details className="quick-optional">
        <summary><span>Add description or unit</span><small>Optional</small></summary>
        <div className="quick-optional-fields">
          <label className="grow">Description<textarea name="description" placeholder="Color, condition, or other identifying details" /></label>
          <label>Unit<input required name="unit" defaultValue={DEFAULT_ITEM_UNIT} list="capture-units" /><datalist id="capture-units"><option value="each" /><option value="boxes" /><option value="bags" /><option value="cans" /><option value="pairs" /></datalist></label>
        </div>
      </details>
    </form>}
      {nested.length > 0 && <div className="nested-list"><small>Nested containers</small>{nested.map((location) => <button key={location.id} onClick={() => selectCaptureLocation(location.id)}><b>{location.code}</b><span>{location.name}</span><small>{location.captureStatus.replace("_", " ")}</small></button>)}</div>}
      <div className="captured">{items.map((item, index) => {
        const validDrop = nativeReorderSource?.type === "item"
          ? canDropItem(nativeReorderSource.id, item.id)
          : null;
        const cue = nativeReorderCue?.kind === "item" &&
          nativeReorderCue.id === item.id
          ? nativeReorderCue.intent
          : undefined;
        return <div
          className="captured-row"
          data-dragging={nativeReorderSource?.type === "item" && nativeReorderSource.id === item.id ? "true" : undefined}
          data-drop-id={captureComplete ? undefined : item.id}
          data-drop-intent={cue}
          data-drop-target={captureComplete ? undefined : "item"}
          data-drop-valid={validDrop === null ? undefined : String(validDrop)}
          data-item-id={item.id}
          key={item.id}
          draggable={!captureComplete}
          onDragEnd={captureComplete ? undefined : endNativeReorder}
          onDragLeave={captureComplete ? undefined : (event) => leaveNativeReorderTarget(event, "item", item.id)}
          onDragOver={captureComplete ? undefined : (event) => dragOverItem(event, item.id)}
          onDragStart={captureComplete ? undefined : (event) => startNativeReorder(event, { type: "item", id: item.id })}
          onDrop={captureComplete ? undefined : (event) => dropOnItem(event, item.id)}
        >
          {captureComplete ? <span className="capture-readonly-marker" aria-hidden><CheckCircle2 /></span> : <TouchDragHandle label={`Drag ${item.name} to reorder`} targetAt={(clientX, clientY) => {
            const target = reorderTargetAt(clientX, clientY, "item");
            return target?.id && canDropItem(item.id, target.id) ? target : null;
          }} onDrop={(target) => reorderByDrop({ type: "item", id: item.id }, target)} onInvalidDrop={() => showFeedback("Items can only be reordered onto a different item in the same container")} />}
          <b>{item.quantity} {item.unit}</b>
          {captureComplete ? <span className="item-name"><strong>{item.name}</strong><small>{item.description || `${item.category} · ${item.frequency}`}</small></span> : <button className="item-name" onClick={() => setEditing(item.id)}><strong>{item.name}</strong><small>{item.description || `${item.category} · ${item.frequency}`}</small></button>}
          <span className="reorder-drop-copy" aria-hidden>{cue === "before" ? "Place before" : cue === "after" ? "Place after" : ""}</span>
          {!captureComplete && <div className="row-actions"><button className="icon small" aria-label={`Move ${item.name} up`} disabled={index === 0} onClick={() => reorder(item.id, -1)}><ArrowUp /></button><button className="icon small" aria-label={`Move ${item.name} down`} disabled={index === items.length - 1} onClick={() => reorder(item.id, 1)}><ArrowDown /></button><button className="icon small" aria-label={`Edit ${item.name}`} onClick={() => setEditing(item.id)}><Edit3 /></button></div>}
        </div>;
      })}{!items.length && <Empty title={emptyItemsTitle} text={emptyItemsText} />}</div>{emptyContainerAction}<div className="finish">{captureComplete ? <button className="reopen-capture" onClick={() => void reopenCapture()}><RotateCcw /><span>Reopen capture</span></button> : <>{!hasNestedSpaces && items.length === 0 && <button className="known-empty-action" onClick={() => void markKnownEmpty()}><PackageX /><span>Checked empty & next</span></button>}<button className="primary" onClick={() => void finish("counted")}><CheckCircle2 /><span>Counted & next</span></button></>}</div></> : <Empty title="Add your first space" text="Give a room, cabinet, box, or drawer the same code as its physical label." />}</section>;
  return <>
    <ResizablePanels
      activeCompactPanel={activeCompactPanel}
      className="content capture"
      defaultPanelPercent={42}
      label="Capture panels"
      onCompactPanelChange={setCompactPanel}
      primary={queuePanel}
      primaryLabel="capture queue"
      secondary={capturePanel}
      secondaryLabel="current container"
      storageId="capture"
    />
    <HierarchyChangeDialogs controller={hierarchy} state={state} />
    {containerReview && <div
      className="modal-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) dismissContainerReview();
      }}
    >
      <section
        aria-describedby="container-review-description"
        aria-labelledby="container-review-title"
        aria-modal="true"
        className="modal container-review-dialog"
        onKeyDown={(event) => {
          if (event.key !== "Tab") return;
          const focusable = [
            ...(containerReviewDialog.current?.querySelectorAll<HTMLButtonElement>(
              "button:not(:disabled)",
            ) ?? []),
          ];
          const first = focusable[0];
          const last = focusable.at(-1);
          if (
            event.shiftKey &&
            (document.activeElement === first ||
              !containerReviewDialog.current?.contains(document.activeElement))
          ) {
            event.preventDefault();
            last?.focus();
          } else if (
            !event.shiftKey &&
            (document.activeElement === last ||
              !containerReviewDialog.current?.contains(document.activeElement))
          ) {
            event.preventDefault();
            first?.focus();
          }
        }}
        ref={containerReviewDialog}
        role="dialog"
        tabIndex={-1}
      >
        <header>
          <div>
            <p className="eyebrow">Destructive inventory action</p>
            <h2 id="container-review-title">Empty container?</h2>
          </div>
          <button
            aria-label="Close empty container review"
            className="icon"
            disabled={emptying}
            onClick={dismissContainerReview}
          >
            <X />
          </button>
        </header>
        {containerReviewNotice && <output
          className="container-review-notice"
          role="status"
        >
          <Info />
          <span>{containerReviewNotice}</span>
        </output>}
        <p id="container-review-description">
          This action removes the item records below from <strong>{containerReview.locationName}</strong> and marks the space known empty as one undoable change. Use it only after the physical contents are gone.
        </p>
        <ul className="container-review-list">
          {containerReview.items.map((item) => <li key={item.id}>
            <span>{item.name}</span>
            <b>{item.quantity} {item.unit}</b>
          </li>)}
        </ul>
        <footer className="container-review-actions">
          <button
            data-container-review-cancel
            disabled={emptying}
            onClick={dismissContainerReview}
          >
            Keep records
          </button>
          <button
            className="danger"
            disabled={emptying}
            onClick={() => void emptyContainer()}
          >
            <Trash2 />
            {emptying ? "Emptying..." : "Empty container"}
          </button>
        </footer>
      </section>
    </div>}
    {editing && state.items.find((item) => item.id === editing) && <ItemEditor item={state.items.find((item) => item.id === editing) as ItemRecord} state={state} commit={commit} close={() => setEditing(null)} />}
  </>;
}
