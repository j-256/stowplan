"use client";

import { useEffect, useMemo, useState } from "react";
import {
  Activity,
  Archive,
  ArrowDown,
  ArrowUp,
  Boxes,
  ClipboardList,
  Edit3,
  GripVertical,
  Home,
  Map as MapIcon,
  Moon,
  PackagePlus,
  RotateCcw,
  Search,
  Settings,
  Sun,
  Trash2,
  Undo2,
  Wifi,
  WifiOff,
  X,
} from "lucide-react";
import { createDemoState } from "../domain/demo";
import { createEmptyState, createItem, createLocation, newId } from "../domain/factories";
import { DEFAULT_PLAN_WEIGHTS, generatePlan as buildMovePlan } from "../domain/planner";
import type {
  CaptureStatus,
  Command,
  Frequency,
  ItemRecord,
  Location,
  LocationKind,
  PlanWeights,
  ThemePreference,
  WorkspaceState,
} from "../domain/types";
import { listWorkspaceReplicas, type LocalWorkspaceSummary } from "./local-replica";
import { StowplanProvider, useStowplan } from "./store";

type View = "capture" | "spaces" | "inventory" | "plan" | "activity" | "settings";
type Commit = (command: Command) => Promise<void>;
type DragPayload = { id: string; type: "item" | "location" };

const nav: { id: View; label: string; icon: typeof Boxes }[] = [
  { id: "capture", label: "Capture", icon: PackagePlus },
  { id: "spaces", label: "Spaces", icon: MapIcon },
  { id: "inventory", label: "Inventory", icon: Boxes },
  { id: "plan", label: "Plan", icon: ClipboardList },
  { id: "activity", label: "Activity", icon: Activity },
  { id: "settings", label: "Settings", icon: Settings },
];
const kinds: LocationKind[] = ["room", "zone", "area", "cabinet", "drawer", "shelf", "box", "bin", "container"];
const frequencies: Frequency[] = ["daily", "weekly", "monthly", "rarely"];
const dragType = "application/x-stowplan-record";

function sortItems(items: ItemRecord[]): ItemRecord[] {
  return [...items].sort((left, right) => left.order - right.order || left.createdAt.localeCompare(right.createdAt));
}
function sortLocations(locations: Location[]): Location[] {
  return [...locations].sort((left, right) => left.order - right.order || left.name.localeCompare(right.name));
}
function nextOrder<T extends { order: number }>(records: T[]): number {
  return records.reduce((maximum, record) => Math.max(maximum, record.order), -1) + 1;
}
function movedOrder<T extends { id: string; order: number }>(records: T[], id: string, direction: -1 | 1): number | null {
  const sorted = [...records].sort((left, right) => left.order - right.order || left.id.localeCompare(right.id));
  const index = sorted.findIndex((record) => record.id === id);
  const destination = index + direction;
  if (index < 0 || destination < 0 || destination >= sorted.length) return null;
  if (direction < 0) {
    const target = sorted[destination];
    const before = sorted[destination - 1];
    return before ? (before.order + target.order) / 2 : target.order - 1;
  }
  const target = sorted[destination];
  const after = sorted[destination + 1];
  return after ? (target.order + after.order) / 2 : target.order + 1;
}
function orderBefore<T extends { id: string; order: number }>(records: T[], sourceId: string, targetId: string): number | null {
  if (sourceId === targetId) return null;
  const sorted = [...records]
    .filter((record) => record.id !== sourceId)
    .sort((left, right) => left.order - right.order || left.id.localeCompare(right.id));
  const index = sorted.findIndex((record) => record.id === targetId);
  if (index < 0) return null;
  const target = sorted[index];
  const before = sorted[index - 1];
  return before ? (before.order + target.order) / 2 : target.order - 1;
}
function writeDrag(event: React.DragEvent, payload: DragPayload): void {
  const value = JSON.stringify(payload);
  event.dataTransfer.effectAllowed = "move";
  event.dataTransfer.setData(dragType, value);
  event.dataTransfer.setData("text/plain", value);
}
function readDrag(event: React.DragEvent): DragPayload | null {
  try {
    const parsed = JSON.parse(event.dataTransfer.getData(dragType) || event.dataTransfer.getData("text/plain")) as DragPayload;
    return parsed && (parsed.type === "item" || parsed.type === "location") ? parsed : null;
  } catch {
    return null;
  }
}
function splitList(value: FormDataEntryValue | null): string[] {
  return String(value ?? "").split(",").map((part) => part.trim()).filter(Boolean);
}
async function perform(commit: Commit, command: Command, after?: () => void): Promise<void> {
  try {
    await commit(command);
    after?.();
  } catch (error) {
    window.alert(error instanceof Error ? error.message : "That change could not be applied");
  }
}
function descendantIds(state: WorkspaceState, locationId: string): string[] {
  const found: string[] = [];
  const queue = [locationId];
  while (queue.length) {
    const parent = queue.shift() as string;
    for (const child of state.locations.filter((location) => location.parentId === parent)) {
      found.push(child.id);
      queue.push(child.id);
    }
  }
  return found;
}

export function StowplanApp() {
  return <StowplanProvider><Application /></StowplanProvider>;
}

