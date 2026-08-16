"use client";

import dynamic from "next/dynamic";
import {
  useMemo,
  useRef,
  useState,
} from "react";
import type * as React from "react";
import {
  ArrowDown,
  ArrowUp,
  CheckCircle2,
  ChevronRight,
  Edit3,
  Map as MapIcon,
  RotateCcw,
  Search,
  SlidersHorizontal,
} from "lucide-react";
import { expectationsForCommand } from "../domain/expectations";
import type {
  ItemRecord,
  Location,
  WorkspaceState,
} from "../domain/types";
import { ItemEditor } from "./item-editor";
import { ModalDialog } from "./modal-dialog";
import {
  expectationFingerprint,
  flattenLocationTree,
  locationPath,
  readDrag,
  reorderDropTarget,
  reorderTargetAt,
  TouchDragHandle,
  writeDrag,
} from "./workspace-hierarchy";
import {
  COMPLETE_CAPTURE_STATUSES,
  countLabel,
  dismissFeedback,
  Empty,
  followAppLink,
  movedOrder,
  orderAfter,
  orderBefore,
  perform,
  showFeedback,
  sortItems,
  stateWorkspacePath,
} from "./workspace-view-helpers";
import type {
  Commit,
  DragPayload,
  DropTarget,
  GuidanceFocus,
  ItemBulkMoveCommand,
  PendingItemBulkMove,
} from "./workspace-view-types";

const CsvImportDialog = dynamic(
  () => import("./csv-import-dialog").then((module) => module.CsvImportDialog),
);

