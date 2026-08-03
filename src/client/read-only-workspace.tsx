"use client";

import { useMemo, useState } from "react";
import type {
  ItemRecord,
  Location,
  ThemePreference,
  WorkspaceState,
} from "../domain/types";
import { workspacePath, type WorkspaceView } from "../domain/app-url";
import { ActivityHistory } from "./activity-history";
import { USER_GUIDE_URL } from "./external-links";
import { ModalDialog } from "./modal-dialog";
import styles from "./read-only-workspace.module.css";

const EXPORT_FAILURE_MESSAGE =
  "Could not export this workspace backup. Check browser download permissions and try again.";

interface ReadOnlyWorkspaceProps {
  inventoryItemId: string | null;
  inventoryLocationId: string | null;
  onInventoryItemChange: (id: string | null) => void;
  onInventoryLocationChange: (id: string) => void;
  onLocationChange: (id: string) => void;
  onOpenWorkspaceMenu: () => void;
  readOnlyReason: string;
  selectedLocationId: string | null;
  setTheme: (theme: ThemePreference) => void;
  state: WorkspaceState;
  theme: ThemePreference;
  view: WorkspaceView;
  viewer: boolean;
}

function normalizedQuery(value: string): string {
  return value.trim().toLocaleLowerCase();
}

function locationPathLabel(
  location: Location,
  locations: readonly Location[],
): string {
  const byId = new Map(locations.map((candidate) => [
    candidate.id,
    candidate,
  ]));
  const parts = [location.name];
  const visited = new Set([location.id]);
  let parentId = location.parentId;
  while (parentId && !visited.has(parentId)) {
    visited.add(parentId);
    const parent = byId.get(parentId);
    if (!parent) break;
    parts.unshift(parent.name);
    parentId = parent.parentId;
  }
  return parts.join(" / ");
}

function matchingLocation(
  location: Location,
  query: string,
): boolean {
  return !query || [
    location.code,
    location.description,
    location.kind,
    location.name,
    location.tags.join(" "),
  ].some((value) => value.toLocaleLowerCase().includes(query));
}

function matchingItem(item: ItemRecord, query: string): boolean {
  return !query || [
    item.category,
    item.name,
    item.description,
    item.tags.join(" "),
    item.unit,
  ].some((value) => value.toLocaleLowerCase().includes(query));
}

function SearchField({
  label,
  onChange,
  value,
}: {
  label: string;
  onChange: (value: string) => void;
  value: string;
}) {
  return <label className={styles.search}>
    <span>{label}</span>
    <input
      onChange={(event) => onChange(event.currentTarget.value)}
      type="search"
      value={value}
    />
  </label>;
}

function LocationList({
  locations,
  onSelect,
  selectedId,
}: {
  locations: readonly Location[];
  onSelect: (id: string) => void;
  selectedId: string | null;
}) {
  return <div className={styles.list}>
    {locations.map((location) => <button
      aria-pressed={selectedId === location.id}
      className={styles.listButton}
      key={location.id}
      onClick={() => onSelect(location.id)}
      type="button"
    >
      <span>
        <strong>{location.name}</strong>
        <small>{locationPathLabel(location, locations)}</small>
      </span>
      <span className={styles.code}>{location.code}</span>
      <span className={styles.status}>{location.captureStatus.replaceAll("_", " ")}</span>
    </button>)}
  </div>;
}