function Application() {
  const { state, initialize, dispatch, openWorkspace, online, pending, blocked, replace, syncing } = useStowplan();
  const [view, setView] = useState<View>("capture");
  const [selected, setSelected] = useState<string | null>(null);
  const [showWelcome, setShowWelcome] = useState(false);
  const [theme, setTheme] = useState<ThemePreference>("system");
  const [workspaceNotice, setWorkspaceNotice] = useState("");

  useEffect(() => {
    queueMicrotask(() => {
      const saved = localStorage.getItem("stowplan-theme") as ThemePreference | null;
      if (saved) setTheme(saved);
      const container = new URLSearchParams(location.search).get("container");
      if (container) setSelected(container);
    });
    if ("serviceWorker" in navigator) navigator.serviceWorker.register("/sw.js").catch(() => undefined);
  }, []);
  useEffect(() => {
    const media = matchMedia("(prefers-color-scheme:dark)");
    const apply = () => { document.documentElement.dataset.theme = theme === "dark" || (theme === "system" && media.matches) ? "dark" : "light"; };
    apply();
    localStorage.setItem("stowplan-theme", theme);
    if (theme === "system") media.addEventListener("change", apply);
    return () => media.removeEventListener("change", apply);
  }, [theme]);
  useEffect(() => {
    const url = new URL(location.href);
    const workspaceId = url.searchParams.get("workspace");
    if (!workspaceId) return;
    void openWorkspace(workspaceId).then(() => {
      setWorkspaceNotice("Shared workspace opened. Your previous local workspace is still available in Settings.");
      url.searchParams.delete("workspace");
      history.replaceState(null, "", `${url.pathname}${url.search}${url.hash}`);
    }).catch((error) => setWorkspaceNotice(error instanceof Error ? error.message : "Could not open the shared workspace"));
  }, [openWorkspace]);

  const enter = (next: WorkspaceState) => {
    setSelected(next.locations[0]?.id ?? null);
    setView("capture");
    setShowWelcome(false);
  };
  const start = async (demo: boolean) => {
    const next = demo ? createDemoState(newId("ws_demo")) : createEmptyState();
    await initialize(next);
    enter(next);
  };
  const openDemo = async () => {
    const demo = (await listWorkspaceReplicas()).find((workspace) => workspace.id.startsWith("ws_demo"));
    if (demo) {
      await openWorkspace(demo.id);
      setSelected(null);
      setView("capture");
      setShowWelcome(false);
      return;
    }
    await start(true);
  };
  const resetDemo = async () => {
    if (!confirm("Reset the kitchen demo? Every change and queued backup belonging to this demo will be discarded. Your other workspaces are not affected.")) return;
    const next = createDemoState(newId("ws_demo"));
    await replace(next);
    enter(next);
  };

  if (!state) {
    return <><Onboarding onStart={start} />{workspaceNotice && <output className="workspace-notice onboarding-notice">{workspaceNotice}</output>}</>;
  }
  if (showWelcome) {
    return <Onboarding currentName={state.workspace.name} isDemo={state.workspace.id.startsWith("ws_demo")} onContinue={() => setShowWelcome(false)} onOpenDemo={openDemo} onResetDemo={resetDemo} onStart={start} />;
  }
  const current = state.locations.find((location) => location.id === selected) ?? state.locations.find((location) => !location.archivedAt) ?? null;
  return <div className="app-shell">
    <aside>
      <Brand />
      <nav>{nav.map((entry) => <Nav key={entry.id} {...entry} active={entry.id === view} select={() => setView(entry.id)} />)}</nav>
      <div className="sync">{online ? <Wifi /> : <WifiOff />}<span>{blocked ? `${blocked} need review` : syncing ? "Backing up…" : pending ? `${pending} saved on device` : online ? "Up to date" : "Working offline"}</span></div>
    </aside>
    <main>
      <header><div><p className="eyebrow">{state.workspace.name}</p><h1>{nav.find((entry) => entry.id === view)?.label}</h1></div><div className="header-actions"><button className="icon" aria-label="Open main menu" onClick={() => setShowWelcome(true)}><Home /></button><button className="icon" aria-label="Change theme" onClick={() => setTheme(theme === "system" ? "dark" : theme === "dark" ? "light" : "system")}>{theme === "dark" ? <Moon /> : <Sun />}</button></div></header>
      {view === "capture" && <Capture state={state} current={current} select={setSelected} commit={dispatch} />}
      {view === "spaces" && <Spaces state={state} current={current} select={setSelected} commit={dispatch} />}
      {view === "inventory" && <Inventory state={state} commit={dispatch} />}
      {view === "plan" && <Planner state={state} commit={dispatch} />}
      {view === "activity" && <History state={state} commit={dispatch} />}
      {workspaceNotice && <output className="workspace-notice">{workspaceNotice}</output>}
      {view === "settings" && <Preferences state={state} theme={theme} setTheme={setTheme} openMenu={() => setShowWelcome(true)} openWorkspace={openWorkspace} />}
    </main>
    <nav className="bottom">{nav.map((entry) => <Nav key={entry.id} {...entry} active={entry.id === view} select={() => setView(entry.id)} />)}</nav>
  </div>;
}

