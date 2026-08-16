"use client";

import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import type * as React from "react";
import {
  Archive,
  ArrowDown,
  ArrowUp,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Edit3,
  GripVertical,
  Info,
  Menu,
  Plus,
  RotateCcw,
  Trash2,
} from "lucide-react";
import { createLocation } from "../domain/factories";
import type {
  ItemRecord,
  Location,
  LocationKind,
  WorkspaceState,
} from "../domain/types";
import { ItemEditor } from "./item-editor";
import { ModalDialog } from "./modal-dialog";
import {
  type CompactPanel,
  ResizablePanels,
} from "./resizable-panels";
import {
  descendantIds,
  dropTargetAt,
  flattenLocationTree,
  HierarchyChangeDialogs,
  locationPath,
  locationPlacementForDrop,
  readDrag,
  TouchDragHandle,
  useHierarchyChanges,
  writeDrag,
} from "./workspace-hierarchy";
import {
  COMPLETE_CAPTURE_STATUSES,
  countLabel,
  Empty,
  LOCATION_KINDS,
  LocationCreateFields,
  locationFormValues,
  movedOrder,
  nextOrder,
  optionalDimensions,
  perform,
  reconcileUntouchedFormControls,
  showFeedback,
  sortItems,
  sortLocations,
  SPACES_MIN_SIDE_BY_SIDE_WIDTH,
  splitList,
  STACKED_TOUCH_LAYOUT_QUERY,
  submitForm,
  useMediaQuery,
} from "./workspace-view-helpers";
import type {
  Commit,
  DragPayload,
  DropTarget,
  GuidanceFocus,
  LocationChangeCommand,
  LocationHierarchyCommand,
} from "./workspace-view-types";