function ReadOnlyCapture({
  onLocationChange,
  selectedLocationId,
  state,
}: Pick<
  ReadOnlyWorkspaceProps,
  "onLocationChange" | "selectedLocationId" | "state"
>) {
  const [search, setSearch] = useState("");
  const query = normalizedQuery(search);
  const locations = state.locations.filter((location) =>
    !location.archivedAt &&
    (
      matchingLocation(location, query) ||
      state.items.some((item) =>
        !item.archivedAt &&
        item.locationId === location.id &&
        matchingItem(item, query)
      )
    )
  );
  const selected = state.locations.find((location) =>
    location.id === selectedLocationId && !location.archivedAt
  ) ?? locations[0] ?? null;
  const items = selected
    ? state.items.filter((item) =>
        !item.archivedAt &&
        item.locationId === selected.id &&
        matchingItem(item, query)
      )
    : [];
  return <div className={`${styles.layout} content`}>
    <section className="panel">
      <h2>Browse capture hierarchy</h2>
      <SearchField
        label="Search spaces and items"
        onChange={setSearch}
        value={search}
      />
      <LocationList
        locations={locations}
        onSelect={onLocationChange}
        selectedId={selected?.id ?? null}
      />
    </section>
    <section className="panel">
      {selected
        ? <>
            <p className="eyebrow">{selected.code} · {selected.kind}</p>
            <h2>{selected.name}</h2>
            <p className="muted">{selected.description || "No description"}</p>
            <dl className={styles.facts}>
              <div><dt>Capture status</dt><dd>{selected.captureStatus.replaceAll("_", " ")}</dd></div>
              <div><dt>Items</dt><dd>{items.length}</dd></div>
              <div><dt>Path</dt><dd>{locationPathLabel(selected, state.locations)}</dd></div>
            </dl>
            <h3>Recorded items</h3>
            <div className={styles.itemList}>
              {items.map((item) => <article key={item.id}>
                <span><strong>{item.name}</strong><small>{item.category}</small></span>
                <b>{item.quantity} {item.unit}</b>
              </article>)}
              {items.length === 0 && <p className={styles.empty}>No matching items in this space</p>}
            </div>
          </>
        : <p className={styles.empty}>No matching spaces</p>}
    </section>
  </div>;
}

function ReadOnlySpaces({
  onLocationChange,
  selectedLocationId,
  state,
}: Pick<
  ReadOnlyWorkspaceProps,
  "onLocationChange" | "selectedLocationId" | "state"
>) {
  const [search, setSearch] = useState("");
  const query = normalizedQuery(search);
  const locations = state.locations.filter((location) =>
    !location.archivedAt && matchingLocation(location, query)
  );
  const selected = state.locations.find((location) =>
    location.id === selectedLocationId && !location.archivedAt
  ) ?? locations[0] ?? null;
  return <div className={`${styles.layout} content`}>
    <section className="panel">
      <h2>Spaces</h2>
      <SearchField label="Search spaces" onChange={setSearch} value={search} />
      <LocationList
        locations={locations}
        onSelect={onLocationChange}
        selectedId={selected?.id ?? null}
      />
    </section>
    <section className="panel">
      {selected
        ? <>
            <p className="eyebrow">{selected.code} · {selected.kind}</p>
            <h2>{selected.name}</h2>
            <p className="muted">{selected.description || "No description"}</p>
            <dl className={styles.facts}>
              <div><dt>Path</dt><dd>{locationPathLabel(selected, state.locations)}</dd></div>
              <div><dt>Tags</dt><dd>{selected.tags.join(", ") || "None"}</dd></div>
              <div><dt>Temperature</dt><dd>{selected.conditions.temperature}</dd></div>
              <div><dt>Humidity</dt><dd>{selected.conditions.humidity}</dd></div>
              <div><dt>Dry</dt><dd>{selected.conditions.dry ? "Yes" : "No"}</dd></div>
              <div><dt>Food safe</dt><dd>{selected.conditions.foodSafe ? "Yes" : "No"}</dd></div>
            </dl>
          </>
        : <p className={styles.empty}>No matching spaces</p>}
    </section>
  </div>;
}

function ItemDetails({
  item,
  location,
  onClose,
}: {
  item: ItemRecord | null;
  location: Location | null;
  onClose: () => void;
}) {
  return <ModalDialog
    description="Read-only item information"
    onClose={onClose}
    open={Boolean(item)}
    title="Item details"
  >
    {item && <>
      <dl className={styles.facts}>
        <div><dt>Name</dt><dd>{item.name}</dd></div>
        <div><dt>Quantity</dt><dd>{item.quantity} {item.unit}</dd></div>
        <div><dt>Location</dt><dd>{location?.name ?? "Unknown"}</dd></div>
        <div><dt>Category</dt><dd>{item.category}</dd></div>
        <div><dt>Use frequency</dt><dd>{item.frequency}</dd></div>
        <div><dt>Tags</dt><dd>{item.tags.join(", ") || "None"}</dd></div>
        <div className={styles.wideFact}><dt>Description</dt><dd>{item.description || "None"}</dd></div>
      </dl>
      <div className={styles.dialogActions}>
        <button data-dialog-initial-focus onClick={onClose} type="button">Close</button>
      </div>
    </>}
  </ModalDialog>;
}