function Brand() {
  return <div className="brand"><b>S</b><span><strong>Stowplan</strong><small>Know where everything lives</small></span></div>;
}
function Nav({ label, icon: Icon, active, select }: { label: string; icon: typeof Boxes; active: boolean; select: () => void }) {
  return <button className="nav" data-active={active} onClick={select}><Icon /><span>{label}</span></button>;
}
function Onboarding({ currentName, isDemo = false, onContinue, onOpenDemo, onResetDemo, onStart }: { currentName?: string; isDemo?: boolean; onContinue?: () => void; onOpenDemo?: () => Promise<void>; onResetDemo?: () => Promise<void>; onStart: (demo: boolean) => Promise<void> }) {
  if (currentName) return <main className="onboarding"><section><Brand /><p className="eyebrow">Main menu</p><h1>Where to next?</h1><p><strong>{currentName}</strong> is still open and saved on this device.</p><button className="primary" onClick={onContinue}>Continue current workspace</button><button onClick={() => void onStart(false)}>Start a new workspace</button>{isDemo ? <button className="danger menu-action" onClick={() => void onResetDemo?.()}><RotateCcw /> Reset kitchen demo</button> : <button className="linkish" onClick={() => void onOpenDemo?.()}>Open kitchen demo</button>}<small>Starting or opening another workspace does not erase your current one. Reset affects only the active demo.</small></section></main>;
  return <main className="onboarding"><section><Brand /><p className="eyebrow">A calmer first pass</p><h1>Label it. Count it.<br />Find it later.</h1><p>Start with one box, drawer, or cabinet. Stowplan remembers nested containers and keeps working without connectivity or a healthy server.</p><div className="steps"><span><b>1</b>Label a space</span><span><b>2</b>Add what is inside</span><span><b>3</b>Mark it counted</span></div><button className="primary" onClick={() => void onStart(false)}>Start my workspace</button><button className="linkish" onClick={() => void onStart(true)}>Explore the kitchen demo instead</button><small>Your inventory is saved on this device first.</small></section></main>;
}

function Capture({ state, current, select, commit }: { state: WorkspaceState; current: Location | null; select: (id: string) => void; commit: Commit }) {
  const [editing, setEditing] = useState<string | null>(null);
  const [queueQuery, setQueueQuery] = useState("");
  const live = sortLocations(state.locations.filter((location) => !location.archivedAt));
  const queueShown = live.filter((location) => [location.code, location.name, ...location.tags].join(" ").toLocaleLowerCase().includes(queueQuery.toLocaleLowerCase()));
  const done = live.filter((location) => ["counted", "known_empty"].includes(location.captureStatus)).length;
  const items = current ? sortItems(state.items.filter((item) => item.locationId === current.id && !item.archivedAt)) : [];
  const nested = current ? sortLocations(live.filter((location) => location.parentId === current.id)) : [];
  const addContainer = async (data: FormData) => {
    const parentId = data.get("topLevel") === "on" ? null : current?.id ?? null;
    const siblings = live.filter((location) => location.parentId === parentId);
    await perform(commit, { type: "location.create", location: createLocation({ code: String(data.get("code")), name: String(data.get("name")), kind: String(data.get("kind")) as LocationKind, parentId, order: nextOrder(siblings) }) });
  };
  const finish = async (status: CaptureStatus) => {
    if (!current) return;
    const next = live.find((location) => location.id !== current.id && !["counted", "known_empty"].includes(location.captureStatus));
    await perform(commit, { type: "capture.status", id: current.id, status }, () => { if (next) select(next.id); });
  };
  const reorder = (id: string, direction: -1 | 1) => {
    const order = movedOrder(items, id, direction);
    if (order !== null) void perform(commit, { type: "item.reorder", id, order });
  };
  const dropOnItem = (event: React.DragEvent, targetId: string) => {
    event.preventDefault();
    const payload = readDrag(event);
    if (payload?.type !== "item") return;
    const source = state.items.find((item) => item.id === payload.id);
    const target = state.items.find((item) => item.id === targetId);
    if (!source || !target || source.locationId !== target.locationId) return;
    const order = orderBefore(items, source.id, target.id);
    if (order !== null) void perform(commit, { type: "item.reorder", id: source.id, order });
  };

  return <div className="content capture">
    <section className="panel queue"><div className="title"><div><p className="eyebrow">First-pass coverage</p><h2>{done} of {live.length} checked</h2></div><b>{live.length - done} left</b></div><div className="progress"><i style={{ width: `${live.length ? done / live.length * 100 : 0}%` }} /></div>{live.length > 5 && <label className="queue-search"><Search /><input aria-label="Find container" value={queueQuery} onChange={(event) => setQueueQuery(event.target.value)} placeholder="Jump by code or name" /></label>}{queueShown.map((location) => <button key={location.id} data-active={current?.id === location.id} onClick={() => select(location.id)}><span><b>{location.code}</b>{location.name}</span><small>{location.captureStatus.replace("_", " ")}</small></button>)}{queueShown.length === 0 && <p className="muted queue-empty">No matching container.</p>}<form action={addContainer} className="nested"><div className="form-pair"><input required name="code" placeholder="Label code" /><select name="kind" aria-label="Container type" defaultValue={current ? "box" : "room"}>{kinds.map((kind) => <option key={kind}>{kind}</option>)}</select></div><input required name="name" placeholder={current ? "Nested box or bin" : "First room or area"} />{current && <label className="top-level"><input type="checkbox" name="topLevel" /> Add as another top-level space</label>}<button>{current ? "Add space" : "Add first space"}</button></form></section>
    <section className="panel capture-card">{current ? <><div className="title"><div><p className="eyebrow">Inside</p><h2>{current.code} · {current.name}</h2></div><span className="tag">{current.captureStatus.replace("_", " ")}</span></div><form className="quick" action={async (data) => { const siblings = state.items.filter((item) => item.locationId === current.id && !item.archivedAt); await perform(commit, { type: "item.create", item: createItem({ locationId: current.id, name: String(data.get("name")), quantity: Number(data.get("quantity")), unit: String(data.get("unit")), order: nextOrder(siblings) }) }); }}><label>Qty<input required type="number" min="0.01" step="any" name="quantity" defaultValue="1" /></label><label>Unit<select name="unit"><option>each</option><option>boxes</option><option>bags</option><option>cans</option><option>pairs</option></select></label><label className="grow">What is it?<input required name="name" placeholder="e.g. winter gloves" /></label><button className="primary">Save & add next</button></form>
      {nested.length > 0 && <div className="nested-list"><small>Nested containers</small>{nested.map((location) => <button key={location.id} onClick={() => select(location.id)}><b>{location.code}</b><span>{location.name}</span><small>{location.captureStatus.replace("_", " ")}</small></button>)}</div>}
      <div className="captured">{items.map((item, index) => <div className="captured-row" data-item-id={item.id} key={item.id} draggable onDragStart={(event) => writeDrag(event, { type: "item", id: item.id })} onDragOver={(event) => event.preventDefault()} onDrop={(event) => dropOnItem(event, item.id)}><GripVertical className="grip" aria-hidden /><b>{item.quantity} {item.unit}</b><button className="item-name" onClick={() => setEditing(item.id)}><strong>{item.name}</strong><small>{item.category} · {item.frequency}</small></button><div className="row-actions"><button className="icon small" aria-label={`Move ${item.name} up`} disabled={index === 0} onClick={() => reorder(item.id, -1)}><ArrowUp /></button><button className="icon small" aria-label={`Move ${item.name} down`} disabled={index === items.length - 1} onClick={() => reorder(item.id, 1)}><ArrowDown /></button><button className="icon small" aria-label={`Edit ${item.name}`} onClick={() => setEditing(item.id)}><Edit3 /></button></div></div>)}{!items.length && <Empty title="Nothing recorded yet" text="Add an item, or mark this space as known empty." />}</div><div className="finish"><button onClick={() => void finish("known_empty")}>Known empty & next</button><button className="primary" onClick={() => void finish("counted")}>Mark counted & next</button></div></> : <Empty title="Add your first space" text="Give a room, cabinet, box, or drawer the same code as its physical label." />}</section>
    {editing && state.items.find((item) => item.id === editing) && <ItemEditor item={state.items.find((item) => item.id === editing) as ItemRecord} state={state} commit={commit} close={() => setEditing(null)} />}
  </div>;
}