export function Spaces({ state, current, select, commit, focusEditorKey, focusEditorSection }: { state: WorkspaceState; current: Location | null; select: (id: string) => void; commit: Commit; focusEditorKey: number | null; focusEditorSection?: GuidanceFocus }) {
  const compactLayout = useMediaQuery(STACKED_TOUCH_LAYOUT_QUERY);
  const [compactPanel, setCompactPanel] = useState<CompactPanel>(
    focusEditorKey === null ? "primary" : "secondary",
  );
  const [editingItem, setEditingItem] = useState<string | null>(null);
  const [dragPayload, setDragPayload] = useState<DragPayload | null>(null);
  const [dragging, setDragging] = useState(false);
  const [dropCue, setDropCue] = useState<DropTarget | null>(null);
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());
  const [spaceActionsLocationId, setSpaceActionsLocationId] = useState<
    string | null
  >(null);
  const inspector = useRef<HTMLElement | null>(null);
  const spaceActionsTrigger = useRef<HTMLButtonElement | null>(null);
  useEffect(() => {
    if (focusEditorKey === null) return;
    let focusFrame = 0;
    const panelFrame = requestAnimationFrame(() => {
      setCompactPanel("secondary");
      focusFrame = requestAnimationFrame(() => {
        const behavior = matchMedia("(prefers-reduced-motion: reduce)").matches
          ? "auto"
          : "smooth";
        const target = focusEditorSection
          ? inspector.current?.querySelector<HTMLElement>(
              `[data-guidance-section="${focusEditorSection}"]`,
            )
          : inspector.current;
        const disclosure = target?.closest<HTMLDetailsElement>(
          ".space-advanced",
        );
        if (disclosure) disclosure.open = true;
        target?.scrollIntoView({ behavior, block: "start" });
        target?.focus({ preventScroll: true });
      });
    });
    return () => {
      cancelAnimationFrame(panelFrame);
      cancelAnimationFrame(focusFrame);
    };
  }, [focusEditorKey, focusEditorSection]);
  const live = state.locations.filter((location) => !location.archivedAt);
  const archived = state.locations.filter((location) => location.archivedAt);
  const liveIds = new Set(live.map((location) => location.id));
  const visibleChildren = (parentId: string | null) => parentId === null
    ? live.filter((location) => location.parentId === null || (location.parentId !== null && !liveIds.has(location.parentId)))
    : live.filter((location) => location.parentId === parentId);
  const chooseLocation = (id: string) => {
    select(id);
  };
  const focusTreeLocation = (id: string) => {
    setCompactPanel("primary");
    const frame = requestAnimationFrame(() => {
      const row = Array.from(
        document.querySelectorAll<HTMLElement>(".tree-row[data-location-id]"),
      ).find((candidate) => candidate.dataset.locationId === id);
      const behavior = matchMedia("(prefers-reduced-motion: reduce)").matches
        ? "auto"
        : "smooth";
      row?.scrollIntoView({ behavior, block: "center" });
      row?.querySelector<HTMLButtonElement>(".tree-select")?.focus({
        preventScroll: true,
      });
    });
    return () => cancelAnimationFrame(frame);
  };
  const revealHierarchyChange = (
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
    if (parentId) {
      const ancestorIds = locationPath(live, parentId).map(
        (ancestor) => ancestor.id,
      );
      setCollapsed((current) => {
        const next = new Set(current);
        for (const ancestorId of ancestorIds) next.delete(ancestorId);
        return next;
      });
    }
    chooseLocation(location.id);
    focusTreeLocation(location.id);
  };
  const hierarchy = useHierarchyChanges({
    commit,
    findSourceTrigger: (id) => {
      const row = Array.from(
        document.querySelectorAll<HTMLElement>(
          ".tree-row[data-location-id]",
        ),
      ).find((candidate) => candidate.dataset.locationId === id);
      return row?.querySelector<HTMLButtonElement>(".tree-select") ?? null;
    },
    onApplied: revealHierarchyChange,
    state,
  });
  const { openMoveDialog, requestHierarchyChange } = hierarchy;
  const showInspector = (location: Location) => {
    chooseLocation(location.id);
    setCompactPanel("secondary");
    const frame = requestAnimationFrame(() => {
      const behavior = matchMedia("(prefers-reduced-motion: reduce)").matches
        ? "auto"
        : "smooth";
      inspector.current?.scrollIntoView({ behavior, block: "start" });
      inspector.current?.focus({ preventScroll: true });
    });
    return () => cancelAnimationFrame(frame);
  };
  const refuseDrop = (message = "That record cannot be dropped there") => {
    showFeedback(message);
  };
  const refuseCompletedItemMove = (
    locationIds: (string | null)[],
  ): boolean => {
    const completed = locationIds
      .filter((id): id is string => Boolean(id))
      .map((id) => state.locations.find((location) => location.id === id))
      .find((location) =>
        location && COMPLETE_CAPTURE_STATUSES.has(location.captureStatus)
      );
    if (!completed) return false;
    refuseDrop(`Reopen ${completed.name} before changing its contents`);
    return true;
  };
  const addRoot = async (data: FormData) => {
    const roots = live.filter((location) => location.parentId === null);
    const created = createLocation({ code: String(data.get("code")), name: String(data.get("name")), kind: String(data.get("kind")) as LocationKind, parentId: null, order: nextOrder(roots) });
    return perform(commit, { type: "location.create", location: created }, () => chooseLocation(created.id));
  };
  const moveByDrop = (payload: DragPayload | null, target: DropTarget) => {
    if (!payload) {
      refuseDrop("That dragged record could not be read");
      return;
    }
    if (payload.type === "item") {
      if (target.kind !== "location" || !target.id) {
        refuseDrop("Items can only be dropped into a space");
        return;
      }
      const item = state.items.find((candidate) => candidate.id === payload.id);
      if (!item) {
        refuseDrop("That item is no longer available");
        return;
      }
      if (item.locationId === target.id) {
        refuseDrop(`${item.name} is already in that space`);
        return;
      }
      if (refuseCompletedItemMove([item.locationId, target.id])) return;
      void perform(commit, { type: "item.move", id: item.id, destinationId: target.id, quantity: item.quantity });
      return;
    }
    if (payload.type === "location") {
      const placement = locationPlacementForDrop(state, payload.id, target);
      if ("error" in placement) {
        refuseDrop(placement.error);
        return;
      }
      void hierarchy.reviewPlacement(placement.command);
    }
  };
  const dragOver = (event: React.DragEvent, fallback: DropTarget) => {
    const payload = readDrag(event) ?? dragPayload;
    const target = dropTargetAt(event.clientX, event.clientY) ?? fallback;
    event.preventDefault();
    if (
      payload?.type === "location" &&
      "error" in locationPlacementForDrop(state, payload.id, target)
    ) {
      event.dataTransfer.dropEffect = "none";
      setDropCue(null);
      return;
    }
    event.dataTransfer.dropEffect = "move";
    setDropCue(target);
  };
  const startNativeDrag = (
    event: React.DragEvent,
    payload: DragPayload,
  ) => {
    event.stopPropagation();
    setDragPayload(payload);
    setDragging(true);
    writeDrag(event, payload);
  };
  const endNativeDrag = () => {
    setDragPayload(null);
    setDragging(false);
    setDropCue(null);
  };
  const drop = (event: React.DragEvent, fallback: DropTarget) => {
    event.preventDefault();
    event.stopPropagation();
    const target = dropTargetAt(event.clientX, event.clientY) ?? fallback;
    moveByDrop(readDrag(event) ?? dragPayload, target);
    setDragPayload(null);
    setDragging(false);
    setDropCue(null);
  };
  const finishTouchDrop = (payload: DragPayload, target: DropTarget) => {
    moveByDrop(payload, target);
    setDragging(false);
    setDropCue(null);
  };
  const reorderLocation = (location: Location, direction: -1 | 1) => {
    const siblings = live.filter((candidate) => candidate.parentId === location.parentId);
    const order = movedOrder(siblings, location.id, direction);
    if (order !== null) void perform(commit, { type: "location.reorder", id: location.id, order });
  };
  const branch = (
    parentId: string | null,
    depth = 0,
  ): React.ReactNode => sortLocations(visibleChildren(parentId)).map(
    (location) => {
      const displayParentId = location.parentId &&
        liveIds.has(location.parentId)
        ? location.parentId
        : null;
      const siblings = sortLocations(visibleChildren(displayParentId));
      const index = siblings.findIndex(
        (candidate) => candidate.id === location.id,
      );
      const children = live.filter(
        (candidate) => candidate.parentId === location.id,
      );
      const itemCount = state.items.filter(
        (item) => item.locationId === location.id && !item.archivedAt,
      ).length;
      const cue = dropCue?.kind === "location" &&
        dropCue.id === location.id
        ? dropCue.intent
        : undefined;
      const isCollapsed = collapsed.has(location.id);
      const captureStatus = location.captureStatus.replace("_", " ");
      return <div className="tree-node" role="listitem" key={location.id}>
        <div
          className="tree-row"
          data-location-id={location.id}
          data-drop-target="location"
          data-drop-id={location.id}
          data-drop-intent={cue}
          data-active={current?.id === location.id}
          draggable
          onDragStart={(event) => startNativeDrag(event, {
            type: "location",
            id: location.id,
          })}
          onDragEnd={endNativeDrag}
          onDragOver={(event) => dragOver(event, {
            id: location.id,
            intent: "inside",
            kind: "location",
          })}
          onDrop={(event) => drop(event, {
            id: location.id,
            intent: "inside",
            kind: "location",
          })}
        >
          <TouchDragHandle
            label={`Drag ${location.name} to move or nest it`}
            onActiveChange={setDragging}
            targetAt={(clientX, clientY) => {
              const target = dropTargetAt(clientX, clientY);
              return target &&
                  !("error" in locationPlacementForDrop(
                    state,
                    location.id,
                    target,
                  ))
                ? target
                : null;
            }}
            onDrop={(target) => finishTouchDrop({
              type: "location",
              id: location.id,
            }, target)}
            onInvalidDrop={() => refuseDrop(
              `Choose a valid destination for ${location.name}`,
            )}
          />
          {children.length
            ? <button
                className="tree-toggle"
                aria-expanded={!isCollapsed}
                aria-label={`${isCollapsed ? "Expand" : "Collapse"} ${location.name}`}
                onClick={() => setCollapsed((current) => {
                  const next = new Set(current);
                  if (next.has(location.id)) next.delete(location.id);
                  else next.add(location.id);
                  return next;
                })}
              >
                {isCollapsed ? <ChevronRight /> : <ChevronDown />}
              </button>
            : <span className="tree-toggle-spacer" />}
          <button
            className="tree-select"
            aria-current={current?.id === location.id ? "true" : undefined}
            onClick={() => chooseLocation(location.id)}
          >
            <span className="tree-code">
              <b>{location.code}</b>
              <i>{location.kind}</i>
            </span>
            <span className="tree-name">
              {location.name}
              <small>{children.length} nested · {itemCount} items · {captureStatus}</small>
            </span>
          </button>
          <span className="drop-copy" aria-hidden>
            {cue === "before"
              ? "Place before"
              : cue === "after"
                ? "Place after"
                : "Move inside"}
          </span>
          {siblings.length > 1 && <div className="row-actions">
            <button
              className="icon small"
              aria-label={`Move ${location.name} up`}
              disabled={index === 0}
              onClick={() => reorderLocation(location, -1)}
            >
              <ArrowUp />
            </button>
            <button
              className="icon small"
              aria-label={`Move ${location.name} down`}
              disabled={index === siblings.length - 1}
              onClick={() => reorderLocation(location, 1)}
            >
              <ArrowDown />
            </button>
          </div>}
        </div>
        {current?.id === location.id && <div
          className="mobile-tree-actions"
          aria-label={`${location.name} actions`}
          role="group"
        >
          <button
            type="button"
            aria-label={`Edit details for ${location.name}`}
            onClick={() => showInspector(location)}
          >
            <Edit3 />
            Edit details
          </button>
          <button
            aria-expanded={spaceActionsLocationId === location.id}
            aria-haspopup="dialog"
            aria-label={`More actions for ${location.name}`}
            onClick={(event) => {
              spaceActionsTrigger.current = event.currentTarget;
              setSpaceActionsLocationId(location.id);
            }}
            type="button"
          >
            <Menu />
            More actions
          </button>
        </div>}
        {children.length > 0 && !isCollapsed &&
          <div className="tree-children" role="list">
            {branch(location.id, depth + 1)}
          </div>}
      </div>;
    },
  );
  const removeLocation = (location: Location): boolean => {
    const descendants = descendantIds(state, location.id);
    const locationIds = [location.id, ...descendants];
    const itemIds = state.items.filter((item) => locationIds.includes(item.locationId)).map((item) => item.id);
    if (!confirm(`Delete ${location.name}, ${countLabel(descendants.length, "nested space")}, and ${countLabel(itemIds.length, "item record")}? The deletion is recorded in Activity and can be undone until a later conflicting edit.`)) return false;
    void perform(commit, { type: "location.delete", id: location.id, descendantIds: descendants, itemIds }, () => select(live.find((candidate) => !locationIds.includes(candidate.id))?.id ?? ""));
    return true;
  };

  const spaceActionsLocation = compactLayout && spaceActionsLocationId
    ? live.find((location) => location.id === spaceActionsLocationId) ?? null
    : null;
  const spaceActionSiblings = spaceActionsLocation
    ? sortLocations(live.filter((location) =>
      location.parentId === spaceActionsLocation.parentId
    ))
    : [];
  const spaceActionIndex = spaceActionsLocation
    ? spaceActionSiblings.findIndex((location) =>
      location.id === spaceActionsLocation.id
    )
    : -1;
  const spaceActionCanArchive = Boolean(
    spaceActionsLocation &&
    !state.items.some((item) =>
      item.locationId === spaceActionsLocation.id && !item.archivedAt
    ) &&
    !descendantIds(state, spaceActionsLocation.id).some((id) =>
      !state.locations.find((location) => location.id === id)?.archivedAt
    ),
  );

  const treePanel = <section className="panel tree-panel" data-dragging={dragging}><div className="title"><div><p className="eyebrow">Your physical hierarchy</p><h2>Rooms → cabinets → boxes</h2></div></div><div className="tree-tools"><details className="tree-add"><summary><Plus /><span>Add top-level space</span></summary><form onSubmit={(event) => submitForm(event, addRoot)}><LocationCreateFields defaultKind="room" existingCodes={live.map((location) => location.code)} kindLabel="Space type" namePlaceholder="Friendly name" /><button>Add top-level space</button></form></details><details className="tree-help"><summary><Info /><span>Move spaces</span></summary><p>Drag a handle onto the top, middle, or bottom of another row to place before, move inside, or place after. On touch, press the handle, slide, and release.</p></details></div><div className="root-drop" data-drop-target="root" data-drop-intent={dropCue?.kind === "root" ? "inside" : undefined} onDragOver={(event) => dragOver(event, { id: null, intent: "inside", kind: "root" })} onDrop={(event) => drop(event, { id: null, intent: "inside", kind: "root" })}>Drop here to make a top-level room or area</div><p className="mobile-tree-hint">Tap a space for move and edit actions.</p><div className="location-tree" role="list" aria-label="Space hierarchy">{branch(null)}</div>{archived.length > 0 && <details className="archived"><summary>{archived.length} archived</summary>{archived.map((location) => <div key={location.id}><span>{location.code} · {location.name}</span><button onClick={() => void perform(commit, { type: "location.archive", id: location.id, archived: false })}>Restore</button></div>)}</details>}</section>;
  const inspectorPanel = <section
    aria-label={current ? `Edit ${current.name}` : "Space editor"}
    className="panel inspector"
    id="space-inspector"
    ref={inspector}
    tabIndex={-1}
  >
    {current
      ? <LocationEditor
        compactActions={compactLayout}
        commit={commit}
        editItem={setEditingItem}
        endNativeDrag={endNativeDrag}
        key={current.id}
        location={current}
        moveByDrop={finishTouchDrop}
        remove={() => removeLocation(current)}
        reorder={reorderLocation}
        requestHierarchyChange={requestHierarchyChange}
        select={select}
        setDragging={setDragging}
        startNativeDrag={startNativeDrag}
        state={state}
      />
      : <Empty
        title="Select a space"
        text="Edit it, move it, or drop an item or container onto it."
      />}
  </section>;
  const spaceActionSheet = spaceActionsLocation
    ? <ModalDialog
      mobileSheet="content"
      onClose={() => setSpaceActionsLocationId(null)}
      open={Boolean(spaceActionsLocation)}
      returnFocusRef={spaceActionsTrigger}
      title={`${spaceActionsLocation.name} actions`}
    >
      <div className="space-action-sheet">
        <p className="space-action-summary">
          <strong>{spaceActionsLocation.code} · {spaceActionsLocation.name}</strong>
          <small>{spaceActionsLocation.kind} · Choose one hierarchy action</small>
        </p>
        <div className="space-action-reorder">
          <button
            aria-label={`Earlier ${spaceActionsLocation.name}`}
            disabled={spaceActionIndex <= 0}
            onClick={() => {
              reorderLocation(spaceActionsLocation, -1);
              setSpaceActionsLocationId(null);
            }}
            type="button"
          >
            <ArrowUp />
            Earlier
          </button>
          <button
            aria-label={`Later ${spaceActionsLocation.name}`}
            disabled={
              spaceActionIndex < 0 ||
              spaceActionIndex === spaceActionSiblings.length - 1
            }
            onClick={() => {
              reorderLocation(spaceActionsLocation, 1);
              setSpaceActionsLocationId(null);
            }}
            type="button"
          >
            <ArrowDown />
            Later
          </button>
        </div>
        <button
          aria-label={`Move ${spaceActionsLocation.name}`}
          onClick={(event) => {
            const trigger = spaceActionsTrigger.current ?? event.currentTarget;
            setSpaceActionsLocationId(null);
            openMoveDialog(spaceActionsLocation, trigger);
          }}
          type="button"
        >
          <GripVertical />
          Move to another parent or position
        </button>
        <button
          aria-label={`Archive ${spaceActionsLocation.name}`}
          disabled={!spaceActionCanArchive}
          onClick={() => {
            setSpaceActionsLocationId(null);
            void perform(
              commit,
              {
                type: "location.archive",
                id: spaceActionsLocation.id,
                archived: true,
              },
              () => select(live.find((candidate) =>
                candidate.id !== spaceActionsLocation.id
              )?.id ?? ""),
            );
          }}
          title={spaceActionCanArchive
            ? undefined
            : "Move, archive, or delete live contents and nested spaces first."}
          type="button"
        >
          <Archive />
          Archive empty space
        </button>
        <button
          aria-label={`Delete ${spaceActionsLocation.name} and subtree`}
          className="danger"
          onClick={() => {
            if (removeLocation(spaceActionsLocation)) {
              setSpaceActionsLocationId(null);
            }
          }}
          type="button"
        >
          <Trash2 />
          Delete subtree
        </button>
      </div>
      <button
        className="space-action-close"
        onClick={() => setSpaceActionsLocationId(null)}
        type="button"
      >
        Close
      </button>
    </ModalDialog>
    : null;
  return <>
    <ResizablePanels
      activeCompactPanel={compactPanel}
      className="content split"
      defaultPanelPercent={42}
      label="Space panels"
      minSideBySideWidth={SPACES_MIN_SIDE_BY_SIDE_WIDTH}
      onCompactPanelChange={setCompactPanel}
      primary={treePanel}
      primaryLabel="space hierarchy"
      secondary={inspectorPanel}
      secondaryLabel="space details"
      storageId="spaces"
    />
    {spaceActionSheet}
    <HierarchyChangeDialogs controller={hierarchy} state={state} />
    {editingItem && state.items.find((item) => item.id === editingItem) && <ItemEditor item={state.items.find((item) => item.id === editingItem) as ItemRecord} state={state} commit={commit} close={() => setEditingItem(null)} />}
  </>;
}