function ReadOnlyInventory({
  inventoryItemId,
  inventoryLocationId,
  onInventoryItemChange,
  onInventoryLocationChange,
  state,
}: Pick<
  ReadOnlyWorkspaceProps,
  | "inventoryItemId"
  | "inventoryLocationId"
  | "onInventoryItemChange"
  | "onInventoryLocationChange"
  | "state"
>) {
  const [search, setSearch] = useState("");
  const query = normalizedQuery(search);
  const items = state.items.filter((item) =>
    !item.archivedAt &&
    (!inventoryLocationId || item.locationId === inventoryLocationId) &&
    matchingItem(item, query)
  );
  const selectedItem = state.items.find((item) =>
    item.id === inventoryItemId && !item.archivedAt
  ) ?? null;
  const locationById = useMemo(
    () => new Map(state.locations.map((location) => [location.id, location])),
    [state.locations],
  );
  return <div className="content">
    <section className={`panel ${styles.fullPanel}`}>
      <div className={styles.inventoryTools}>
        <SearchField label="Search inventory" onChange={setSearch} value={search} />
        <label>
          <span>Location</span>
          <select
            onChange={(event) =>
              onInventoryLocationChange(event.currentTarget.value)
            }
            value={inventoryLocationId ?? ""}
          >
            <option value="">All locations</option>
            {state.locations.filter((location) => !location.archivedAt)
              .map((location) => <option key={location.id} value={location.id}>
                {locationPathLabel(location, state.locations)}
              </option>)}
          </select>
        </label>
      </div>
      <div className={styles.inventoryList}>
        {items.map((item) => <article key={item.id}>
          <span><strong>{item.name}</strong><small>{item.category}</small></span>
          <b>{item.quantity} {item.unit}</b>
          <span>{locationById.get(item.locationId)?.name ?? "Unknown location"}</span>
          <button
            onClick={() => onInventoryItemChange(item.id)}
            type="button"
          >
            View details
          </button>
        </article>)}
        {items.length === 0 && <p className={styles.empty}>No matching inventory</p>}
      </div>
    </section>
    <ItemDetails
      item={selectedItem}
      location={selectedItem
        ? locationById.get(selectedItem.locationId) ?? null
        : null}
      onClose={() => onInventoryItemChange(null)}
    />
  </div>;
}

function ReadOnlyPlans({
  onInventoryItemChange,
  onLocationChange,
  state,
}: Pick<
  ReadOnlyWorkspaceProps,
  "onInventoryItemChange" | "onLocationChange" | "state"
>) {
  const locationById = new Map(
    state.locations.map((location) => [location.id, location]),
  );
  const itemById = new Map(state.items.map((item) => [item.id, item]));
  const plans = state.plans.filter((plan) => plan.status !== "discarded");
  return <div className="content">
    {plans.map((plan) => <section className={`panel ${styles.plan}`} key={plan.id}>
      <header>
        <span><p className="eyebrow">{plan.status}</p><h2>{plan.name}</h2></span>
        <b>{plan.steps.filter((step) => step.completedAt).length} of {plan.steps.length} complete</b>
      </header>
      <ol>
        {plan.steps.map((step) => {
          const subject = step.type === "item"
            ? itemById.get(step.itemId ?? "")?.name ?? "Unknown item"
            : locationById.get(step.locationId ?? "")?.name ?? "Unknown space";
          const source = locationById.get(step.sourceId)?.name ?? "Unknown";
          const destination =
            locationById.get(step.destinationId)?.name ?? "Unknown";
          return <li data-complete={Boolean(step.completedAt)} key={step.id}>
            <span>
              <strong>{subject}</strong>
              <small>{source} to {destination}</small>
              <small>{step.explanation.join(" · ")}</small>
            </span>
            <div>
              {step.itemId && <button
                onClick={() => onInventoryItemChange(step.itemId)}
                type="button"
              >
                Review item
              </button>}
              <button
                onClick={() => onLocationChange(step.destinationId)}
                type="button"
              >
                Review destination
              </button>
            </div>
          </li>;
        })}
      </ol>
    </section>)}
    {plans.length === 0 && <section className={`panel ${styles.fullPanel}`}>
      <p className={styles.empty}>No active or completed plans</p>
    </section>}
  </div>;
}