function Spaces({ state, current, select, commit }: { state: WorkspaceState; current: Location | null; select: (id: string) => void; commit: Commit }) {
  const [editingItem, setEditingItem] = useState<string | null>(null);
  const live = state.locations.filter((location) => !location.archivedAt);
  const archived = state.locations.filter((location) => location.archivedAt);
  const dropInto = (event: React.DragEvent, parentId: string | null) => {
    event.preventDefault();
    const payload = readDrag(event);
    if (!payload) return;
    if (payload.type === "item" && parentId) {
      const item = state.items.find((candidate) => candidate.id === payload.id);
      if (item && item.locationId !== parentId) void perform(commit, { type: "item.move", id: item.id, destinationId: parentId, quantity: item.quantity });
      return;
    }
    if (payload.type === "location") {
      const location = state.locations.find((candidate) => candidate.id === payload.id);
      if (!location || location.id === parentId) return;
      const siblings = live.filter((candidate) => candidate.parentId === parentId && candidate.id !== location.id);
      void perform(commit, { type: "location.move", id: location.id, parentId, order: nextOrder(siblings) });
    }
  };
  const reorderLocation = (location: Location, direction: -1 | 1) => {
    const siblings = live.filter((candidate) => candidate.parentId === location.parentId);
    const order = movedOrder(siblings, location.id, direction);
    if (order !== null) void perform(commit, { type: "location.reorder", id: location.id, order });
  };
  const branch = (parentId: string | null, depth = 0): React.ReactNode => sortLocations(live.filter((location) => location.parentId === parentId)).map((location) => {
    const siblings = sortLocations(live.filter((candidate) => candidate.parentId === location.parentId));
    const index = siblings.findIndex((candidate) => candidate.id === location.id);
    return <div key={location.id}><div className="tree-row" data-location-id={location.id} data-active={current?.id === location.id} style={{ paddingLeft: 12 + depth * 18 }} draggable onDragStart={(event) => { event.stopPropagation(); writeDrag(event, { type: "location", id: location.id }); }} onDragOver={(event) => event.preventDefault()} onDrop={(event) => { event.stopPropagation(); dropInto(event, location.id); }}><GripVertical className="grip" aria-hidden /><button className="tree-select" onClick={() => select(location.id)}><b>{location.code}</b><span>{location.name}</span><small>{state.items.filter((item) => item.locationId === location.id && !item.archivedAt).length}</small></button><div className="row-actions"><button className="icon small" aria-label={`Move ${location.name} up`} disabled={index === 0} onClick={() => reorderLocation(location, -1)}><ArrowUp /></button><button className="icon small" aria-label={`Move ${location.name} down`} disabled={index === siblings.length - 1} onClick={() => reorderLocation(location, 1)}><ArrowDown /></button></div></div>{branch(location.id, depth + 1)}</div>;
  });
  const removeLocation = (location: Location) => {
    const descendants = descendantIds(state, location.id);
    const locationIds = [location.id, ...descendants];
    const itemIds = state.items.filter((item) => locationIds.includes(item.locationId)).map((item) => item.id);
    if (confirm(`Permanently delete ${location.name}, ${descendants.length} nested space(s), and ${itemIds.length} item record(s)? You can still undo this from Activity.`)) {
      void perform(commit, { type: "location.delete", id: location.id, descendantIds: descendants, itemIds }, () => select(live.find((candidate) => !locationIds.includes(candidate.id))?.id ?? ""));
    }
  };

  return <div className="content split"><section className="panel tree-panel"><div className="title"><div><p className="eyebrow">Drag to nest</p><h2>Location tree</h2></div></div><div className="root-drop" onDragOver={(event) => event.preventDefault()} onDrop={(event) => dropInto(event, null)}>Drop a container here to move it to the top level</div>{branch(null)}{archived.length > 0 && <details className="archived"><summary>{archived.length} archived</summary>{archived.map((location) => <div key={location.id}><span>{location.code} · {location.name}</span><button onClick={() => void perform(commit, { type: "location.archive", id: location.id, archived: false })}>Restore</button></div>)}</details>}</section><section className="panel inspector">{current ? <LocationEditor key={current.id} state={state} location={current} commit={commit} select={select} reorder={reorderLocation} remove={() => removeLocation(current)} editItem={setEditingItem} /> : <Empty title="Select a space" text="Edit it, move it, or drop an item or container onto it." />}</section>{editingItem && state.items.find((item) => item.id === editingItem) && <ItemEditor item={state.items.find((item) => item.id === editingItem) as ItemRecord} state={state} commit={commit} close={() => setEditingItem(null)} />}</div>;
}