export function Inventory({ state, commit, editing, editFocus, locationFilter, onEditingChange, onLocationFilterChange, onOpenLocation }: { state: WorkspaceState; commit: Commit; editing: string | null; editFocus?: GuidanceFocus; locationFilter: string; onEditingChange: (id: string | null) => void; onLocationFilterChange: (id: string) => void; onOpenLocation: (id: string) => void }) {
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [sortBy, setSortBy] = useState<"location" | "name" | "quantity">("name");
  const [selected, setSelected] = useState<string[]>([]);
  const [moveDestinationId, setMoveDestinationId] = useState("");
  const [pendingBulkMove, setPendingBulkMove] =
    useState<PendingItemBulkMove | null>(null);
  const [bulkMoveBusy, setBulkMoveBusy] = useState(false);
  const bulkMoveBusyRef = useRef(false);
  const [nativeReorderCue, setNativeReorderCue] = useState<DropTarget | null>(null);
  const [nativeReorderSource, setNativeReorderSource] = useState<DragPayload | null>(null);
  const locationName = useMemo(() => new Map(state.locations.map((location) => [location.id, locationPath(state.locations, location.id).map((part) => part.name).join(" › ")])), [state.locations]);
  const locationOptions = flattenLocationTree(state.locations.filter((location) => !location.archivedAt));
  const shown = useMemo(() => state.items.filter((item) => {
    const constraintTerms = [
      item.constraints.keepTogether,
      item.constraints.foodOnly ? "food safe food-safe" : "",
      item.constraints.avoidWarmth ? "avoid warmth cool" : "",
      item.constraints.avoidHumidity ? "avoid humidity dry" : "",
    ];
    const searchable = [item.name, item.category, item.description, ...item.tags, ...item.constraints.requiredTags, ...constraintTerms].join(" ").toLocaleLowerCase();
    return !item.archivedAt && (!locationFilter || item.locationId === locationFilter) && searchable.includes(query.trim().toLocaleLowerCase());
  }).sort((left, right) => {
    if (locationFilter && !query.trim()) return left.order - right.order || left.name.localeCompare(right.name);
    if (sortBy === "quantity") return right.quantity - left.quantity || left.name.localeCompare(right.name);
    if (sortBy === "location") return (locationName.get(left.locationId) ?? "").localeCompare(locationName.get(right.locationId) ?? "") || left.name.localeCompare(right.name);
    return left.name.localeCompare(right.name);
  }), [state, query, locationFilter, locationName, sortBy]);
  const filteredLocation = state.locations.find(
    (location) => location.id === locationFilter,
  );
  const filteredCaptureComplete = Boolean(
    filteredLocation &&
    COMPLETE_CAPTURE_STATUSES.has(filteredLocation.captureStatus),
  );
  const canReorder = Boolean(locationFilter) &&
    !query.trim() &&
    !filteredCaptureComplete;
  const shownIds = new Set(shown.map((item) => item.id));
  const activeSelection = selected.filter((id) => shownIds.has(id));
  const selectedItems = state.items.filter((item) => activeSelection.includes(item.id));
  const reopenFilteredCapture = () => {
    if (!filteredLocation) return;
    const hasContents = state.items.some(
      (item) => item.locationId === filteredLocation.id && !item.archivedAt,
    ) || state.locations.some(
      (location) =>
        location.parentId === filteredLocation.id && !location.archivedAt,
    );
    void perform(commit, {
      type: "capture.status",
      id: filteredLocation.id,
      status: hasContents ? "in_progress" : "uncounted",
    });
  };
  const movableBulkMoveItems = (
    command: ItemBulkMoveCommand,
  ): ItemRecord[] => command.itemIds.flatMap((id) => {
    const item = state.items.find((candidate) => candidate.id === id);
    return item && item.locationId !== command.destinationId
      ? [item]
      : [];
  });
  const completedBulkMoveLocations = (
    command: ItemBulkMoveCommand,
  ): Location[] => {
    const sourceIds = movableBulkMoveItems(command).map(
      (item) => item.locationId,
    );
    const locationIds = new Set([...sourceIds, command.destinationId]);
    return state.locations.filter((location) =>
      locationIds.has(location.id) &&
      !location.archivedAt &&
      COMPLETE_CAPTURE_STATUSES.has(location.captureStatus)
    );
  };
  const applyBulkMove = async (
    command: ItemBulkMoveCommand,
    reopenCompletedParents = false,
  ): Promise<boolean> => {
    if (bulkMoveBusyRef.current) {
      showFeedback("The item move is still in progress", "info");
      return false;
    }
    if (reopenCompletedParents && pendingBulkMove) {
      const currentExpectations = expectationsForCommand(state, command);
      if (
        expectationFingerprint(currentExpectations) !==
        expectationFingerprint(pendingBulkMove.expectations)
      ) {
        setPendingBulkMove(null);
        setMoveDestinationId("");
        showFeedback(
          "The selected items or affected spaces changed while the move was open. Review them before moving.",
          "info",
        );
        return false;
      }
    }
    bulkMoveBusyRef.current = true;
    setBulkMoveBusy(true);
    const prepared: ItemBulkMoveCommand = {
      ...command,
      reopenCompletedParents,
    };
    const applied = await perform(commit, prepared);
    bulkMoveBusyRef.current = false;
    setBulkMoveBusy(false);
    if (applied) {
      const movedCount = movableBulkMoveItems(command).length;
      setPendingBulkMove(null);
      setMoveDestinationId("");
      setSelected([]);
      showFeedback(
        `${countLabel(movedCount, "item record")} moved`,
        "success",
      );
    } else if (!reopenCompletedParents) {
      setMoveDestinationId("");
    }
    return applied;
  };
  const moveSelected = (destinationId: string) => {
    setMoveDestinationId(destinationId);
    const command: ItemBulkMoveCommand = {
      type: "item.bulkMove",
      itemIds: activeSelection,
      destinationId,
    };
    const completed = completedBulkMoveLocations(command);
    if (completed.length > 0) {
      dismissFeedback();
      const confirmedCommand = {
        ...command,
        reopenCompletedParents: true,
      };
      setPendingBulkMove({
        command: confirmedCommand,
        completedLocationIds: completed.map((location) => location.id),
        expectations: expectationsForCommand(state, confirmedCommand),
      });
      return;
    }
    void applyBulkMove(command);
  };
  const closeBulkMoveReview = () => {
    if (bulkMoveBusyRef.current) return;
    setPendingBulkMove(null);
    setMoveDestinationId("");
  };
  const pendingBulkMoveDestination = pendingBulkMove
    ? state.locations.find(
        (location) => location.id === pendingBulkMove.command.destinationId,
      )
    : null;
  const pendingBulkMoveLocations = pendingBulkMove
    ? pendingBulkMove.completedLocationIds.flatMap((id) => {
        const location = state.locations.find((candidate) => candidate.id === id);
        return location ? [location] : [];
      })
    : [];
  const pendingBulkMoveItemCount = pendingBulkMove
    ? movableBulkMoveItems(pendingBulkMove.command).length
    : 0;
  const reportCsvImport = (count: number) => {
    setQuery("");
    setSelected([]);
    showFeedback(
      `${countLabel(count, "item record")} imported. Undo the whole import from Activity.`,
      "success",
    );
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
  const canDropItem = (sourceId: string, targetId: string) => {
    if (!canReorder || sourceId === targetId) return false;
    const source = state.items.find((item) => item.id === sourceId);
    const target = state.items.find((item) => item.id === targetId);
    return Boolean(source && target && source.locationId === target.locationId);
  };
  const leaveNativeReorderTarget = (
    event: React.DragEvent<HTMLElement>,
    targetId: string,
  ) => {
    const remainsInside = event.relatedTarget instanceof Node &&
      event.currentTarget.contains(event.relatedTarget);
    if (
      !remainsInside &&
      nativeReorderCue?.kind === "item" &&
      nativeReorderCue.id === targetId
    ) {
      setNativeReorderCue(null);
    }
  };
  const moveItemByDrop = (payload: DragPayload | null, target: DropTarget) => {
    if (payload?.type !== "item" || target.kind !== "item" || !target.id) {
      showFeedback("Choose another item in this filtered container");
      return;
    }
    const source = state.items.find((item) => item.id === payload.id);
    const targetItem = state.items.find((item) => item.id === target.id);
    if (!source || !targetItem) {
      showFeedback("That item is no longer available");
      return;
    }
    if (source.id === targetItem.id) {
      showFeedback(`Choose a different destination for ${source.name}`);
      return;
    }
    if (source.locationId !== targetItem.locationId) {
      void perform(commit, { type: "item.move", id: source.id, destinationId: targetItem.locationId, quantity: source.quantity });
      return;
    }
    const siblings = state.items.filter((item) => !item.archivedAt && item.locationId === targetItem.locationId);
    const order = target.intent === "after"
      ? orderAfter(siblings, source.id, targetItem.id)
      : orderBefore(siblings, source.id, targetItem.id);
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
  const dropOnItem = (event: React.DragEvent<HTMLElement>, target: ItemRecord) => {
    const payload = readDrag(event) ?? nativeReorderSource;
    if (payload?.type !== "item" || !canDropItem(payload.id, target.id)) {
      event.preventDefault();
      showFeedback("Choose another item in this filtered container");
      clearNativeReorder();
      return;
    }
    event.preventDefault();
    moveItemByDrop(
      payload,
      reorderDropTarget(event.currentTarget, event.clientY, "item", target.id),
    );
    clearNativeReorder();
  };
  const reorderItem = (item: ItemRecord, direction: -1 | 1) => {
    const siblings = state.items.filter((candidate) => !candidate.archivedAt && candidate.locationId === item.locationId);
    const order = movedOrder(siblings, item.id, direction);
    if (order !== null) void perform(commit, { type: "item.reorder", id: item.id, order });
  };
  const inventoryRow = (item: ItemRecord) => {
    const itemLocation = state.locations.find(
      (location) => location.id === item.locationId,
    );
    const itemLocationPath =
      locationName.get(item.locationId) ?? "Unknown space";
    const itemLocationShortLabel = itemLocation
      ? `${itemLocation.code} · ${itemLocation.name}`
      : itemLocationPath;
    const siblings = sortItems(state.items.filter((candidate) => !candidate.archivedAt && candidate.locationId === item.locationId));
    const siblingIndex = siblings.findIndex((candidate) => candidate.id === item.id);
    const actionIdentity = `${item.name}, ${item.quantity} ${item.unit}`;
    const itemCaptureComplete = Boolean(
      itemLocation &&
      COMPLETE_CAPTURE_STATUSES.has(itemLocation.captureStatus),
    );
    const rowActionLabel = itemCaptureComplete
      ? "Review, reopen to edit"
      : "Edit / move";
    const rowActionContext = `for ${actionIdentity} in ${itemLocationPath}`;
    const validDrop = nativeReorderSource?.type === "item"
      ? canDropItem(nativeReorderSource.id, item.id)
      : null;
    const cue = nativeReorderCue?.kind === "item" &&
      nativeReorderCue.id === item.id
      ? nativeReorderCue.intent
      : undefined;
    return <div
      className="inventory-row"
      data-dragging={nativeReorderSource?.type === "item" && nativeReorderSource.id === item.id ? "true" : undefined}
      data-drop-id={canReorder ? item.id : undefined}
      data-drop-intent={cue}
      data-drop-target={canReorder ? "item" : undefined}
      data-drop-valid={validDrop === null ? undefined : String(validDrop)}
      data-item-id={item.id}
      data-reorderable={String(canReorder)}
      key={item.id}
      draggable={canReorder}
      onDragEnd={canReorder ? endNativeReorder : undefined}
      onDragLeave={canReorder ? (event) => leaveNativeReorderTarget(event, item.id) : undefined}
      onDragOver={canReorder ? (event) => dragOverItem(event, item.id) : undefined}
      onDragStart={canReorder ? (event) => startNativeReorder(event, { type: "item", id: item.id }) : undefined}
      onDrop={canReorder ? (event) => dropOnItem(event, item) : undefined}
    >
      {canReorder && <TouchDragHandle label={`Drag ${item.name} to reorder`} targetAt={(clientX, clientY) => {
        const target = reorderTargetAt(clientX, clientY, "item");
        return target?.id && canDropItem(item.id, target.id) ? target : null;
      }} onDrop={(target) => moveItemByDrop({ type: "item", id: item.id }, target)} onInvalidDrop={() => showFeedback(`Choose a different destination for ${item.name}`)} />}
      <label className="inventory-select"><input aria-label={`Select ${actionIdentity} in ${itemLocationPath}`} name="selectedItem" type="checkbox" value={item.id} checked={activeSelection.includes(item.id)} onChange={() => setSelected((current) => { const valid = current.filter((id) => shownIds.has(id)); return valid.includes(item.id) ? valid.filter((id) => id !== item.id) : [...valid, item.id]; })} /></label>
      <button className="item-name" onClick={() => onEditingChange(item.id)}>
        <strong>{item.name}</strong>
        <small className="inventory-mobile-location"><MapIcon aria-hidden="true" /><span>{itemLocationShortLabel}</span></small>
        {item.description && <small className="item-description-preview">{item.description}</small>}
        <small>{item.category} · {item.frequency} · {item.tags.join(", ") || "no tags"}</small>
        <span className="sr-only">, {item.quantity} {item.unit}, Open item details in {itemLocationPath}</span>
      </button>
      <b>{item.quantity} {item.unit}</b>
      {itemLocation
        ? <a
          aria-label={`Open ${itemLocationPath} in Spaces`}
          className="location-path"
          href={stateWorkspacePath(state, {
            locationId: item.locationId,
            view: "spaces",
          })}
          onClick={(event) =>
            followAppLink(event, () => onOpenLocation(item.locationId))}
        >
          <MapIcon />
          <span>{itemLocationPath}</span>
          <ChevronRight />
        </a>
        : <span className="location-path">{itemLocationPath}</span>}
      {canReorder && <span className="inventory-order-actions"><button type="button" className="icon small" aria-label={`Move ${actionIdentity} up`} disabled={siblingIndex === 0} onClick={() => reorderItem(item, -1)}><ArrowUp /></button><button type="button" className="icon small" aria-label={`Move ${actionIdentity} down`} disabled={siblingIndex === siblings.length - 1} onClick={() => reorderItem(item, 1)}><ArrowDown /></button></span>}
      <span className="reorder-drop-copy" aria-hidden>{cue === "before" ? "Place before" : cue === "after" ? "Place after" : ""}</span>
      <button className="row-action" onClick={() => onEditingChange(item.id)}><Edit3 /><span>{rowActionLabel}</span><span className="sr-only">{rowActionContext}</span></button>
    </div>;
  };
  return <div className="content inventory-page">
    <div className="inventory-heading">
      <div>
        <p className="eyebrow">Everything, regardless of container</p>
        <h2>All item records</h2>
        <p>Search the whole workspace, then select records for an explicit move. Filter to one container only when physical order matters.</p>
      </div>
      <b>{shown.length} records</b>
    </div>
    <div className="toolbar inventory-tools">
      <label className="search"><Search /><input aria-label="Search inventory" autoComplete="off" name="inventoryQuery" value={query} onChange={(event) => { setQuery(event.target.value); setSelected([]); setMoveDestinationId(""); }} placeholder="Search inventory" /></label>
      <div
        className="inventory-filters"
        data-filtered={filteredLocation ? "true" : undefined}
        data-open={filtersOpen ? "true" : undefined}
      >
        <button
          aria-expanded={filtersOpen}
          aria-label="Filter and sort inventory"
          className="inventory-filter-trigger"
          onClick={() => setFiltersOpen((open) => !open)}
          title="Filter and sort inventory"
          type="button"
        >
          <span>Filter and sort</span>
          <small>{filteredLocation
            ? `${filteredLocation.code} · ${filteredLocation.name}`
            : "Every container"}</small>
          <SlidersHorizontal aria-hidden="true" />
        </button>
        <div className="inventory-filter-controls">
          <select aria-label="Filter by location" name="inventoryLocation" value={locationFilter} onChange={(event) => { onLocationFilterChange(event.target.value); setSelected([]); setMoveDestinationId(""); }}>
            <option value="">Every container</option>
            {locationOptions.map(({ depth, location }) => <option key={location.id} value={location.id}>{`${"  ".repeat(depth)}${depth ? "↳ " : ""}${location.code} · ${location.name}`}</option>)}
          </select>
          <select aria-label="Sort inventory" name="inventorySort" value={sortBy} onChange={(event) => setSortBy(event.target.value as typeof sortBy)} disabled={canReorder}>
            <option value="name">Sort: name</option>
            <option value="location">Sort: location</option>
            <option value="quantity">Sort: quantity</option>
          </select>
          <button className="inventory-filter-done" onClick={() => setFiltersOpen(false)} type="button">Done</button>
        </div>
      </div>
      <CsvImportDialog
        commit={commit}
        onImported={reportCsvImport}
        preferredLocationId={locationFilter || undefined}
        state={state}
      />
    </div>
    {filteredCaptureComplete && filteredLocation && <div className="capture-locked capture-locked-action" role="status">
      <CheckCircle2 />
      <span><strong>{filteredLocation.name} is read-only</strong><small>Reopen capture before editing, moving, or reordering its item records.</small></span>
      <button type="button" onClick={reopenFilteredCapture}><RotateCcw /> Reopen capture</button>
    </div>}
    <p className="drag-hint">{filteredCaptureComplete ? "This completed container is available for review. Reopen capture to change its records." : canReorder ? `Showing one container. Drag handles or arrow buttons reorder ${shown.length} records here; use Edit / move to change containers.` : locationFilter && query.trim() ? "Search results are sorted for review. Clear the search before changing physical order." : "Showing all inventory. Select one or more records to move them, or use Edit / move for details and partial quantities."}</p>
    <section className="panel inventory">{shown.map(inventoryRow)}{shown.length === 0 && <Empty title="No matching records" text="Clear a filter or capture something new." />}</section>
    {activeSelection.length > 0 && <div className="floating">
      <b>{activeSelection.length} selected</b>
      <select aria-label="Move selected items" name="bulkMoveDestination" value={moveDestinationId} onChange={(event) => { if (event.target.value) moveSelected(event.target.value); else setMoveDestinationId(""); }}>
        <option value="">Move to…</option>
        {locationOptions.map(({ depth, location }) => <option disabled={selectedItems.length > 0 && selectedItems.every((item) => item.locationId === location.id)} value={location.id} key={location.id}>{`${"  ".repeat(depth)}${depth ? "↳ " : ""}${location.code} · ${location.name}`}</option>)}
      </select>
      <button onClick={() => { setSelected([]); setMoveDestinationId(""); }}>Clear</button>
    </div>}
    <ModalDialog
      busy={bulkMoveBusy}
      description={pendingBulkMove && pendingBulkMoveDestination
        ? `Moving ${countLabel(pendingBulkMoveItemCount, "selected record")} to ${pendingBulkMoveDestination.code} · ${pendingBulkMoveDestination.name} changes what was recorded inside these completed spaces. The move and reopen will be one undoable Activity entry.`
        : undefined}
      onClose={closeBulkMoveReview}
      open={Boolean(pendingBulkMove && pendingBulkMoveDestination)}
      title="Reopen completed spaces and move items?"
    >
      <ul className="hierarchy-review-list">
        {pendingBulkMoveLocations.map((location) => <li key={location.id}>
          <strong>{location.code} · {location.name}</strong>
          <span>Reopen as in progress</span>
        </li>)}
      </ul>
      <div className="hierarchy-dialog-actions">
        <button
          type="button"
          data-dialog-initial-focus
          disabled={bulkMoveBusy}
          onClick={closeBulkMoveReview}
        >
          Cancel
        </button>
        <button
          type="button"
          className="primary"
          disabled={bulkMoveBusy}
          onClick={() => {
            if (pendingBulkMove) {
              void applyBulkMove(pendingBulkMove.command, true);
            }
          }}
        >
          {bulkMoveBusy
            ? "Moving..."
            : `Move ${pendingBulkMoveItemCount} and reopen`}
        </button>
      </div>
    </ModalDialog>
    {editing && state.items.find((item) => item.id === editing) && <ItemEditor item={state.items.find((item) => item.id === editing) as ItemRecord} state={state} commit={commit} close={() => onEditingChange(null)} focus={editFocus} />}
  </div>;
}