function LocationEditor({ compactActions, state, location, commit, select, reorder, remove, editItem, moveByDrop, requestHierarchyChange, setDragging, startNativeDrag, endNativeDrag }: { compactActions: boolean; state: WorkspaceState; location: Location; commit: Commit; select: (id: string) => void; reorder: (location: Location, direction: -1 | 1) => void; remove: () => void; editItem: (id: string) => void; moveByDrop: (payload: DragPayload, target: DropTarget) => void; requestHierarchyChange: (command: LocationHierarchyCommand, trigger?: HTMLElement | null) => Promise<boolean>; setDragging: (dragging: boolean) => void; startNativeDrag: (event: React.DragEvent, payload: DragPayload) => void; endNativeDrag: () => void }) {
  const [childCreatorOpen, setChildCreatorOpen] = useState(false);
  const hierarchyChangeTrigger = useRef<HTMLElement | null>(null);
  const editorForm = useRef<HTMLFormElement | null>(null);
  const formBaseline = useRef(locationFormValues(location));
  useLayoutEffect(() => {
    const previous = formBaseline.current;
    const next = locationFormValues(location);
    formBaseline.current = next;
    reconcileUntouchedFormControls(editorForm.current, previous, next);
  }, [location]);
  const invalidParents = new Set([location.id, ...descendantIds(state, location.id)]);
  const contents = sortItems(state.items.filter((item) => item.locationId === location.id && !item.archivedAt));
  const liveDescendantCount = descendantIds(state, location.id).filter(
    (id) => !state.locations.find((candidate) => candidate.id === id)?.archivedAt,
  ).length;
  const canArchive = contents.length === 0 && liveDescendantCount === 0;
  const parentOptions = flattenLocationTree(state.locations.filter((candidate) => !candidate.archivedAt && !invalidParents.has(candidate.id)));
  const parentIsAvailable = location.parentId === null || parentOptions.some(({ location: candidate }) => candidate.id === location.parentId);
  const siblings = sortLocations(state.locations.filter(
    (candidate) =>
      !candidate.archivedAt &&
      candidate.parentId === location.parentId,
  ));
  const siblingIndex = siblings.findIndex(
    (candidate) => candidate.id === location.id,
  );
  const save = async (data: FormData) => {
    const dimensions = optionalDimensions(data);
    const parentId = String(data.get("parentId")) || null;
    const changes: Partial<Omit<Location, "id" | "createdAt">> = {
      name: String(data.get("name")), code: String(data.get("code")), kind: String(data.get("kind")) as LocationKind,
      description: String(data.get("description")), tags: splitList(data.get("tags")), dimensions, parentId,
      conditions: { dark: data.get("dark") === "on", dry: data.get("dry") === "on", foodSafe: data.get("foodSafe") === "on", humidity: String(data.get("humidity")) as Location["conditions"]["humidity"], temperature: String(data.get("temperature")) as Location["conditions"]["temperature"] },
    };
    if (parentId !== location.parentId) {
      changes.order = nextOrder(state.locations.filter((candidate) => !candidate.archivedAt && candidate.parentId === parentId && candidate.id !== location.id));
    }
    const command = {
      type: "location.update",
      id: location.id,
      changes,
    } satisfies LocationHierarchyCommand;
    return parentId === location.parentId
      ? perform(commit, command)
      : requestHierarchyChange(command, hierarchyChangeTrigger.current);
  };
  const addChild = async (data: FormData) => {
    const children = state.locations.filter((candidate) => candidate.parentId === location.id && !candidate.archivedAt);
    const child = createLocation({ code: String(data.get("code")), name: String(data.get("name")), kind: String(data.get("kind")) as LocationKind, parentId: location.id, order: nextOrder(children) });
    const created = await perform(commit, { type: "location.create", location: child });
    if (created) setChildCreatorOpen(false);
    return created;
  };
  const captureComplete = COMPLETE_CAPTURE_STATUSES.has(location.captureStatus);
  const reopenCapture = () => perform(commit, {
    type: "capture.status",
    id: location.id,
    status: contents.length || liveDescendantCount ? "in_progress" : "uncounted",
  });
  return <>
    <form
      ref={editorForm}
      onSubmit={(event) => {
        hierarchyChangeTrigger.current =
          event.currentTarget.querySelector<HTMLButtonElement>(
            "button.primary",
          );
        submitForm(event, save, false);
      }}
      className="editor-form"
    >
      <div className="title">
        <div><p className="eyebrow">{location.kind}</p><h2>Edit space</h2></div>
        <span className="tag">{location.captureStatus.replace("_", " ")}</span>
      </div>
      {!parentIsAvailable && <p className="form-warning" role="status">The previous parent is archived or missing. Choose a parent below; saving will place this space at the top level if you leave it unchanged.</p>}
      <div className="form-grid">
        <label className="space-name-field">Friendly name<input required name="name" defaultValue={location.name} /></label>
        <label className="space-code-field">Short ID<input required name="code" defaultValue={location.code} autoCapitalize="characters" /></label>
        <label className="space-kind-field">Type<select name="kind" defaultValue={location.kind}>{LOCATION_KINDS.map((kind) => <option key={kind}>{kind}</option>)}</select></label>
        <label className="space-parent-field">Parent space<select key={location.parentId ?? "root"} name="parentId" defaultValue={parentIsAvailable ? location.parentId ?? "" : ""}><option value="">Top level</option>{parentOptions.map(({ depth, location: candidate }) => <option key={candidate.id} value={candidate.id}>{`${"  ".repeat(depth)}${depth ? "↳ " : ""}${candidate.code} · ${candidate.name}`}</option>)}</select></label>
      </div>
      <details className="space-advanced">
        <summary>
          <span>
            <strong>More space details</strong>
            <small>Tags, description, suitability, and dimensions</small>
          </span>
        </summary>
        <div className="space-advanced-body">
          <div className="form-grid">
            <label className="space-tags-field">Tags, comma-separated<input name="tags" defaultValue={location.tags.join(", ")} /></label>
            <label className="space-description-field">Description<textarea name="description" defaultValue={location.description} /></label>
          </div>
          <fieldset data-guidance-section="space_suitability" tabIndex={-1}>
            <legend>Suitability</legend>
            <div className="check-grid">
              <label><input type="checkbox" name="foodSafe" defaultChecked={location.conditions.foodSafe} /> Food safe</label>
              <label><input type="checkbox" name="dry" defaultChecked={location.conditions.dry} /> Dry</label>
              <label><input type="checkbox" name="dark" defaultChecked={location.conditions.dark} /> Dark</label>
              <label>Temperature<select name="temperature" defaultValue={location.conditions.temperature}><option>cold</option><option>cool</option><option>normal</option><option>warm</option></select></label>
              <label>Humidity<select name="humidity" defaultValue={location.conditions.humidity}><option>dry</option><option>normal</option><option>humid</option></select></label>
            </div>
          </fieldset>
          <fieldset data-guidance-section="space_capacity" tabIndex={-1}>
            <legend>Interior dimensions (optional)</legend>
            <div className="dimension-grid">
              <label>W<input name="width" type="number" min="0.01" step="any" defaultValue={location.dimensions?.width} /></label>
              <label>H<input name="height" type="number" min="0.01" step="any" defaultValue={location.dimensions?.height} /></label>
              <label>D<input name="depth" type="number" min="0.01" step="any" defaultValue={location.dimensions?.depth} /></label>
              <label>Unit<select name="dimensionUnit" defaultValue={location.dimensions?.unit ?? "in"}><option>in</option><option>cm</option></select></label>
            </div>
          </fieldset>
        </div>
      </details>
      <button className="primary">Save space</button>
    </form>
    {!compactActions && <div className="inspector-actions">
      <button disabled={siblingIndex <= 0} onClick={() => reorder(location, -1)}><ArrowUp /> Earlier</button>
      <button disabled={siblingIndex < 0 || siblingIndex === siblings.length - 1} onClick={() => reorder(location, 1)}><ArrowDown /> Later</button>
      <button disabled={!canArchive} title={canArchive ? undefined : "Move, archive, or delete live contents and nested spaces first."} onClick={() => void perform(commit, { type: "location.archive", id: location.id, archived: true }, () => select(state.locations.find((candidate) => !candidate.archivedAt && candidate.id !== location.id)?.id ?? ""))}><Archive /> Archive</button>
      <button className="danger" onClick={remove}><Trash2 /> Delete subtree</button>
    </div>}
    {captureComplete && <div className="capture-locked capture-locked-action" role="status">
      <CheckCircle2 />
      <span><strong>Contents are read-only</strong><small>Reopen capture before adding, editing, moving, or reordering direct contents.</small></span>
      <button type="button" onClick={() => void reopenCapture()}><RotateCcw /> Reopen capture</button>
    </div>}
    {!captureComplete && <div
      className="space-child-creator"
      data-open={childCreatorOpen ? "true" : undefined}
      key={location.id}
    >
      <button
        aria-expanded={childCreatorOpen}
        className="creator-trigger"
        onClick={() => setChildCreatorOpen((open) => !open)}
        type="button"
      >
        <Plus aria-hidden="true" />
        <span>Add inside {location.name}</span>
        <ChevronDown aria-hidden="true" />
      </button>
      <form className="nested inline-add" onSubmit={(event) => submitForm(event, addChild)}>
        <LocationCreateFields defaultKind="box" existingCodes={state.locations.filter((candidate) => !candidate.archivedAt).map((candidate) => candidate.code)} kindLabel="Space type" namePlaceholder="Friendly name" />
        <button>Add nested space</button>
      </form>
    </div>}
    <div className="location-contents">
      <h3>Direct contents <small>{contents.length} records</small></h3>
      {contents.map((item) => <div
        className="location-item-row"
        key={item.id}
        draggable={!captureComplete}
        onDragStart={captureComplete ? undefined : (event) => startNativeDrag(event, { type: "item", id: item.id })}
        onDragEnd={captureComplete ? undefined : endNativeDrag}
      >
        {captureComplete ? <span className="capture-readonly-marker" aria-hidden><CheckCircle2 /></span> : <TouchDragHandle label={`Drag ${item.name} into another space`} onActiveChange={setDragging} onDrop={(target) => moveByDrop({ type: "item", id: item.id }, target)} onInvalidDrop={() => showFeedback(`Choose a different space for ${item.name}`)} />}
        {captureComplete ? <span className="item-name"><strong>{item.name}</strong><small>{item.quantity} {item.unit}</small></span> : <button className="item-name" onClick={() => editItem(item.id)}><strong>{item.name}</strong><small>{item.quantity} {item.unit}</small></button>}
        {!captureComplete && <button className="icon small" aria-label={`Edit ${item.name}`} onClick={() => editItem(item.id)}><Edit3 /></button>}
      </div>)}
      {contents.length === 0 && <p className="muted">{captureComplete ? "No direct item records. Reopen capture before adding contents." : "No direct item records. Drop an inventory item onto this space to move it here."}</p>}
    </div>
  </>;
}