function LocationEditor({ state, location, commit, select, reorder, remove, editItem }: { state: WorkspaceState; location: Location; commit: Commit; select: (id: string) => void; reorder: (location: Location, direction: -1 | 1) => void; remove: () => void; editItem: (id: string) => void }) {
  const invalidParents = new Set([location.id, ...descendantIds(state, location.id)]);
  const contents = sortItems(state.items.filter((item) => item.locationId === location.id && !item.archivedAt));
  const save = async (data: FormData) => {
    const width = Number(data.get("width")), height = Number(data.get("height")), depth = Number(data.get("depth"));
    const dimensions = width > 0 && height > 0 && depth > 0 ? { width, height, depth, unit: String(data.get("dimensionUnit")) as "cm" | "in" } : null;
    await perform(commit, { type: "location.update", id: location.id, changes: {
      name: String(data.get("name")), code: String(data.get("code")), kind: String(data.get("kind")) as LocationKind,
      description: String(data.get("description")), tags: splitList(data.get("tags")), dimensions,
      conditions: { dark: data.get("dark") === "on", dry: data.get("dry") === "on", foodSafe: data.get("foodSafe") === "on", humidity: String(data.get("humidity")) as Location["conditions"]["humidity"], temperature: String(data.get("temperature")) as Location["conditions"]["temperature"] },
    } });
    const parentId = String(data.get("parentId")) || null;
    if (parentId !== location.parentId) await perform(commit, { type: "location.move", id: location.id, parentId });
  };
  return <><form action={save} className="editor-form"><div className="title"><div><p className="eyebrow">{location.kind}</p><h2>Edit space</h2></div><span className="tag">{location.captureStatus.replace("_", " ")}</span></div><div className="form-grid"><label>Name<input required name="name" defaultValue={location.name} /></label><label>Label code<input required name="code" defaultValue={location.code} /></label><label>Type<select name="kind" defaultValue={location.kind}>{kinds.map((kind) => <option key={kind}>{kind}</option>)}</select></label><label>Inside<select name="parentId" defaultValue={location.parentId ?? ""}><option value="">Top level</option>{sortLocations(state.locations.filter((candidate) => !candidate.archivedAt && !invalidParents.has(candidate.id))).map((candidate) => <option key={candidate.id} value={candidate.id}>{candidate.code} · {candidate.name}</option>)}</select></label><label className="wide">Tags, comma-separated<input name="tags" defaultValue={location.tags.join(", ")} /></label><label className="wide">Description<textarea name="description" defaultValue={location.description} /></label></div><fieldset><legend>Suitability</legend><div className="check-grid"><label><input type="checkbox" name="foodSafe" defaultChecked={location.conditions.foodSafe} /> Food safe</label><label><input type="checkbox" name="dry" defaultChecked={location.conditions.dry} /> Dry</label><label><input type="checkbox" name="dark" defaultChecked={location.conditions.dark} /> Dark</label><label>Temperature<select name="temperature" defaultValue={location.conditions.temperature}><option>cold</option><option>cool</option><option>normal</option><option>warm</option></select></label><label>Humidity<select name="humidity" defaultValue={location.conditions.humidity}><option>dry</option><option>normal</option><option>humid</option></select></label></div></fieldset><fieldset><legend>Interior dimensions (optional)</legend><div className="dimension-grid"><label>W<input name="width" type="number" min="0" step="any" defaultValue={location.dimensions?.width} /></label><label>H<input name="height" type="number" min="0" step="any" defaultValue={location.dimensions?.height} /></label><label>D<input name="depth" type="number" min="0" step="any" defaultValue={location.dimensions?.depth} /></label><label>Unit<select name="dimensionUnit" defaultValue={location.dimensions?.unit ?? "in"}><option>in</option><option>cm</option></select></label></div></fieldset><button className="primary">Save space</button></form><div className="inspector-actions"><button onClick={() => reorder(location, -1)}><ArrowUp /> Earlier</button><button onClick={() => reorder(location, 1)}><ArrowDown /> Later</button><button onClick={() => void perform(commit, { type: "location.archive", id: location.id, archived: true }, () => select(state.locations.find((candidate) => !candidate.archivedAt && candidate.id !== location.id)?.id ?? ""))}><Archive /> Archive</button><button className="danger" onClick={remove}><Trash2 /> Delete subtree</button></div><form className="nested inline-add" action={async (data) => { const children = state.locations.filter((candidate) => candidate.parentId === location.id && !candidate.archivedAt); const child = createLocation({ code: String(data.get("code")), name: String(data.get("name")), kind: String(data.get("kind")) as LocationKind, parentId: location.id, order: nextOrder(children) }); await perform(commit, { type: "location.create", location: child }); }}><h3>Add inside {location.name}</h3><div className="form-pair"><input required name="code" placeholder="Code" /><select name="kind" defaultValue="box">{kinds.map((kind) => <option key={kind}>{kind}</option>)}</select></div><input required name="name" placeholder="Name" /><button>Add nested space</button></form><div className="location-contents"><h3>Direct contents <small>{contents.length} records</small></h3>{contents.map((item) => <button key={item.id} draggable onDragStart={(event) => writeDrag(event, { type: "item", id: item.id })} onClick={() => editItem(item.id)}><GripVertical className="grip" /><span><strong>{item.name}</strong><small>{item.quantity} {item.unit}</small></span><Edit3 /></button>)}{contents.length === 0 && <p className="muted">No direct item records. Drop an inventory item onto this space to move it here.</p>}</div></>;
}

