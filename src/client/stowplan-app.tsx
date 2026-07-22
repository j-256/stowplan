"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  Activity,
  Archive,
  ArrowDown,
  ArrowUp,
  Boxes,
  ChevronDown,
  ChevronRight,
  ClipboardList,
  Edit3,
  GripVertical,
  Home,
  Info,
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
import { captureReorderOrder, nextCaptureLocation } from "./capture-order";
import { listWorkspaceReplicas, readWorkspaceReplica, type LocalWorkspaceSummary } from "./local-replica";
import { StowplanProvider, useStowplan } from "./store";

type View = "capture" | "spaces" | "inventory" | "plan" | "activity" | "settings";
type Commit = (command: Command) => Promise<void>;
type DragPayload = { id: string; type: "item" | "location" };
type DropIntent = "before" | "inside" | "after";
type DropTarget = { id: string | null; intent: DropIntent; kind: "item" | "location" | "root" };
type TreeEntry = { childCount: number; depth: number; location: Location };

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
const planPriorityHelp: Record<keyof PlanWeights, { label: string; description: string }> = {
  accessibility: {
    label: "Accessibility",
    description: "Score bonus = max(0, 5 − nesting depth) × frequency factor × this value × 0.25. Daily items use factor 4, weekly 3, monthly 2, and rarely used 1, so higher values pull frequently used items toward shallower spaces.",
  },
  capacity: {
    label: "Capacity",
    description: "For a measured space that fits, bonus = this value × min(3, 1 + remaining volume ÷ total volume). A measured space that is too small is always rejected, even when this is zero.",
  },
  grouping: {
    label: "Grouping",
    description: "Bonus = matching nearby records × this value, capped at four matches. A match shares either the item category or its keep-together group, so higher values consolidate related records more aggressively.",
  },
  moveCost: {
    label: "Move effort",
    description: "The score subtracts tree distance × this value, adds 3× this value for staying put, and requires an item move to improve by more than this value. Higher values also favor moving one filled container over moving its records separately.",
  },
  suitability: {
    label: "Suitability",
    description: "Every eligible space starts at 2× this value; satisfying food-safe adds 2×, avoiding warmth adds 1×, and avoiding humidity adds 1×. A space that violates a required rule is always rejected, even when this is zero.",
  },
};
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
function orderAfter<T extends { id: string; order: number }>(records: T[], sourceId: string, targetId: string): number | null {
  if (sourceId === targetId) return null;
  const sorted = [...records]
    .filter((record) => record.id !== sourceId)
    .sort((left, right) => left.order - right.order || left.id.localeCompare(right.id));
  const index = sorted.findIndex((record) => record.id === targetId);
  if (index < 0) return null;
  const target = sorted[index];
  const after = sorted[index + 1];
  return after ? (target.order + after.order) / 2 : target.order + 1;
}
function flattenLocationTree(locations: Location[]): TreeEntry[] {
  const entries: TreeEntry[] = [];
  const seen = new Set<string>();
  const visit = (parentId: string | null, depth: number) => {
    for (const location of sortLocations(locations.filter((candidate) => candidate.parentId === parentId))) {
      if (seen.has(location.id)) continue;
      seen.add(location.id);
      entries.push({ childCount: locations.filter((candidate) => candidate.parentId === location.id).length, depth, location });
      visit(location.id, depth + 1);
    }
  };
  visit(null, 0);
  for (const location of sortLocations(locations.filter((candidate) => !seen.has(candidate.id)))) {
    entries.push({ childCount: 0, depth: 0, location });
  }
  return entries;
}
function locationPath(locations: Location[], locationId: string): Location[] {
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
function dropTargetAt(clientX: number, clientY: number): DropTarget | null {
  const target = document.elementFromPoint(clientX, clientY)?.closest<HTMLElement>("[data-drop-target]");
  if (!target) return null;
  const kind = target.dataset.dropTarget as DropTarget["kind"];
  const id = target.dataset.dropId || null;
  if (kind === "root") return { id: null, intent: "inside", kind };
  if ((kind !== "item" && kind !== "location") || !id) return null;
  if (kind === "item") return { id, intent: "before", kind };
  const rectangle = target.getBoundingClientRect();
  const position = rectangle.height ? (clientY - rectangle.top) / rectangle.height : .5;
  return { id, intent: position < .28 ? "before" : position > .72 ? "after" : "inside", kind };
}
function TouchDragHandle({ label, onActiveChange, onDrop }: { label: string; onActiveChange?: (active: boolean) => void; onDrop: (target: DropTarget) => void }) {
  const active = useRef(false);
  const highlighted = useRef<HTMLElement | null>(null);
  const clear = () => {
    active.current = false;
    onActiveChange?.(false);
    highlighted.current?.removeAttribute("data-touch-drop-active");
    highlighted.current = null;
    document.documentElement.removeAttribute("data-touch-dragging");
  };
  const track = (clientX: number, clientY: number) => {
    if (clientY < 72) window.scrollBy({ top: -18, behavior: "auto" });
    else if (clientY > window.innerHeight - 92) window.scrollBy({ top: 18, behavior: "auto" });
    const target = document.elementFromPoint(clientX, clientY)?.closest<HTMLElement>("[data-drop-target]") ?? null;
    if (target === highlighted.current) return;
    highlighted.current?.removeAttribute("data-touch-drop-active");
    highlighted.current = target;
    target?.setAttribute("data-touch-drop-active", "true");
  };
  return <button type="button" className="drag-handle" aria-label={label} title={label}
    onPointerDown={(event) => { if (event.pointerType === "mouse") return; event.preventDefault(); active.current = true; onActiveChange?.(true); event.currentTarget.setPointerCapture(event.pointerId); document.documentElement.dataset.touchDragging = "true"; track(event.clientX, event.clientY); }}
    onPointerMove={(event) => { if (active.current) track(event.clientX, event.clientY); }}
    onPointerUp={(event) => { if (!active.current) return; const target = dropTargetAt(event.clientX, event.clientY); clear(); if (target) onDrop(target); }}
    onPointerCancel={clear}><GripVertical aria-hidden /></button>;
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
function formatTimestamp(value: string | null): string {
  if (!value) return "Never";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "Unknown" : date.toLocaleString([], { dateStyle: "medium", timeStyle: "short" });
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
  const { state, initialize, dispatch, lastSyncError, lastSyncedAt, openWorkspace, online, pending, blocked, removeWorkspace, replace, syncing } = useStowplan();
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
      setWorkspaceNotice("Shared workspace opened. Your previous local workspace is still available from the main menu.");
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
  const chooseWorkspace = async (workspaceId: string) => {
    await openWorkspace(workspaceId);
    const next = await readWorkspaceReplica(workspaceId);
    setSelected(next?.state.locations.find((location) => !location.archivedAt)?.id ?? null);
    setView("capture");
    setShowWelcome(false);
  };
  const removeLocalWorkspace = async (workspaceId: string) => {
    await removeWorkspace(workspaceId);
    setSelected(null);
  };
  const resetDemo = async () => {
    if (!confirm("Reset the kitchen demo? Every change and queued backup belonging to this demo will be discarded. Your other workspaces are not affected.")) return;
    const next = createDemoState(newId("ws_demo"));
    await replace(next);
    enter(next);
  };

  if (!state) {
    return <><Onboarding online={online} onOpenWorkspace={chooseWorkspace} onRemoveWorkspace={removeLocalWorkspace} onStart={start} />{workspaceNotice && <output className="workspace-notice onboarding-notice">{workspaceNotice}</output>}</>;
  }
  if (showWelcome) {
    return <Onboarding currentId={state.workspace.id} currentName={state.workspace.name} isDemo={state.workspace.id.startsWith("ws_demo")} online={online} onContinue={() => setShowWelcome(false)} onOpenDemo={openDemo} onOpenWorkspace={chooseWorkspace} onRemoveWorkspace={removeLocalWorkspace} onResetDemo={resetDemo} onStart={start} />;
  }
  const current = state.locations.find((location) => location.id === selected) ?? state.locations.find((location) => !location.archivedAt) ?? null;
  return <div className="app-shell">
    <aside>
      <Brand />
      <nav>{nav.map((entry) => <Nav key={entry.id} {...entry} active={entry.id === view} select={() => setView(entry.id)} />)}</nav>
      <div className="sync" title={lastSyncError ?? (lastSyncedAt ? `Last successful backup: ${formatTimestamp(lastSyncedAt)}` : "This workspace has not been backed up online yet.")}>{online ? <Wifi /> : <WifiOff />}<span>{blocked ? `${blocked} need review` : syncing ? "Backing up…" : pending ? `${pending} pending upload` : !online ? "Working offline" : lastSyncedAt ? `Backed up ${formatTimestamp(lastSyncedAt)}` : "Device only"}</span></div>
    </aside>
    <main>
      <header><div><p className="eyebrow">{state.workspace.name}</p><h1>{nav.find((entry) => entry.id === view)?.label}</h1></div><div className="header-actions"><button className="icon" aria-label="Open main menu" onClick={() => setShowWelcome(true)}><Home /></button><button className="icon mobile-settings" data-active={view === "settings"} aria-label="Open settings" onClick={() => setView("settings")}><Settings /></button><button className="icon" aria-label="Change theme" onClick={() => setTheme(theme === "system" ? "dark" : theme === "dark" ? "light" : "system")}>{theme === "dark" ? <Moon /> : <Sun />}</button></div></header>
      {view === "capture" && <Capture state={state} current={current} select={setSelected} commit={dispatch} />}
      {view === "spaces" && <Spaces state={state} current={current} select={setSelected} commit={dispatch} />}
      {view === "inventory" && <Inventory state={state} commit={dispatch} />}
      {view === "plan" && <Planner state={state} commit={dispatch} />}
      {view === "activity" && <History state={state} commit={dispatch} />}
      {workspaceNotice && <output className="workspace-notice">{workspaceNotice}</output>}
      {view === "settings" && <Preferences state={state} theme={theme} setTheme={setTheme} openMenu={() => setShowWelcome(true)} />}
    </main>
    <nav className="bottom">{nav.filter((entry) => entry.id !== "settings").map((entry) => <Nav key={entry.id} {...entry} active={entry.id === view} select={() => setView(entry.id)} />)}</nav>
  </div>;
}

function Brand() {
  return <div className="brand"><b>S</b><span><strong>Stowplan</strong><small>Know where everything lives</small></span></div>;
}
function Nav({ label, icon: Icon, active, select }: { label: string; icon: typeof Boxes; active: boolean; select: () => void }) {
  return <button className="nav" data-active={active} onClick={select}><Icon /><span>{label}</span></button>;
}
function Onboarding({ currentId, currentName, isDemo = false, online, onContinue, onOpenDemo, onOpenWorkspace, onRemoveWorkspace, onResetDemo, onStart }: {
  currentId?: string;
  currentName?: string;
  isDemo?: boolean;
  online: boolean;
  onContinue?: () => void;
  onOpenDemo?: () => Promise<void>;
  onOpenWorkspace: (workspaceId: string) => Promise<void>;
  onRemoveWorkspace: (workspaceId: string) => Promise<void>;
  onResetDemo?: () => Promise<void>;
  onStart: (demo: boolean) => Promise<void>;
}) {
  const [workspaces, setWorkspaces] = useState<LocalWorkspaceSummary[]>([]);
  const [message, setMessage] = useState("");
  useEffect(() => { void listWorkspaceReplicas().then(setWorkspaces); }, [currentId]);
  const open = async (workspaceId: string) => {
    try { await onOpenWorkspace(workspaceId); setMessage(""); }
    catch (error) { setMessage(error instanceof Error ? error.message : "Could not open workspace"); }
  };
  const remove = async (workspace: LocalWorkspaceSummary) => {
    const unsynced = workspace.pending + workspace.blocked;
    const backupWarning = workspace.lastSyncedAt
      ? `Its online backup from ${formatTimestamp(workspace.lastSyncedAt)} will remain on the server and can be opened again.`
      : "This workspace has never been backed up online, so removing it will permanently erase this device's only copy.";
    const changeWarning = unsynced ? ` ${unsynced} unsynced change${unsynced === 1 ? "" : "s"} will be lost.` : "";
    if (!confirm(`Remove “${workspace.name}” from this device?\n\n${backupWarning}${changeWarning}\n\nThis does not delete any server copy.`)) return;
    try {
      await onRemoveWorkspace(workspace.id);
      setWorkspaces(await listWorkspaceReplicas());
      setMessage(`${workspace.name} was removed from this device.`);
    } catch (error) { setMessage(error instanceof Error ? error.message : "Could not remove workspace"); }
  };

  if (!currentName && workspaces.length === 0) return <main className="onboarding"><section><Brand /><p className="eyebrow">A calmer first pass</p><h1>Label it. Count it.<br />Find it later.</h1><p>Start with one box, drawer, or cabinet. Stowplan remembers nested containers and keeps working without connectivity or a healthy server.</p><div className="steps"><span><b>1</b>Label a space</span><span><b>2</b>Add what is inside</span><span><b>3</b>Mark it counted</span></div><button className="primary" onClick={() => void onStart(false)}>Start my workspace</button><button className="linkish" onClick={() => void onStart(true)}>Explore the kitchen demo instead</button><small>Your inventory is saved on this device first.</small></section></main>;

  return <main className="onboarding workspace-home"><section><Brand /><div className="workspace-home-heading"><div><p className="eyebrow">Workspaces</p><h1>Where to next?</h1><p>Choose a local workspace and see exactly what has—or has not—reached the server.</p></div><span className="connectivity" data-online={online}>{online ? <Wifi /> : <WifiOff />}{online ? "Online" : "Offline"}</span></div><div className="workspace-cards">{workspaces.map((workspace) => {
    const current = workspace.id === currentId;
    const unsynced = workspace.pending + workspace.blocked;
    const status = workspace.blocked ? `${workspace.blocked} change${workspace.blocked === 1 ? "" : "s"} need review` : workspace.pending ? `${workspace.pending} change${workspace.pending === 1 ? "" : "s"} pending upload` : workspace.lastSyncedAt ? "Backed up online" : "Device only";
    const detail = workspace.lastSyncedAt ? `Last successful backup ${formatTimestamp(workspace.lastSyncedAt)}` : "Never backed up online";
    return <article className="workspace-card" data-current={current} key={workspace.id}><header><div><span>{current ? "Open now" : "On this device"}</span><h2>{workspace.name}</h2></div><b data-state={workspace.blocked ? "blocked" : workspace.pending ? "pending" : workspace.lastSyncedAt ? "synced" : "local"}>{status}</b></header><div className="workspace-dates"><span><small>Last local change</small><strong>{formatTimestamp(workspace.updatedAt)}</strong></span><span><small>Server backup</small><strong>{detail}</strong></span></div>{workspace.lastSyncError && <p className="workspace-sync-error">Latest backup check {formatTimestamp(workspace.lastSyncAttemptAt)}: {workspace.lastSyncError}</p>}{unsynced > 0 && <details className="workspace-queue"><summary>What is waiting ({unsynced})</summary><ol>{workspace.changes.slice(0, 6).map((change) => <li key={change.id}><span><strong>{change.label}</strong><small>{formatTimestamp(change.timestamp)}</small></span><b data-state={change.status}>{change.status === "blocked" ? "Needs review" : "Pending"}</b>{change.error && <small>{change.error}</small>}</li>)}</ol>{workspace.changes.length > 6 && <p>+ {workspace.changes.length - 6} more changes</p>}</details>}<footer><button className={current ? "primary" : ""} onClick={() => current ? onContinue?.() : void open(workspace.id)}>{current ? "Continue current workspace" : "Open workspace"}</button><button className="workspace-remove danger" aria-label={`Remove ${workspace.name} from this device`} onClick={() => void remove(workspace)}><Trash2 /><span>Remove</span></button></footer></article>;
  })}</div><div className="workspace-home-actions"><button onClick={() => void onStart(false)}>Start a new workspace</button>{isDemo ? <button className="danger menu-action" onClick={() => void onResetDemo?.()}><RotateCcw /> Reset kitchen demo</button> : <button className="linkish" onClick={() => void onOpenDemo?.()}>Open kitchen demo</button>}</div><small className="workspace-home-note">Removing a workspace here affects this device only. Online deletion is never implied.</small>{message && <output className="form-message">{message}</output>}</section></main>;
}

function Capture({ state, current, select, commit }: { state: WorkspaceState; current: Location | null; select: (id: string) => void; commit: Commit }) {
  const [editing, setEditing] = useState<string | null>(null);
  const [queueQuery, setQueueQuery] = useState("");
  const live = state.locations.filter((location) => !location.archivedAt);
  const tree = flattenLocationTree(live);
  const normalizedQuery = queueQuery.trim().toLocaleLowerCase();
  const visibleIds = new Set<string>();
  for (const entry of tree) {
    if (!normalizedQuery || [entry.location.code, entry.location.name, ...entry.location.tags].join(" ").toLocaleLowerCase().includes(normalizedQuery)) {
      for (const ancestor of locationPath(live, entry.location.id)) visibleIds.add(ancestor.id);
    }
  }
  const queueShown = tree.filter((entry) => visibleIds.has(entry.location.id));
  const done = live.filter((location) => ["counted", "known_empty"].includes(location.captureStatus)).length;
  const items = current ? sortItems(state.items.filter((item) => item.locationId === current.id && !item.archivedAt)) : [];
  const nested = current ? sortLocations(live.filter((location) => location.parentId === current.id)) : [];
  const breadcrumbs = current ? locationPath(live, current.id) : [];
  const addContainer = async (data: FormData) => {
    const parentId = data.get("topLevel") === "on" ? null : current?.id ?? null;
    const siblings = live.filter((location) => location.parentId === parentId);
    await perform(commit, { type: "location.create", location: createLocation({ code: String(data.get("code")), name: String(data.get("name")), kind: String(data.get("kind")) as LocationKind, parentId, order: nextOrder(siblings) }) });
  };
  const finish = async (status: CaptureStatus) => {
    if (!current) return;
    const next = nextCaptureLocation(tree, current.id);
    await perform(commit, { type: "capture.status", id: current.id, status }, () => { if (next) select(next.id); });
  };
  const reorderLocation = (location: Location, direction: -1 | 1) => {
    const siblings = live.filter((candidate) => candidate.parentId === location.parentId);
    const order = movedOrder(siblings, location.id, direction);
    if (order !== null) void perform(commit, { type: "location.reorder", id: location.id, order });
  };
  const reorderLocationByDrop = (payload: DragPayload | null, target: DropTarget) => {
    if (payload?.type !== "location" || target.kind !== "location" || !target.id || payload.id === target.id) return;
    const order = captureReorderOrder(live, payload.id, target.id, target.intent);
    if (order !== null) void perform(commit, { type: "location.reorder", id: payload.id, order });
  };
  const dropOnLocation = (event: React.DragEvent, targetId: string) => {
    event.preventDefault();
    const fallback = { id: targetId, intent: "inside", kind: "location" } satisfies DropTarget;
    reorderLocationByDrop(readDrag(event), dropTargetAt(event.clientX, event.clientY) ?? fallback);
  };
  const reorder = (id: string, direction: -1 | 1) => {
    const order = movedOrder(items, id, direction);
    if (order !== null) void perform(commit, { type: "item.reorder", id, order });
  };
  const reorderByDrop = (payload: DragPayload | null, targetId: string) => {
    if (payload?.type !== "item") return;
    const source = state.items.find((item) => item.id === payload.id);
    const target = state.items.find((item) => item.id === targetId);
    if (!source || !target || source.locationId !== target.locationId) return;
    const order = orderBefore(items, source.id, target.id);
    if (order !== null) void perform(commit, { type: "item.reorder", id: source.id, order });
  };
  const dropOnItem = (event: React.DragEvent, targetId: string) => {
    event.preventDefault();
    reorderByDrop(readDrag(event), targetId);
  };

  return <div className="content capture">
    <section className="panel queue"><div className="title"><div><p className="eyebrow">First-pass coverage</p><h2>{done} of {live.length} checked</h2></div><b>{live.length - done} left</b></div><div className="progress"><i style={{ width: `${live.length ? done / live.length * 100 : 0}%` }} /></div>{live.length > 5 && <label className="queue-search"><Search /><input aria-label="Find container" value={queueQuery} onChange={(event) => setQueueQuery(event.target.value)} placeholder="Jump by code or name" /></label>}<p className="capture-order-help">Drag or use the arrows to reorder within the same parent. Use Spaces to change nesting.</p><div className="capture-tree" role="tree" aria-label="Container hierarchy">{queueShown.map(({ childCount, depth, location }) => {
      const siblings = sortLocations(live.filter((candidate) => candidate.parentId === location.parentId));
      const index = siblings.findIndex((candidate) => candidate.id === location.id);
      const parent = location.parentId ? live.find((candidate) => candidate.id === location.parentId)?.name ?? "its parent" : "top level";
      return <div className="capture-location-row" role="treeitem" aria-level={depth + 1} aria-selected={current?.id === location.id} key={location.id} data-active={current?.id === location.id} data-depth={depth} data-location-id={location.id} data-drop-target="location" data-drop-id={location.id} draggable onDragStart={(event) => writeDrag(event, { type: "location", id: location.id })} onDragOver={(event) => { event.preventDefault(); event.dataTransfer.dropEffect = "move"; }} onDrop={(event) => dropOnLocation(event, location.id)}><TouchDragHandle label={`Drag ${location.name} to reorder within ${parent}`} onDrop={(target) => reorderLocationByDrop({ type: "location", id: location.id }, target)} /><button type="button" className="queue-row" aria-current={current?.id === location.id} data-active={current?.id === location.id} data-depth={depth} style={{ paddingLeft: 8 + depth * 12 }} onClick={() => select(location.id)}><span className="hierarchy-marker" aria-hidden>{depth ? "↳" : "●"}</span><span className="queue-name"><b>{location.code}</b><span>{location.name}</span></span><small>{childCount ? `${childCount} inside · ` : ""}{location.captureStatus.replace("_", " ")}</small></button><div className="row-actions"><button type="button" className="icon small" aria-label={`Move ${location.name} up`} disabled={index === 0} onClick={() => reorderLocation(location, -1)}><ArrowUp /></button><button type="button" className="icon small" aria-label={`Move ${location.name} down`} disabled={index === siblings.length - 1} onClick={() => reorderLocation(location, 1)}><ArrowDown /></button></div></div>;
    })}</div>{queueShown.length === 0 && <p className="muted queue-empty">No matching container.</p>}<form action={addContainer} className="nested"><div className="form-pair"><input required name="code" placeholder="Label code" /><select name="kind" aria-label="Container type" defaultValue={current ? "box" : "room"}>{kinds.map((kind) => <option key={kind}>{kind}</option>)}</select></div><input required name="name" placeholder={current ? "Nested box or bin" : "First room or area"} />{current && <label className="top-level"><input type="checkbox" name="topLevel" /> Add as another top-level space</label>}<button>{current ? `Add inside ${current.name}` : "Add first space"}</button></form></section>
    <section className="panel capture-card">{current ? <><nav className="breadcrumbs" aria-label="Current container path">{breadcrumbs.map((location, index) => <span key={location.id}>{index > 0 && <i aria-hidden>›</i>}<button onClick={() => select(location.id)}>{location.code}</button></span>)}</nav><div className="title"><div><p className="eyebrow">Inside this container</p><h2>{current.code} · {current.name}</h2></div><span className="tag">{current.captureStatus.replace("_", " ")}</span></div><form className="quick" action={async (data) => { const siblings = state.items.filter((item) => item.locationId === current.id && !item.archivedAt); await perform(commit, { type: "item.create", item: createItem({ locationId: current.id, name: String(data.get("name")), quantity: Number(data.get("quantity")), unit: String(data.get("unit")), order: nextOrder(siblings) }) }); }}><label>Qty<input required type="number" min="0.01" step="any" name="quantity" defaultValue="1" /></label><label>Unit<select name="unit"><option>each</option><option>boxes</option><option>bags</option><option>cans</option><option>pairs</option></select></label><label className="grow">What is it?<input required name="name" placeholder="e.g. winter gloves" /></label><button className="primary">Save & add next</button></form>
      {nested.length > 0 && <div className="nested-list"><small>Nested containers</small>{nested.map((location) => <button key={location.id} onClick={() => select(location.id)}><b>{location.code}</b><span>{location.name}</span><small>{location.captureStatus.replace("_", " ")}</small></button>)}</div>}
      <div className="captured">{items.map((item, index) => <div className="captured-row" data-item-id={item.id} data-drop-target="item" data-drop-id={item.id} key={item.id} draggable onDragStart={(event) => writeDrag(event, { type: "item", id: item.id })} onDragOver={(event) => event.preventDefault()} onDrop={(event) => dropOnItem(event, item.id)}><TouchDragHandle label={`Drag ${item.name} to reorder`} onDrop={(target) => { if (target.kind === "item" && target.id) reorderByDrop({ type: "item", id: item.id }, target.id); }} /><b>{item.quantity} {item.unit}</b><button className="item-name" onClick={() => setEditing(item.id)}><strong>{item.name}</strong><small>{item.category} · {item.frequency}</small></button><div className="row-actions"><button className="icon small" aria-label={`Move ${item.name} up`} disabled={index === 0} onClick={() => reorder(item.id, -1)}><ArrowUp /></button><button className="icon small" aria-label={`Move ${item.name} down`} disabled={index === items.length - 1} onClick={() => reorder(item.id, 1)}><ArrowDown /></button><button className="icon small" aria-label={`Edit ${item.name}`} onClick={() => setEditing(item.id)}><Edit3 /></button></div></div>)}{!items.length && <Empty title="Nothing recorded yet" text="Add an item, or mark this space as known empty." />}</div><div className="finish"><button onClick={() => void finish("known_empty")}>Known empty & next</button><button className="primary" onClick={() => void finish("counted")}>Mark counted & next</button></div></> : <Empty title="Add your first space" text="Give a room, cabinet, box, or drawer the same code as its physical label." />}</section>
    {editing && state.items.find((item) => item.id === editing) && <ItemEditor item={state.items.find((item) => item.id === editing) as ItemRecord} state={state} commit={commit} close={() => setEditing(null)} />}
  </div>;
}

function Spaces({ state, current, select, commit }: { state: WorkspaceState; current: Location | null; select: (id: string) => void; commit: Commit }) {
  const [editingItem, setEditingItem] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const [dropCue, setDropCue] = useState<DropTarget | null>(null);
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());
  const inspector = useRef<HTMLElement | null>(null);
  const live = state.locations.filter((location) => !location.archivedAt);
  const archived = state.locations.filter((location) => location.archivedAt);
  const chooseLocation = (id: string) => {
    select(id);
    if (matchMedia("(max-width: 760px)").matches) requestAnimationFrame(() => inspector.current?.scrollIntoView({ behavior: "smooth", block: "start" }));
  };
  const addRoot = async (data: FormData) => {
    const roots = live.filter((location) => location.parentId === null);
    const created = createLocation({ code: String(data.get("code")), name: String(data.get("name")), kind: String(data.get("kind")) as LocationKind, parentId: null, order: nextOrder(roots) });
    await perform(commit, { type: "location.create", location: created }, () => chooseLocation(created.id));
  };
  const moveByDrop = (payload: DragPayload | null, target: DropTarget) => {
    if (!payload) return;
    if (payload.type === "item" && target.kind === "location" && target.id) {
      const item = state.items.find((candidate) => candidate.id === payload.id);
      if (item && item.locationId !== target.id) void perform(commit, { type: "item.move", id: item.id, destinationId: target.id, quantity: item.quantity });
      return;
    }
    if (payload.type === "location") {
      const location = state.locations.find((candidate) => candidate.id === payload.id);
      if (!location) return;
      if (target.kind === "root") {
        const siblings = live.filter((candidate) => candidate.parentId === null && candidate.id !== location.id);
        void perform(commit, { type: "location.move", id: location.id, parentId: null, order: nextOrder(siblings) });
        return;
      }
      if (target.kind !== "location" || !target.id || location.id === target.id) return;
      const destination = state.locations.find((candidate) => candidate.id === target.id);
      if (!destination) return;
      if (target.intent === "inside") {
        const siblings = live.filter((candidate) => candidate.parentId === destination.id && candidate.id !== location.id);
        setCollapsed((current) => { const next = new Set(current); next.delete(destination.id); return next; });
        void perform(commit, { type: "location.move", id: location.id, parentId: destination.id, order: nextOrder(siblings) });
        return;
      }
      const siblings = live.filter((candidate) => candidate.parentId === destination.parentId);
      const order = target.intent === "before" ? orderBefore(siblings, location.id, destination.id) : orderAfter(siblings, location.id, destination.id);
      if (order !== null) void perform(commit, { type: "location.move", id: location.id, parentId: destination.parentId, order });
    }
  };
  const dragOver = (event: React.DragEvent, fallback: DropTarget) => {
    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
    setDropCue(dropTargetAt(event.clientX, event.clientY) ?? fallback);
  };
  const drop = (event: React.DragEvent, fallback: DropTarget) => {
    event.preventDefault();
    event.stopPropagation();
    const target = dropTargetAt(event.clientX, event.clientY) ?? fallback;
    moveByDrop(readDrag(event), target);
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
  const branch = (parentId: string | null, depth = 0): React.ReactNode => sortLocations(live.filter((location) => location.parentId === parentId)).map((location) => {
    const siblings = sortLocations(live.filter((candidate) => candidate.parentId === location.parentId));
    const index = siblings.findIndex((candidate) => candidate.id === location.id);
    const children = live.filter((candidate) => candidate.parentId === location.id);
    const itemCount = state.items.filter((item) => item.locationId === location.id && !item.archivedAt).length;
    const cue = dropCue?.kind === "location" && dropCue.id === location.id ? dropCue.intent : undefined;
    const isCollapsed = collapsed.has(location.id);
    return <div className="tree-node" role="treeitem" aria-level={depth + 1} aria-selected={current?.id === location.id} aria-expanded={children.length ? !isCollapsed : undefined} key={location.id}><div className="tree-row" data-location-id={location.id} data-drop-target="location" data-drop-id={location.id} data-drop-intent={cue} data-active={current?.id === location.id} draggable onDragStart={(event) => { event.stopPropagation(); setDragging(true); writeDrag(event, { type: "location", id: location.id }); }} onDragEnd={() => { setDragging(false); setDropCue(null); }} onDragOver={(event) => dragOver(event, { id: location.id, intent: "inside", kind: "location" })} onDrop={(event) => drop(event, { id: location.id, intent: "inside", kind: "location" })}><TouchDragHandle label={`Drag ${location.name} to move or nest it`} onActiveChange={setDragging} onDrop={(target) => finishTouchDrop({ type: "location", id: location.id }, target)} />{children.length ? <button className="tree-toggle" aria-label={`${isCollapsed ? "Expand" : "Collapse"} ${location.name}`} onClick={() => setCollapsed((current) => { const next = new Set(current); if (next.has(location.id)) next.delete(location.id); else next.add(location.id); return next; })}>{isCollapsed ? <ChevronRight /> : <ChevronDown />}</button> : <span className="tree-toggle-spacer" />}<button className="tree-select" onClick={() => chooseLocation(location.id)}><span className="tree-code"><b>{location.code}</b><i>{location.kind}</i></span><span className="tree-name">{location.name}<small>{children.length} nested · {itemCount} items</small></span></button><span className="drop-copy" aria-hidden>{cue === "before" ? "Place before" : cue === "after" ? "Place after" : "Move inside"}</span><div className="row-actions"><button className="icon small" aria-label={`Move ${location.name} up`} disabled={index === 0} onClick={() => reorderLocation(location, -1)}><ArrowUp /></button><button className="icon small" aria-label={`Move ${location.name} down`} disabled={index === siblings.length - 1} onClick={() => reorderLocation(location, 1)}><ArrowDown /></button></div></div>{children.length > 0 && !isCollapsed && <div className="tree-children" role="group">{branch(location.id, depth + 1)}</div>}</div>;
  });
  const removeLocation = (location: Location) => {
    const descendants = descendantIds(state, location.id);
    const locationIds = [location.id, ...descendants];
    const itemIds = state.items.filter((item) => locationIds.includes(item.locationId)).map((item) => item.id);
    if (confirm(`Permanently delete ${location.name}, ${descendants.length} nested space(s), and ${itemIds.length} item record(s)? You can still undo this from Activity.`)) {
      void perform(commit, { type: "location.delete", id: location.id, descendantIds: descendants, itemIds }, () => select(live.find((candidate) => !locationIds.includes(candidate.id))?.id ?? ""));
    }
  };

  return <div className="content split"><section className="panel tree-panel" data-dragging={dragging}><div className="title"><div><p className="eyebrow">Your physical hierarchy</p><h2>Rooms → cabinets → boxes</h2></div></div><p className="tree-help">Drag a handle onto the top, middle, or bottom of another row to place before, move inside, or place after. On touch, press the handle, slide, and release.</p><details className="tree-add"><summary>Add a top-level room or area</summary><form action={addRoot}><div className="form-pair"><input required name="code" placeholder="Label code" /><select name="kind" defaultValue="room">{kinds.map((kind) => <option key={kind}>{kind}</option>)}</select></div><input required name="name" placeholder="Name" /><button>Add top-level space</button></form></details><div className="root-drop" data-drop-target="root" data-drop-intent={dropCue?.kind === "root" ? "inside" : undefined} onDragOver={(event) => dragOver(event, { id: null, intent: "inside", kind: "root" })} onDrop={(event) => drop(event, { id: null, intent: "inside", kind: "root" })}>Drop here to make a top-level room or area</div><div className="location-tree" role="tree" aria-label="Space hierarchy">{branch(null)}</div>{current && <button className="mobile-edit-space primary" onClick={() => inspector.current?.scrollIntoView({ behavior: "smooth", block: "start" })}>Edit {current.name}</button>}{archived.length > 0 && <details className="archived"><summary>{archived.length} archived</summary>{archived.map((location) => <div key={location.id}><span>{location.code} · {location.name}</span><button onClick={() => void perform(commit, { type: "location.archive", id: location.id, archived: false })}>Restore</button></div>)}</details>}</section><section className="panel inspector" id="space-inspector" ref={inspector} tabIndex={-1}>{current ? <LocationEditor key={current.id} state={state} location={current} commit={commit} select={select} reorder={reorderLocation} remove={() => removeLocation(current)} editItem={setEditingItem} moveByDrop={finishTouchDrop} setDragging={setDragging} /> : <Empty title="Select a space" text="Edit it, move it, or drop an item or container onto it." />}</section>{editingItem && state.items.find((item) => item.id === editingItem) && <ItemEditor item={state.items.find((item) => item.id === editingItem) as ItemRecord} state={state} commit={commit} close={() => setEditingItem(null)} />}</div>;
}

function LocationEditor({ state, location, commit, select, reorder, remove, editItem, moveByDrop, setDragging }: { state: WorkspaceState; location: Location; commit: Commit; select: (id: string) => void; reorder: (location: Location, direction: -1 | 1) => void; remove: () => void; editItem: (id: string) => void; moveByDrop: (payload: DragPayload, target: DropTarget) => void; setDragging: (dragging: boolean) => void }) {
  const invalidParents = new Set([location.id, ...descendantIds(state, location.id)]);
  const contents = sortItems(state.items.filter((item) => item.locationId === location.id && !item.archivedAt));
  const parentOptions = flattenLocationTree(state.locations.filter((candidate) => !candidate.archivedAt && !invalidParents.has(candidate.id)));
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
  return <><form action={save} className="editor-form"><div className="title"><div><p className="eyebrow">{location.kind}</p><h2>Edit space</h2></div><span className="tag">{location.captureStatus.replace("_", " ")}</span></div><div className="form-grid"><label>Name<input required name="name" defaultValue={location.name} /></label><label>Label code<input required name="code" defaultValue={location.code} /></label><label>Type<select name="kind" defaultValue={location.kind}>{kinds.map((kind) => <option key={kind}>{kind}</option>)}</select></label><label>Inside<select name="parentId" defaultValue={location.parentId ?? ""}><option value="">Top level</option>{parentOptions.map(({ depth, location: candidate }) => <option key={candidate.id} value={candidate.id}>{`${"  ".repeat(depth)}${depth ? "↳ " : ""}${candidate.code} · ${candidate.name}`}</option>)}</select></label><label className="wide">Tags, comma-separated<input name="tags" defaultValue={location.tags.join(", ")} /></label><label className="wide">Description<textarea name="description" defaultValue={location.description} /></label></div><fieldset><legend>Suitability</legend><div className="check-grid"><label><input type="checkbox" name="foodSafe" defaultChecked={location.conditions.foodSafe} /> Food safe</label><label><input type="checkbox" name="dry" defaultChecked={location.conditions.dry} /> Dry</label><label><input type="checkbox" name="dark" defaultChecked={location.conditions.dark} /> Dark</label><label>Temperature<select name="temperature" defaultValue={location.conditions.temperature}><option>cold</option><option>cool</option><option>normal</option><option>warm</option></select></label><label>Humidity<select name="humidity" defaultValue={location.conditions.humidity}><option>dry</option><option>normal</option><option>humid</option></select></label></div></fieldset><fieldset><legend>Interior dimensions (optional)</legend><div className="dimension-grid"><label>W<input name="width" type="number" min="0" step="any" defaultValue={location.dimensions?.width} /></label><label>H<input name="height" type="number" min="0" step="any" defaultValue={location.dimensions?.height} /></label><label>D<input name="depth" type="number" min="0" step="any" defaultValue={location.dimensions?.depth} /></label><label>Unit<select name="dimensionUnit" defaultValue={location.dimensions?.unit ?? "in"}><option>in</option><option>cm</option></select></label></div></fieldset><button className="primary">Save space</button></form><div className="inspector-actions"><button onClick={() => reorder(location, -1)}><ArrowUp /> Earlier</button><button onClick={() => reorder(location, 1)}><ArrowDown /> Later</button><button onClick={() => void perform(commit, { type: "location.archive", id: location.id, archived: true }, () => select(state.locations.find((candidate) => !candidate.archivedAt && candidate.id !== location.id)?.id ?? ""))}><Archive /> Archive</button><button className="danger" onClick={remove}><Trash2 /> Delete subtree</button></div><form className="nested inline-add" action={async (data) => { const children = state.locations.filter((candidate) => candidate.parentId === location.id && !candidate.archivedAt); const child = createLocation({ code: String(data.get("code")), name: String(data.get("name")), kind: String(data.get("kind")) as LocationKind, parentId: location.id, order: nextOrder(children) }); await perform(commit, { type: "location.create", location: child }); }}><h3>Add inside {location.name}</h3><div className="form-pair"><input required name="code" placeholder="Code" /><select name="kind" defaultValue="box">{kinds.map((kind) => <option key={kind}>{kind}</option>)}</select></div><input required name="name" placeholder="Name" /><button>Add nested space</button></form><div className="location-contents"><h3>Direct contents <small>{contents.length} records</small></h3>{contents.map((item) => <div className="location-item-row" key={item.id} draggable onDragStart={(event) => { setDragging(true); writeDrag(event, { type: "item", id: item.id }); }} onDragEnd={() => setDragging(false)}><TouchDragHandle label={`Drag ${item.name} into another space`} onActiveChange={setDragging} onDrop={(target) => moveByDrop({ type: "item", id: item.id }, target)} /><button className="item-name" onClick={() => editItem(item.id)}><strong>{item.name}</strong><small>{item.quantity} {item.unit}</small></button><button className="icon small" aria-label={`Edit ${item.name}`} onClick={() => editItem(item.id)}><Edit3 /></button></div>)}{contents.length === 0 && <p className="muted">No direct item records. Drop an inventory item onto this space to move it here.</p>}</div></>;
}

function Inventory({ state, commit }: { state: WorkspaceState; commit: Commit }) {
  const [query, setQuery] = useState("");
  const [locationFilter, setLocationFilter] = useState("");
  const [sortBy, setSortBy] = useState<"location" | "name" | "quantity">("name");
  const [selected, setSelected] = useState<string[]>([]);
  const [editing, setEditing] = useState<string | null>(null);
  const locationName = useMemo(() => new Map(state.locations.map((location) => [location.id, locationPath(state.locations, location.id).map((part) => part.name).join(" › ")])), [state.locations]);
  const locationOptions = flattenLocationTree(state.locations.filter((location) => !location.archivedAt));
  const shown = useMemo(() => state.items.filter((item) => !item.archivedAt && (!locationFilter || item.locationId === locationFilter) && [item.name, item.category, item.notes, ...item.tags, ...item.constraints.requiredTags].join(" ").toLowerCase().includes(query.toLowerCase())).sort((left, right) => {
    if (locationFilter) return left.order - right.order || left.name.localeCompare(right.name);
    if (sortBy === "quantity") return right.quantity - left.quantity || left.name.localeCompare(right.name);
    if (sortBy === "location") return (locationName.get(left.locationId) ?? "").localeCompare(locationName.get(right.locationId) ?? "") || left.name.localeCompare(right.name);
    return left.name.localeCompare(right.name);
  }), [state, query, locationFilter, locationName, sortBy]);
  const canReorder = Boolean(locationFilter);
  const selectedItems = state.items.filter((item) => selected.includes(item.id));
  const moveItemByDrop = (payload: DragPayload | null, target: ItemRecord) => {
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
  const dropOnItem = (event: React.DragEvent, target: ItemRecord) => { if (!canReorder) return; event.preventDefault(); moveItemByDrop(readDrag(event), target); };
  return <div className="content inventory-page"><div className="inventory-heading"><div><p className="eyebrow">Everything, regardless of container</p><h2>All item records</h2><p>Search the whole workspace, then select records for an explicit move. Filter to one container only when physical order matters.</p></div><b>{shown.length} records</b></div><div className="toolbar inventory-tools"><label className="search"><Search /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search names, categories, tags, constraints, and notes" /></label><select aria-label="Filter by location" value={locationFilter} onChange={(event) => setLocationFilter(event.target.value)}><option value="">Every container</option>{locationOptions.map(({ depth, location }) => <option key={location.id} value={location.id}>{`${"  ".repeat(depth)}${depth ? "↳ " : ""}${location.code} · ${location.name}`}</option>)}</select><select aria-label="Sort inventory" value={sortBy} onChange={(event) => setSortBy(event.target.value as typeof sortBy)} disabled={canReorder}><option value="name">Sort: name</option><option value="location">Sort: location</option><option value="quantity">Sort: quantity</option></select></div><p className="drag-hint">{canReorder ? `Showing one container. Drag handles reorder ${shown.length} records here; use Edit / move to change containers.` : "Showing the containerless inventory. Select one or more records to move them, or use Edit / move for details and partial quantities."}</p><section className="panel inventory">{shown.map((item) => <div className="inventory-row" data-item-id={item.id} data-drop-target={canReorder ? "item" : undefined} data-drop-id={canReorder ? item.id : undefined} key={item.id} draggable={canReorder} onDragStart={canReorder ? (event) => writeDrag(event, { type: "item", id: item.id }) : undefined} onDragOver={canReorder ? (event) => event.preventDefault() : undefined} onDrop={canReorder ? (event) => dropOnItem(event, item) : undefined}>{canReorder ? <TouchDragHandle label={`Drag ${item.name} to reorder`} onDrop={(target) => { if (target.kind === "item" && target.id) { const destination = state.items.find((candidate) => candidate.id === target.id); if (destination) moveItemByDrop({ type: "item", id: item.id }, destination); } }} /> : <span className="inventory-marker" aria-hidden>•</span>}<input aria-label={`Select ${item.name} in ${locationName.get(item.locationId) ?? "Unknown space"}`} type="checkbox" checked={selected.includes(item.id)} onChange={() => setSelected((current) => current.includes(item.id) ? current.filter((id) => id !== item.id) : [...current, item.id])} /><button className="item-name" aria-label={`Open ${item.name} in ${locationName.get(item.locationId) ?? "Unknown space"}`} onClick={() => setEditing(item.id)}><strong>{item.name}</strong><small>{item.category} · {item.frequency} · {item.tags.join(", ") || "no tags"}</small></button><b>{item.quantity} {item.unit}</b><span className="location-path">{locationName.get(item.locationId)}</span><button className="row-action" aria-label={`Edit or move ${item.name} in ${locationName.get(item.locationId) ?? "Unknown space"}`} onClick={() => setEditing(item.id)}><Edit3 /><span>Edit / move</span></button></div>)}{shown.length === 0 && <Empty title="No matching records" text="Clear a filter or capture something new." />}</section>{selected.length > 0 && <div className="floating"><b>{selected.length} selected</b><select aria-label="Move selected items" defaultValue="" onChange={(event) => { if (event.target.value) void perform(commit, { type: "item.bulkMove", itemIds: selected, destinationId: event.target.value }, () => setSelected([])); }}><option value="">Move to…</option>{locationOptions.map(({ depth, location }) => <option disabled={selectedItems.length > 0 && selectedItems.every((item) => item.locationId === location.id)} value={location.id} key={location.id}>{`${"  ".repeat(depth)}${depth ? "↳ " : ""}${location.code} · ${location.name}`}</option>)}</select><button onClick={() => setSelected([])}>Clear</button></div>}{editing && state.items.find((item) => item.id === editing) && <ItemEditor item={state.items.find((item) => item.id === editing) as ItemRecord} state={state} commit={commit} close={() => setEditing(null)} />}</div>;
}

function ItemEditor({ item, state, commit, close }: { item: ItemRecord; state: WorkspaceState; commit: Commit; close: () => void }) {
  const [message, setMessage] = useState("");
  const destinationOptions = flattenLocationTree(state.locations.filter((location) => !location.archivedAt && location.id !== item.locationId));
  const currentLocation = locationPath(state.locations, item.locationId);
  const currentLocationLabel = currentLocation.length ? currentLocation.map((location) => location.name).join(" › ") : "Unplaced";
  const hasPlacementRules = item.constraints.foodOnly || item.constraints.avoidWarmth || item.constraints.avoidHumidity || Boolean(item.constraints.keepTogether) || item.constraints.requiredTags.length > 0;
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
  return <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) close(); }}><section className="modal item-editor-modal" role="dialog" aria-modal="true" aria-labelledby="item-editor-title"><header className="item-editor-header"><div><p className="eyebrow">Item details</p><h2 id="item-editor-title">Edit item</h2><p>{item.name}</p></div><button className="icon" aria-label="Close item editor" onClick={close}><X /></button></header><div className="item-editor-context" aria-label="Current item summary"><span><small>Amount</small><strong>{item.quantity} {item.unit}</strong></span><span><small>Stored in</small><strong>{currentLocationLabel}</strong></span></div><div className="item-editor-layout"><form action={save} className="item-editor-form"><section className="item-section item-essential"><div className="item-section-heading"><b>1</b><span><strong>What is it?</strong><small>The everyday details you will use most.</small></span></div><div className="item-core-grid"><label className="item-name-field">Item name<input autoFocus required name="name" defaultValue={item.name} /></label><label>Quantity<input required name="quantity" type="number" min="0.01" step="any" defaultValue={item.quantity} /></label><label>Unit<input required name="unit" defaultValue={item.unit} /></label></div></section><section className="item-section"><div className="item-section-heading"><b>2</b><span><strong>Organize and find it</strong><small>Structured labels keep search useful without becoming free-form chaos.</small></span></div><div className="item-organize-grid"><label>Category<input name="category" defaultValue={item.category} placeholder="e.g. Baking" /></label><label>How often is it used?<select name="frequency" defaultValue={item.frequency}>{frequencies.map((frequency) => <option key={frequency}>{frequency}</option>)}</select></label><label className="wide">Search tags<input name="tags" defaultValue={item.tags.join(", ")} placeholder="washable, seasonal, breakfast" /><small>Separate tags with commas.</small></label><label className="wide">Notes<textarea name="notes" defaultValue={item.notes} placeholder="Anything useful that does not belong in a structured field." /></label></div></section><details className="item-advanced" open={hasPlacementRules}><summary><span><strong>Placement requirements</strong><small>Only add rules that affect where this item can safely live.</small></span><b>{hasPlacementRules ? "Configured" : "Optional"}</b></summary><div className="item-advanced-body"><div className="constraint-grid"><label><input type="checkbox" name="foodOnly" defaultChecked={item.constraints.foodOnly} /><span><strong>Food-safe only</strong><small>Keep it out of unsuitable spaces.</small></span></label><label><input type="checkbox" name="avoidWarmth" defaultChecked={item.constraints.avoidWarmth} /><span><strong>Avoid warmth</strong><small>Exclude warm cabinets or zones.</small></span></label><label><input type="checkbox" name="avoidHumidity" defaultChecked={item.constraints.avoidHumidity} /><span><strong>Avoid humidity</strong><small>Prefer dry storage.</small></span></label></div><div className="item-organize-grid"><label>Keep-together group<input name="keepTogether" defaultValue={item.constraints.keepTogether ?? ""} placeholder="e.g. Coffee station" /></label><label>Required location tags<input name="requiredTags" defaultValue={item.constraints.requiredTags.join(", ")} placeholder="cool, dark" /></label></div></div></details><details className="item-advanced" open={Boolean(item.dimensions)}><summary><span><strong>Size per unit</strong><small>Useful when Stowplan needs to reason about capacity.</small></span><b>{item.dimensions ? "Measured" : "Optional"}</b></summary><div className="item-advanced-body"><div className="dimension-grid"><label>Width<input name="width" type="number" min="0" step="any" defaultValue={item.dimensions?.width} /></label><label>Height<input name="height" type="number" min="0" step="any" defaultValue={item.dimensions?.height} /></label><label>Depth<input name="depth" type="number" min="0" step="any" defaultValue={item.dimensions?.depth} /></label><label>Unit<select name="dimensionUnit" defaultValue={item.dimensions?.unit ?? "in"}><option>in</option><option>cm</option></select></label></div></div></details><footer className="item-save-bar"><span><strong>Changes stay on this device first.</strong><small>Server backup follows when available.</small></span><button className="primary">Save item</button></footer></form><aside className="item-editor-rail"><form action={move} className="move-card"><p className="eyebrow">Placement</p><h3>Move all or part</h3><p>Currently in <strong>{currentLocationLabel}</strong>.</p><label>How many?<input name="moveQuantity" type="number" min="0.01" max={item.quantity} step="any" defaultValue={item.quantity} /></label><label>Move to<select required name="destination" defaultValue=""><option value="" disabled>Choose a space…</option>{destinationOptions.map(({ depth, location }) => <option key={location.id} value={location.id}>{`${"  ".repeat(depth)}${depth ? "↳ " : ""}${location.code} · ${location.name}`}</option>)}</select></label><button>Move quantity</button><small>Moving fewer than {item.quantity} creates a separate record at the destination.</small></form><details className="item-danger"><summary>More actions</summary><button type="button" className="danger" onClick={() => { if (confirm(`Delete ${item.name}? You can undo this from Activity.`)) void perform(commit, { type: "item.delete", id: item.id }, close); }}><Trash2 /> Delete item record</button><small>Deletion is recorded in Activity and can be undone.</small></details></aside></div>{message && <output className="form-message item-editor-message">{message}</output>}</section></div>;
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
  return <div className="content">
    <section className="panel hero planner-hero">
      <div>
        <p className="eyebrow">Explainable recommendations</p>
        <h2>Fewer moves, better homes.</h2>
        <p>Balance suitability, access, grouping, capacity, and move effort—including moving a whole nested box when that is simpler.</p>
      </div>
      <details className="plan-settings">
        <summary>Plan priorities</summary>
        <label>Plan name<input value={name} onChange={(event) => setName(event.target.value)} /></label>
        {(Object.keys(weights) as (keyof PlanWeights)[]).map((key) => {
          const help = planPriorityHelp[key];
          const tooltipId = `priority-${key}-help`;
          return <div className="plan-priority" key={key}>
            <div className="plan-priority-label">
              <label htmlFor={`priority-${key}`}>{help.label}</label>
              <span className="info-tip">
                <button type="button" aria-label={`How ${help.label.toLowerCase()} affects a plan`} aria-describedby={tooltipId}><Info /></button>
                <span id={tooltipId} role="tooltip">{help.description}</span>
              </span>
              <output htmlFor={`priority-${key}`}>{weights[key]}</output>
            </div>
            <input id={`priority-${key}`} aria-label={`${help.label} weight`} type="range" min="0" max="10" step="1" value={weights[key]} onChange={(event) => updateWeight(key, Number(event.target.value))} />
          </div>;
        })}
      </details>
      <div className="plan-actions">
        <button className="primary" onClick={() => void generate()}>{active ? "Replace with fresh plan" : "Generate move plan"}</button>
        {active && <button onClick={() => void perform(commit, { type: "plan.status", planId: active.id, status: "discarded" })}>Discard current plan</button>}
      </div>
      {message && <output className="form-message">{message}</output>}
    </section>
    {active ? <>
      <div className="plan-progress"><strong>{active.name}</strong><span>{complete} of {active.steps.length} complete</span></div>
      <section className="panel plan-list">{active.steps.map((step, index) => <div key={step.id} data-done={!!step.completedAt}><i>{index + 1}</i><span><strong>{step.type === "location" ? "Move container" : "Move item"}</strong><small>{step.explanation.join(" · ")}</small></span><b>{state.locations.find((location) => location.id === step.sourceId)?.code} → {state.locations.find((location) => location.id === step.destinationId)?.code}</b><button disabled={!!step.completedAt} onClick={() => void perform(commit, { type: "plan.step.complete", planId: active.id, stepId: step.id })}>{step.completedAt ? "Done" : "Complete"}</button></div>)}</section>
    </> : <Empty title="No active plan" text="Generate one after your first-pass count is reasonably complete." />}
  </div>;
}
function History({ state, commit }: { state: WorkspaceState; commit: Commit }) {
  const [count, setCount] = useState(5);
  const applied = state.activities.filter((entry) => entry.status === "applied").length;
  const undone = state.activities.filter((entry) => entry.status === "undone").length;
  return <div className="content"><div className="toolbar"><span>{state.activities.length} recorded changes</span><div className="history-batch"><label>Changes<input aria-label="Batch history count" type="number" min="1" max="100" value={count} onChange={(event) => setCount(Math.max(1, Math.min(100, Number(event.target.value) || 1)))} /></label><button disabled={!applied} onClick={() => void perform(commit, { type: "history.batchUndo", count: Math.min(count, applied) })}>Undo {Math.min(count, applied)}</button><button disabled={!undone} onClick={() => void perform(commit, { type: "history.batchRedo", count: Math.min(count, undone) })}>Redo {Math.min(count, undone)}</button></div></div><section className="panel history">{[...state.activities].reverse().map((entry) => <div key={entry.id}><Undo2 /><span><strong>{entry.label}</strong><small>{new Date(entry.timestamp).toLocaleString()} · {entry.patches.length} fields</small></span><b>{entry.status}</b><button onClick={() => void perform(commit, entry.status === "applied" ? { type: "history.undo", activityId: entry.id } : { type: "history.reapply", activityId: entry.id })}>{entry.status === "applied" ? "Undo this" : "Reapply"}</button></div>)}{!state.activities.length && <Empty title="No changes yet" text="Every meaningful change will be inspectable and reversible here." />}</section></div>;
}
function Preferences({ state, theme, setTheme, openMenu }: { state: WorkspaceState; theme: ThemePreference; setTheme: (theme: ThemePreference) => void; openMenu: () => void }) {
  const download = () => { const anchor = document.createElement("a"); const url = URL.createObjectURL(new Blob([JSON.stringify(state, null, 2)], { type: "application/json" })); anchor.href = url; anchor.download = `stowplan-${state.workspace.id}.json`; anchor.click(); URL.revokeObjectURL(url); };
  return <div className="content settings"><section className="panel"><h2>Workspace</h2><p className="muted">Switch, inspect backup status, or remove device copies from the main menu.</p><button onClick={openMenu}><Home /> Open workspace menu</button><h2>Appearance</h2><div className="segments">{(["system", "light", "dark"] as const).map((entry) => <button data-active={theme === entry} key={entry} onClick={() => setTheme(entry)}>{entry}</button>)}</div><h2>Backup & recovery</h2><p className="muted">Export a complete portable snapshot. Imports are validated and previewed before replacement.</p><button onClick={download}>Export JSON backup</button><a href="/recovery">Review sync issues or restore a backup</a><a href="/labels">Print text and QR labels</a></section><section className="panel"><h2>Account & server backup</h2><a href={`/account?workspace=${encodeURIComponent(state.workspace.id)}`}>Sign in, sync, or create a guest link</a><a href="/admin">Open admin control plane</a><h2>Help & source</h2><a href="/docs/">Read the offline quick guide</a><a target="_blank" rel="noreferrer" href={process.env.NEXT_PUBLIC_REPOSITORY_URL || "https://github.com/j-256/stowplan"}>View source repository</a><p className="license">AGPL-3.0-only<br />Copyright © 2026 James Klein (j-256)</p></section></div>;
}
function Empty({ title, text }: { title: string; text: string }) {
  return <div className="empty"><b>□</b><h3>{title}</h3><p>{text}</p></div>;
}
