"use client";

import { useMemo, useState } from "react";
import { Boxes, Check, ChevronRight, MapPin, Package, Pin, Search } from "lucide-react";
import { resolvePlanSelection } from "../domain/plan-selection";
import type { PlanSelection, WorkspaceState } from "../domain/types";
import { ModalDialog } from "./modal-dialog";
import { locationPath } from "./workspace-hierarchy";
import styles from "./plan-selection.module.css";

const PAGE_SIZE = 30;

export function PlanSelectionSummary({ selection, state }: { selection?: PlanSelection; state: WorkspaceState }) {
  const names = selection?.locationIds === null || !selection
    ? "Whole workspace"
    : selection.locationIds.map((id) => state.locations.find((location) => location.id === id)?.name ?? "Unavailable space").join(", ") || "No areas selected";
  const pins = (selection?.pinnedItemIds.length ?? 0) + (selection?.pinnedLocationIds.length ?? 0);
  return <div className={styles.summary} aria-label="Saved plan areas and pins">
    <span><MapPin aria-hidden="true" />{names}</span>
    {pins > 0 && <span data-pinned="true"><Pin aria-hidden="true" />{pins} {pins === 1 ? "pin" : "pins"}</span>}
  </div>;
}

export function PlanSelectionControls({ state, value, onChange }: {
  state: WorkspaceState;
  value: PlanSelection;
  onChange: (selection: PlanSelection) => void;
}) {
  const [sheet, setSheet] = useState<"areas" | "pins" | null>(null);
  const [search, setSearch] = useState("");
  const [tab, setTab] = useState<"items" | "spaces">("items");
  const [limit, setLimit] = useState(PAGE_SIZE);
  const resolved = useMemo(() => resolvePlanSelection(state, value), [state, value]);
  const locations = useMemo(() => state.locations.filter((location) => !location.archivedAt).map((location) => ({
    ...location,
    path: locationPath(state.locations, location.id).map((part) => part.name).join(" › "),
  })).sort((a, b) => a.path.localeCompare(b.path)), [state.locations]);
  const locationById = useMemo(() => new Map(locations.map((location) => [location.id, location])), [locations]);
  const needle = search.trim().toLocaleLowerCase();
  const matchingLocations = locations.filter((location) => `${location.path} ${location.code}`.toLocaleLowerCase().includes(needle));
  const items = state.items.filter((item) => !item.archivedAt &&
    `${item.name} ${locationById.get(item.locationId)?.path ?? ""}`.toLocaleLowerCase().includes(needle));
  const pinCount = value.pinnedItemIds.length + value.pinnedLocationIds.length;
  const availableItems = state.items.filter((item) => !item.archivedAt && resolved.canMoveItem(item.id, item.locationId)).length;
  const toggle = (ids: string[], id: string) => ids.includes(id) ? ids.filter((candidate) => candidate !== id) : [...ids, id];
  const open = (next: "areas" | "pins") => { setSearch(""); setLimit(PAGE_SIZE); setSheet(next); };
  const stale = [...(value.locationIds ?? []), ...value.pinnedLocationIds].some((id) => !locations.some((location) => location.id === id)) ||
    value.pinnedItemIds.some((id) => !state.items.some((item) => item.id === id && !item.archivedAt));
  const showingItems = sheet === "pins" && tab === "items";
  const resultCount = showingItems ? items.length : matchingLocations.length;
  return <div className={styles.controls}>
    <div className={styles.triggers}>
      <button aria-haspopup="dialog" onClick={() => open("areas")} type="button">
        <MapPin aria-hidden="true" /><span><strong>Areas</strong><small>{value.locationIds === null ? "Whole workspace" : `${value.locationIds.length} selected`}</small></span><ChevronRight aria-hidden="true" />
      </button>
      <button aria-haspopup="dialog" data-pinned={pinCount > 0 || undefined} onClick={() => open("pins")} type="button">
        <Pin aria-hidden="true" /><span><strong>Pins</strong><small>{pinCount ? `${pinCount} kept in place` : "Keep placements"}</small></span><ChevronRight aria-hidden="true" />
      </button>
    </div>
    <small className={styles.count}><Package aria-hidden="true" />{availableItems} {availableItems === 1 ? "item" : "items"} available to plan{value.locationIds?.length === 0 ? ". Choose an area to begin." : ""}</small>
    {stale && <div role="alert" className={styles.warning}>Some selected records are unavailable. <button type="button" onClick={() => onChange({
      locationIds: value.locationIds?.filter((id) => locations.some((location) => location.id === id)) ?? null,
      pinnedLocationIds: value.pinnedLocationIds.filter((id) => locations.some((location) => location.id === id)),
      pinnedItemIds: value.pinnedItemIds.filter((id) => state.items.some((item) => item.id === id && !item.archivedAt)),
    })}>Remove unavailable selections</button></div>}
    <ModalDialog mobileSheet="full" onClose={() => setSheet(null)} open={sheet !== null} title={sheet === "areas" ? "Plan areas" : "Pinned placements"}>
      <div className={styles.sheet}>
        <p className={styles.hint}>{sheet === "areas" ? "Moves stay inside your selected spaces and their nested contents." : "Pins apply to this plan. Pin a space to keep it and everything inside in place."}</p>
        <div className={styles.actions}>
          {sheet === "areas" ? <>
            <button aria-pressed={value.locationIds === null} onClick={() => onChange({ ...value, locationIds: null })} type="button"><Boxes aria-hidden="true" />Whole workspace</button>
            <button onClick={() => onChange({ ...value, locationIds: [] })} type="button">Clear areas</button>
          </> : <>
            <div className={styles.tabs} role="group" aria-label="Pin type">
              <button aria-pressed={tab === "items"} onClick={() => { setTab("items"); setLimit(PAGE_SIZE); }} type="button"><Package aria-hidden="true" />Items</button>
              <button aria-pressed={tab === "spaces"} onClick={() => { setTab("spaces"); setLimit(PAGE_SIZE); }} type="button"><Boxes aria-hidden="true" />Spaces</button>
            </div>
            <button disabled={!pinCount} onClick={() => onChange({ ...value, pinnedItemIds: [], pinnedLocationIds: [] })} type="button">Clear pins</button>
          </>}
        </div>
        <label className={styles.search}><Search aria-hidden="true" /><input name="planSelectionSearch" aria-label={sheet === "areas" ? "Search areas" : "Search placements"} value={search} onChange={(event) => { setSearch(event.target.value); setLimit(PAGE_SIZE); }} placeholder={showingItems ? "Find an item or space" : "Find a space"} type="search" /></label>
        <div className={styles.list}>
          {showingItems ? items.slice(0, limit).map((item) => {
            const direct = value.pinnedItemIds.includes(item.id);
            const inherited = resolved.pinnedLocationIds.has(item.locationId);
            return <label className={styles.row} data-selected={direct || inherited} key={item.id}>
              <input name="planPinnedItem" value={item.id} aria-label={`Pin ${item.name}`} type="checkbox" checked={direct || inherited} disabled={inherited} onChange={() => onChange({ ...value, pinnedItemIds: toggle(value.pinnedItemIds, item.id) })} />
              <Package aria-hidden="true" /><span><strong>{item.name}</strong><small>{locationById.get(item.locationId)?.path}</small>{inherited && <small>Pinned with its space</small>}{!resolved.locationIds.has(item.locationId) && <small>Outside selected areas</small>}</span>{(direct || inherited) && <Pin aria-hidden="true" />}
            </label>;
          }) : matchingLocations.slice(0, limit).map((location) => {
            const area = sheet === "areas";
            const direct = area ? value.locationIds?.includes(location.id) ?? false : value.pinnedLocationIds.includes(location.id);
            const inherited = area ? value.locationIds !== null && resolved.locationIds.has(location.id) && !direct : resolved.pinnedLocationIds.has(location.id) && !direct;
            return <label className={styles.row} data-selected={direct || inherited} key={location.id}>
              <input name={area ? "planArea" : "planPinnedSpace"} value={location.id} aria-label={`${area ? "Include" : "Pin"} ${location.name}`} type="checkbox" checked={direct || inherited} disabled={inherited && (!area || value.locationIds !== null)} onChange={() => onChange(area
                ? { ...value, locationIds: toggle(value.locationIds ?? [], location.id) }
                : { ...value, pinnedLocationIds: toggle(value.pinnedLocationIds, location.id) })} />
              {area ? <MapPin aria-hidden="true" /> : <Boxes aria-hidden="true" />}<span><strong>{location.name} <small>{location.code}</small></strong><small>{location.path}</small>{inherited && <small>{area ? value.locationIds === null ? "Whole workspace" : "Included with parent" : "Pinned with parent"}</small>}</span>{(direct || inherited) && (area ? <Check aria-hidden="true" /> : <Pin aria-hidden="true" />)}
            </label>;
          })}
          {resultCount === 0 && <p className={styles.hint}>No matches. Try another name.</p>}
        </div>
        {resultCount > limit && <button onClick={() => setLimit((current) => current + PAGE_SIZE)} type="button">Show more ({resultCount - limit} remaining)</button>}
        <div className={styles.footer}><small>{sheet === "areas" ? `${resolved.locationIds.size} spaces included` : `${pinCount} pins`}</small><button className="primary" onClick={() => setSheet(null)} type="button">Done</button></div>
      </div>
    </ModalDialog>
  </div>;
}