function Inventory({ state, commit }: { state: WorkspaceState; commit: Commit }) {
  const [query, setQuery] = useState("");
  const [locationFilter, setLocationFilter] = useState("");
  const [selected, setSelected] = useState<string[]>([]);
  const [editing, setEditing] = useState<string | null>(null);
  const locationName = useMemo(() => new Map(state.locations.map((location) => [location.id, `${location.code} · ${location.name}`])), [state.locations]);
  const shown = useMemo(() => state.items.filter((item) => !item.archivedAt && (!locationFilter || item.locationId === locationFilter) && [item.name, item.category, item.notes, ...item.tags, ...item.constraints.requiredTags].join(" ").toLowerCase().includes(query.toLowerCase())).sort((left, right) => (locationName.get(left.locationId) ?? "").localeCompare(locationName.get(right.locationId) ?? "") || left.order - right.order), [state, query, locationFilter, locationName]);
  const dropOnItem = (event: React.DragEvent, target: ItemRecord) => {
    event.preventDefault();
    const payload = readDrag(event);
    if (payload?.type !== "item") return;
    const source = state.items.find((item) => item.id === payload.id);
    if (!source || source.id === target.id) return;
    if (source.locationId !== target.locationId) {
      void perform(commit, { type: "item.move", id: source.id, destinationId: target.locationId, quantity: source.quantity });
      return;
    }
    const siblings = state.items.filter((item) => !item.archivedAt && item.locationId === target.locationId);
    const order = orderBefore(siblings, source.id, target.id);
    if (order !== null) void perform(commit, { type: "item.reorder", id: source.id, order });
  };
  return <div className="content"><div className="toolbar inventory-tools"><label className="search"><Search /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search names, categories, tags, constraints, and notes" /></label><select aria-label="Filter by location" value={locationFilter} onChange={(event) => setLocationFilter(event.target.value)}><option value="">All locations</option>{sortLocations(state.locations.filter((location) => !location.archivedAt)).map((location) => <option key={location.id} value={location.id}>{location.code} · {location.name}</option>)}</select><span>{shown.length} records</span></div><p className="drag-hint">Drag rows to reorder within a container. Drop an item onto a space in the Spaces view to move it; every drag action also has a touch-friendly control.</p><section className="panel inventory">{shown.map((item) => <div className="inventory-row" data-item-id={item.id} key={item.id} draggable onDragStart={(event) => writeDrag(event, { type: "item", id: item.id })} onDragOver={(event) => event.preventDefault()} onDrop={(event) => dropOnItem(event, item)}><GripVertical className="grip" /><input aria-label={`Select ${item.name}`} type="checkbox" checked={selected.includes(item.id)} onChange={() => setSelected((current) => current.includes(item.id) ? current.filter((id) => id !== item.id) : [...current, item.id])} /><button className="item-name" onClick={() => setEditing(item.id)}><strong>{item.name}</strong><small>{item.category} · {item.frequency} · {item.tags.join(", ") || "no tags"}</small></button><b>{item.quantity} {item.unit}</b><span>{locationName.get(item.locationId)}</span><button className="icon" aria-label={`Edit ${item.name}`} onClick={() => setEditing(item.id)}><Edit3 /></button></div>)}</section>{selected.length > 0 && <div className="floating"><b>{selected.length} selected</b><select aria-label="Move selected items" defaultValue="" onChange={(event) => { if (event.target.value) void perform(commit, { type: "item.bulkMove", itemIds: selected, destinationId: event.target.value }, () => setSelected([])); }}><option value="">Move to…</option>{state.locations.filter((location) => !location.archivedAt).map((location) => <option value={location.id} key={location.id}>{location.code} · {location.name}</option>)}</select></div>}{editing && state.items.find((item) => item.id === editing) && <ItemEditor item={state.items.find((item) => item.id === editing) as ItemRecord} state={state} commit={commit} close={() => setEditing(null)} />}</div>;
}