function downloadWorkspace(state: WorkspaceState): void {
  const url = URL.createObjectURL(new Blob(
    [JSON.stringify(state, null, 2)],
    { type: "application/json" },
  ));
  try {
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `${state.workspace.name.replace(/\W+/g, "-").toLowerCase()}-backup.json`;
    anchor.click();
  } finally {
    URL.revokeObjectURL(url);
  }
}

function ReadOnlySettings({
  onOpenWorkspaceMenu,
  readOnlyReason,
  setTheme,
  state,
  theme,
  viewer,
}: Pick<
  ReadOnlyWorkspaceProps,
  | "onOpenWorkspaceMenu"
  | "readOnlyReason"
  | "setTheme"
  | "state"
  | "theme"
  | "viewer"
>) {
  const [exportFailureVersion, setExportFailureVersion] = useState(0);
  const accessPath = workspacePath({
    view: "access",
    workspaceId: state.workspace.id,
    workspaceLabel: state.workspace.name,
  });
  const exportWorkspace = () => {
    try {
      downloadWorkspace(state);
      setExportFailureVersion(0);
    } catch {
      setExportFailureVersion((current) => current + 1);
    }
  };
  return <div className={`${styles.settings} content`}>
    <section className="panel">
      <h2>Workspace</h2>
      <p className="muted">
        {viewer
          ? "Viewer access keeps workspace data read-only on this device."
          : readOnlyReason}
      </p>
      <button onClick={onOpenWorkspaceMenu} type="button">Workspaces and backup status</button>
      {viewer && <a href={accessPath}>Workspace access</a>}
      <h2>Appearance</h2>
      <div className={styles.themeChoices}>
        {(["system", "light", "dark"] as const).map((choice) => <button
          aria-pressed={theme === choice}
          key={choice}
          onClick={() => setTheme(choice)}
          type="button"
        >
          {choice}
        </button>)}
      </div>
    </section>
    <section className="panel">
      <h2>Backup and recovery</h2>
      <p className="muted">
        {viewer
          ? "Export remains available. Recovery operations that would change this workspace are unavailable to viewers."
          : "Export remains available. Recovery operations that would change this retained read-only copy are unavailable."}
      </p>
      <button onClick={exportWorkspace} type="button">
        Export JSON backup
      </button>
      {exportFailureVersion > 0 &&
        <p
          className={styles.alert}
          key={exportFailureVersion}
          role="alert"
        >
          {EXPORT_FAILURE_MESSAGE}
        </p>}
      <a href="/recovery">Inspect sync issues and recovery options</a>
      <a href="/labels">Print text and QR labels</a>
      <h2>Help</h2>
      <a href={USER_GUIDE_URL} rel="noreferrer" target="_blank">
        Open full user guide
      </a>
      <a href="/docs/">Read the offline quick guide</a>
    </section>
  </div>;
}

export function ReadOnlyWorkspace({
  inventoryItemId,
  inventoryLocationId,
  onInventoryItemChange,
  onInventoryLocationChange,
  onLocationChange,
  onOpenWorkspaceMenu,
  readOnlyReason,
  selectedLocationId,
  setTheme,
  state,
  theme,
  view,
  viewer,
}: ReadOnlyWorkspaceProps) {
  if (view === "capture") {
    return <ReadOnlyCapture
      onLocationChange={onLocationChange}
      selectedLocationId={selectedLocationId}
      state={state}
    />;
  }
  if (view === "spaces") {
    return <ReadOnlySpaces
      onLocationChange={onLocationChange}
      selectedLocationId={selectedLocationId}
      state={state}
    />;
  }
  if (view === "inventory") {
    return <ReadOnlyInventory
      inventoryItemId={inventoryItemId}
      inventoryLocationId={inventoryLocationId}
      onInventoryItemChange={onInventoryItemChange}
      onInventoryLocationChange={onInventoryLocationChange}
      state={state}
    />;
  }
  if (view === "plan") {
    return <ReadOnlyPlans
      onInventoryItemChange={onInventoryItemChange}
      onLocationChange={onLocationChange}
      state={state}
    />;
  }
  if (view === "activity") return <ActivityHistory state={state} />;
  return <ReadOnlySettings
    onOpenWorkspaceMenu={onOpenWorkspaceMenu}
    readOnlyReason={readOnlyReason}
    setTheme={setTheme}
    state={state}
    theme={theme}
    viewer={viewer}
  />;
}