function ItemEditor({ item, state, commit, close }: { item: ItemRecord; state: WorkspaceState; commit: Commit; close: () => void }) {
  const [message, setMessage] = useState("");
  useEffect(() => { const escape = (event: KeyboardEvent) => { if (event.key === "Escape") close(); }; addEventListener("keydown", escape); return () => removeEventListener("keydown", escape); }, [close]);
  const save = async (data: FormData) => {
    const width = Number(data.get("width")), height = Number(data.get("height")), depth = Number(data.get("depth"));
    const dimensions = width > 0 && height > 0 && depth > 0 ? { width, height, depth, unit: String(data.get("dimensionUnit")) as "cm" | "in" } : null;
    try {
      await commit({ type: "item.update", id: item.id, changes: {
        name: String(data.get("name")), quantity: Number(data.get("quantity")), unit: String(data.get("unit")), category: String(data.get("category")), frequency: String(data.get("frequency")) as Frequency,
        tags: splitList(data.get("tags")), notes: String(data.get("notes")), dimensions,
        constraints: { avoidHumidity: data.get("avoidHumidity") === "on", avoidWarmth: data.get("avoidWarmth") === "on", foodOnly: data.get("foodOnly") === "on", keepTogether: String(data.get("keepTogether")).trim() || null, requiredTags: splitList(data.get("requiredTags")) },
      } });
      setMessage("Saved on this device.");
    } catch (error) { setMessage(error instanceof Error ? error.message : "Could not save item"); }
  };
  const move = async (data: FormData) => {
    try {
      await commit({ type: "item.move", id: item.id, destinationId: String(data.get("destination")), quantity: Number(data.get("moveQuantity")) });
      close();
    } catch (error) { setMessage(error instanceof Error ? error.message : "Could not move item"); }
  };
  return <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) close(); }}><section className="modal" role="dialog" aria-modal="true" aria-labelledby="item-editor-title"><header><div><p className="eyebrow">Item record</p><h2 id="item-editor-title">Edit {item.name}</h2></div><button className="icon" aria-label="Close item editor" onClick={close}><X /></button></header><form action={save} className="editor-form"><div className="form-grid"><label className="wide">Name<input autoFocus required name="name" defaultValue={item.name} /></label><label>Quantity<input required name="quantity" type="number" min="0.01" step="any" defaultValue={item.quantity} /></label><label>Unit<input required name="unit" defaultValue={item.unit} /></label><label>Category<input name="category" defaultValue={item.category} /></label><label>Use frequency<select name="frequency" defaultValue={item.frequency}>{frequencies.map((frequency) => <option key={frequency}>{frequency}</option>)}</select></label><label className="wide">Tags, comma-separated<input name="tags" defaultValue={item.tags.join(", ")} /></label><label className="wide">Notes<textarea name="notes" defaultValue={item.notes} /></label></div><fieldset><legend>Placement rules</legend><div className="check-grid"><label><input type="checkbox" name="foodOnly" defaultChecked={item.constraints.foodOnly} /> Food-safe only</label><label><input type="checkbox" name="avoidWarmth" defaultChecked={item.constraints.avoidWarmth} /> Avoid warmth</label><label><input type="checkbox" name="avoidHumidity" defaultChecked={item.constraints.avoidHumidity} /> Avoid humidity</label><label>Keep-together group<input name="keepTogether" defaultValue={item.constraints.keepTogether ?? ""} /></label><label>Required location tags<input name="requiredTags" defaultValue={item.constraints.requiredTags.join(", ")} /></label></div></fieldset><fieldset><legend>Dimensions per unit (optional)</legend><div className="dimension-grid"><label>W<input name="width" type="number" min="0" step="any" defaultValue={item.dimensions?.width} /></label><label>H<input name="height" type="number" min="0" step="any" defaultValue={item.dimensions?.height} /></label><label>D<input name="depth" type="number" min="0" step="any" defaultValue={item.dimensions?.depth} /></label><label>Unit<select name="dimensionUnit" defaultValue={item.dimensions?.unit ?? "in"}><option>in</option><option>cm</option></select></label></div></fieldset><button className="primary">Save changes</button></form><form action={move} className="move-form"><h3>Move all or part</h3><label>Move quantity<input name="moveQuantity" type="number" min="0.01" max={item.quantity} step="any" defaultValue={item.quantity} /></label><label>Destination<select required name="destination" defaultValue=""><option value="" disabled>Choose a space…</option>{sortLocations(state.locations.filter((location) => !location.archivedAt && location.id !== item.locationId)).map((location) => <option key={location.id} value={location.id}>{location.code} · {location.name}</option>)}</select></label><button>Move quantity</button></form><div className="destructive-row"><button className="danger" onClick={() => { if (confirm(`Delete ${item.name}? You can undo this from Activity.`)) void perform(commit, { type: "item.delete", id: item.id }, close); }}><Trash2 /> Delete item record</button></div>{message && <output className="form-message">{message}</output>}</section></div>;
}

function Planner({ state, commit }: { state: WorkspaceState; commit: Commit }) {
  const active = state.plans.find((plan) => plan.status === "active");
  const [weights, setWeights] = useState<PlanWeights>({ ...DEFAULT_PLAN_WEIGHTS });
  const [name, setName] = useState("Suggested reset");
  const [message, setMessage] = useState("");
  const generate = async () => {
    const plan = buildMovePlan(state, { name, weights });
    if (!plan.steps.length) { setMessage("No beneficial moves were found with these weights and the current measurements."); return; }
    try {
      if (active) await commit({ type: "plan.status", planId: active.id, status: "discarded" });
      await commit({ type: "plan.create", plan });
      setMessage(`${plan.steps.length} explainable move(s) added to the new plan.`);
    } catch (error) { setMessage(error instanceof Error ? error.message : "Could not create the plan"); }
  };
  const updateWeight = (key: keyof PlanWeights, value: number) => setWeights((current) => ({ ...current, [key]: value }));
  const complete = active?.steps.filter((step) => step.completedAt).length ?? 0;
  return <div className="content"><section className="panel hero planner-hero"><div><p className="eyebrow">Explainable recommendations</p><h2>Fewer moves, better homes.</h2><p>Balance suitability, access, grouping, capacity, and move cost—including moving a whole nested box when that is simpler.</p></div><details className="plan-settings"><summary>Plan priorities</summary><label>Plan name<input value={name} onChange={(event) => setName(event.target.value)} /></label>{(Object.keys(weights) as (keyof PlanWeights)[]).map((key) => <label key={key}><span>{key.replace(/([A-Z])/g, " $1")} <b>{weights[key]}</b></span><input aria-label={`${key} weight`} type="range" min="0" max="10" step="1" value={weights[key]} onChange={(event) => updateWeight(key, Number(event.target.value))} /></label>)}</details><div className="plan-actions"><button className="primary" onClick={() => void generate()}>{active ? "Replace with fresh plan" : "Generate move plan"}</button>{active && <button onClick={() => void perform(commit, { type: "plan.status", planId: active.id, status: "discarded" })}>Discard current plan</button>}</div>{message && <output className="form-message">{message}</output>}</section>{active ? <><div className="plan-progress"><strong>{active.name}</strong><span>{complete} of {active.steps.length} complete</span></div><section className="panel plan-list">{active.steps.map((step, index) => <div key={step.id} data-done={!!step.completedAt}><i>{index + 1}</i><span><strong>{step.type === "location" ? "Move container" : "Move item"}</strong><small>{step.explanation.join(" · ")}</small></span><b>{state.locations.find((location) => location.id === step.sourceId)?.code} → {state.locations.find((location) => location.id === step.destinationId)?.code}</b><button disabled={!!step.completedAt} onClick={() => void perform(commit, { type: "plan.step.complete", planId: active.id, stepId: step.id })}>{step.completedAt ? "Done" : "Complete"}</button></div>)}</section></> : <Empty title="No active plan" text="Generate one after your first-pass count is reasonably complete." />}</div>;
}
function History({ state, commit }: { state: WorkspaceState; commit: Commit }) {
  const [count, setCount] = useState(5);
  const applied = state.activities.filter((entry) => entry.status === "applied").length;
  const undone = state.activities.filter((entry) => entry.status === "undone").length;
  return <div className="content"><div className="toolbar"><span>{state.activities.length} recorded changes</span><div className="history-batch"><label>Changes<input aria-label="Batch history count" type="number" min="1" max="100" value={count} onChange={(event) => setCount(Math.max(1, Math.min(100, Number(event.target.value) || 1)))} /></label><button disabled={!applied} onClick={() => void perform(commit, { type: "history.batchUndo", count: Math.min(count, applied) })}>Undo {Math.min(count, applied)}</button><button disabled={!undone} onClick={() => void perform(commit, { type: "history.batchRedo", count: Math.min(count, undone) })}>Redo {Math.min(count, undone)}</button></div></div><section className="panel history">{[...state.activities].reverse().map((entry) => <div key={entry.id}><Undo2 /><span><strong>{entry.label}</strong><small>{new Date(entry.timestamp).toLocaleString()} · {entry.patches.length} fields</small></span><b>{entry.status}</b><button onClick={() => void perform(commit, entry.status === "applied" ? { type: "history.undo", activityId: entry.id } : { type: "history.reapply", activityId: entry.id })}>{entry.status === "applied" ? "Undo this" : "Reapply"}</button></div>)}{!state.activities.length && <Empty title="No changes yet" text="Every meaningful change will be inspectable and reversible here." />}</section></div>;
}
function Preferences({ state, theme, setTheme, openMenu, openWorkspace }: { state: WorkspaceState; theme: ThemePreference; setTheme: (theme: ThemePreference) => void; openMenu: () => void; openWorkspace: (workspaceId: string) => Promise<void> }) {
  const download = () => { const anchor = document.createElement("a"); const url = URL.createObjectURL(new Blob([JSON.stringify(state, null, 2)], { type: "application/json" })); anchor.href = url; anchor.download = `stowplan-${state.workspace.id}.json`; anchor.click(); URL.revokeObjectURL(url); };
  return <div className="content settings"><section className="panel"><h2>Workspace</h2><button onClick={openMenu}><Home /> Open main menu</button><h2>Appearance</h2><div className="segments">{(["system", "light", "dark"] as const).map((entry) => <button data-active={theme === entry} key={entry} onClick={() => setTheme(entry)}>{entry}</button>)}</div><WorkspaceSwitcher currentId={state.workspace.id} openWorkspace={openWorkspace} /><h2>Backup & recovery</h2><p className="muted">Export a complete portable snapshot. Imports are validated and previewed before replacement.</p><button onClick={download}>Export JSON backup</button><a href="/recovery">Review sync issues or restore a backup</a><a href="/labels">Print text and QR labels</a></section><section className="panel"><h2>Account & server backup</h2><a href={`/account?workspace=${encodeURIComponent(state.workspace.id)}`}>Sign in, sync, or create a guest link</a><a href="/admin">Open admin control plane</a><h2>Help & source</h2><a href="/docs/">Read the offline quick guide</a><a target="_blank" rel="noreferrer" href={process.env.NEXT_PUBLIC_REPOSITORY_URL || "https://github.com/j-256/stowplan"}>View source repository</a><p className="license">AGPL-3.0-only<br />Copyright © 2026 James Klein (j-256)</p></section></div>;
}
function WorkspaceSwitcher({ currentId, openWorkspace }: { currentId: string; openWorkspace: (workspaceId: string) => Promise<void> }) {
  const [workspaces, setWorkspaces] = useState<LocalWorkspaceSummary[]>([]);
  const [message, setMessage] = useState("");
  useEffect(() => { void listWorkspaceReplicas().then(setWorkspaces); }, [currentId]);
  if (workspaces.length < 2) return null;
  return <><h2>Workspaces on this device</h2><div className="workspace-list">{workspaces.map((workspace) => <button key={workspace.id} disabled={workspace.id === currentId} onClick={() => void openWorkspace(workspace.id).then(() => setMessage("")).catch((error) => setMessage(error instanceof Error ? error.message : "Could not switch workspace"))}><span><strong>{workspace.name}</strong><small>{workspace.pending ? `${workspace.pending} queued change(s)` : "No queued changes"}</small></span>{workspace.id === currentId ? <b>Current</b> : "Open"}</button>)}</div>{message && <output className="form-message">{message}</output>}</>;
}
function Empty({ title, text }: { title: string; text: string }) {
  return <div className="empty"><b>□</b><h3>{title}</h3><p>{text}</p></div>;
}
