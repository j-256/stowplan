"use client";

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  Activity,
  AlertCircle,
  Archive,
  ArrowDown,
  ArrowUp,
  Boxes,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  CircleDashed,
  ClipboardList,
  Edit3,
  GripVertical,
  HardDrive,
  Home,
  Info,
  Map as MapIcon,
  Menu,
  Moon,
  PackagePlus,
  PackageX,
  PanelLeftClose,
  PanelLeftOpen,
  Plus,
  RotateCcw,
  Search,
  Settings,
  Share2,
  ShieldCheck,
  SlidersHorizontal,
  Sun,
  Trash2,
  WifiOff,
  X,
} from "lucide-react";
import { createDemoState } from "../domain/demo";
import { expectationsForCommand } from "../domain/expectations";
import {
  createEmptyState,
  createItem,
  createLocation,
  DEFAULT_ITEM_CATEGORY,
  DEFAULT_ITEM_FREQUENCY,
  DEFAULT_ITEM_QUANTITY,
  DEFAULT_ITEM_UNIT,
  newId,
} from "../domain/factories";
import { suggestLocationCode } from "../domain/location-code";
import { DEFAULT_PLAN_WEIGHTS, generatePlan as buildMovePlan } from "../domain/planner";
import {
  assessPlanReadiness,
  type PlanReadiness,
} from "../domain/planning-readiness";
import type {
  CaptureStatus,
  Command,
  Dimensions,
  FieldExpectation,
  Frequency,
  ItemRecord,
  Location,
  LocationKind,
  PlanStep,
  PlanWeights,
  ThemePreference,
  WorkspaceState,
} from "../domain/types";
import {
  normalizeWorkspaceAccessState,
  workspaceReadOnlyReason,
} from "../domain/workspace-access";
import {
  accountContextHeaders,
  responseMatchesAccount,
} from "../shared/account-context";
import { nextCaptureLocation } from "./capture-order";
import {
  parseAppUrl,
  WORKSPACE_LIST_PATH,
  workspacePath,
  type AppRoute,
  type WorkspaceView,
} from "../domain/app-url";
import { listWorkspaceReplicas, readWorkspaceReplica } from "./local-replica";
import { JumpPalette } from "./jump-palette";
import {
  SOURCE_REPOSITORY_URL,
  USER_GUIDE_URL,
} from "./external-links";
import { ModalDialog } from "./modal-dialog";
import {
  STOWPLAN_HISTORY_EVENT,
  STOWPLAN_HISTORY_OWNER_ATTRIBUTE,
} from "./browser-history-bridge";
import {
  PREFERENCE_STORAGE_ERROR_EVENT,
  preferenceStorageUnavailable,
  readPreference,
  writePreference,
} from "./preference-storage";
import { AccountMenu } from "./account-menu";
import { ActivityHistory } from "./activity-history";
import {
  backupNotice,
  backupPresentation,
  type BackupPresentation,
} from "./backup-presentation";
import {
  type CompactPanel,
  ResizablePanels,
} from "./resizable-panels";
import { ReadOnlyWorkspace } from "./read-only-workspace";
import { parseAuthorizedRecoverySnapshot } from "./recovery-permissions";
import { StowplanProvider, useStowplan, WorkspaceOpenError } from "./store";
import { WorkspaceHub } from "./workspace-hub";
import { WorkspaceAccessController } from "./workspace-access-controller";

type View = WorkspaceView;
type Commit = (command: Command) => Promise<void>;
type LocationHierarchyCommand = Extract<
  Command,
  { type: "location.move" | "location.update" }
>;
type LocationPlacementCommand = Extract<
  Command,
  { type: "location.move" | "location.reorder" }
>;
type LocationChangeCommand =
  | LocationHierarchyCommand
  | LocationPlacementCommand;
type DragPayload = { id: string; type: "item" | "location" };
type DropIntent = "before" | "inside" | "after";
type DropTarget = { id: string | null; intent: DropIntent; kind: "item" | "location" | "root" };
type GuidanceFocus =
  | "item_capacity"
  | "item_details"
  | "space_capacity"
  | "space_suitability";
type GuidanceTarget = {
  focus?: GuidanceFocus;
  id: string;
  token: number;
  view: "capture" | "inventory" | "spaces";
};
type TreeEntry = { childCount: number; depth: number; location: Location };
type FeedbackDetail = {
  message: string;
  tone: "error" | "info" | "success";
};
type PendingHierarchyChange = {
  command: LocationHierarchyCommand;
  completedParentIds: string[];
  expectations: FieldExpectation[];
};
type ItemBulkMoveCommand = Extract<Command, { type: "item.bulkMove" }>;
type PendingItemBulkMove = {
  command: ItemBulkMoveCommand;
  completedLocationIds: string[];
  expectations: FieldExpectation[];
};
type LocationPlacementResult =
  | { command: LocationPlacementCommand; destinationParentId: string | null }
  | { error: string };
const CONTAINER_REVIEW_KIND = Object.freeze({
  EMPTY: "empty",
  KNOWN_EMPTY: "known-empty",
} as const);
type ContainerReview = {
  items: {
    id: string;
    name: string;
    quantity: number;
    unit: string;
  }[];
  kind: typeof CONTAINER_REVIEW_KIND[keyof typeof CONTAINER_REVIEW_KIND];
  locationId: string;
  locationName: string;
};
type AppliedTheme = "dark" | "light";

const nav: { id: View; label: string; icon: typeof Boxes }[] = [
  { id: "capture", label: "Capture", icon: PackagePlus },
  { id: "spaces", label: "Spaces", icon: MapIcon },
  { id: "inventory", label: "Inventory", icon: Boxes },
  { id: "plan", label: "Plan", icon: ClipboardList },
  { id: "activity", label: "Activity", icon: Activity },
  { id: "settings", label: "Settings", icon: Settings },
];
const PHONE_PRIMARY_VIEWS: readonly View[] = Object.freeze([
  "capture",
  "spaces",
  "inventory",
  "plan",
]);
const PHONE_MORE_VIEWS: readonly View[] = Object.freeze([
  "activity",
  "settings",
]);
const phonePrimaryNav = nav.filter((entry) =>
  PHONE_PRIMARY_VIEWS.includes(entry.id)
);
const phoneMoreNav = nav.filter((entry) =>
  PHONE_MORE_VIEWS.includes(entry.id)
);
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
    description: "Bonus = matching nearby records × this value, capped at four matches. A match shares an explicit item category or keep-together group. Blank and Uncategorized categories do not count as evidence that records belong together.",
  },
  moveCost: {
    label: "Move effort",
    description: "The score subtracts tree distance × this value, adds 3× this value for staying put, and requires an item move to improve by more than this value. Higher values favor one filled-container move only when none of its records scores worse at the destination.",
  },
  suitability: {
    label: "Suitability",
    description: "Every eligible space starts at 2× this value; satisfying food-safe adds 2×, avoiding warmth adds 1×, and avoiding humidity adds 1×. A space that violates a required rule is always rejected, even when this is zero.",
  },
};
const dragType = "application/x-stowplan-record";
const COMPLETE_CAPTURE_STATUSES = new Set<CaptureStatus>([
  "counted",
  "known_empty",
]);
const RECERTIFIED_CAPTURE_STATUS: CaptureStatus = "counted";

function demoEntryLocationId(
  state: WorkspaceState,
): string | undefined {
  const live = state.locations.filter((location) => !location.archivedAt);
  const parentIds = new Set(
    live
      .map((location) => location.parentId)
      .filter((id): id is string => id !== null),
  );
  return live.find((location) =>
    !parentIds.has(location.id) &&
    !COMPLETE_CAPTURE_STATUSES.has(location.captureStatus)
  )?.id ??
    live.find((location) =>
      !COMPLETE_CAPTURE_STATUSES.has(location.captureStatus)
    )?.id ??
    live[0]?.id;
}

const STACKED_TOUCH_LAYOUT_QUERY =
  "(max-width: 760px), (max-height: 520px) and (pointer: coarse) and (min-width: 761px)";
const SPACES_MIN_SIDE_BY_SIDE_WIDTH = 850;
const BROWSER_HISTORY_STATE = Object.freeze({ stowplan: true });
const ITEM_MODAL_HISTORY_STATE = Object.freeze({
  ...BROWSER_HISTORY_STATE,
  itemModal: true,
});
const DISMISS_FEEDBACK_EVENT = "stowplan:feedback-dismiss";
const DEMO_ENTRY_FOCUS_DELAY_MS = 100;
const FEEDBACK_EVENT = "stowplan:feedback";
const ITEM_EDITOR_FOCUS_RESTORE_FRAMES = 3;
const SEARCH_BLOCKED_EVENT = "stowplan:search-blocked";
const REORDER_DROP_MIDPOINT = 0.5;
const TOUCH_TAP_DISTANCE_PX = 8;
const LOCATION_POSITION = Object.freeze({
  AFTER_PREFIX: "after:",
  FIRST: "first",
});
const SIDEBAR_COLLAPSED_STORAGE_KEY = "stowplan-sidebar-collapsed";
const THEME_STORAGE_KEY = "stowplan-theme";
const THEME_PREFERENCES = new Set<ThemePreference>([
  "dark",
  "light",
  "system",
]);

function isThemePreference(value: string | null): value is ThemePreference {
  return value !== null && THEME_PREFERENCES.has(value as ThemePreference);
}

function applyThemePreference(theme: ThemePreference): AppliedTheme {
  const appliedTheme = theme === "dark" || (
    theme === "system" &&
    matchMedia("(prefers-color-scheme:dark)").matches
  )
    ? "dark"
    : "light";
  document.documentElement.dataset.theme = appliedTheme;
  return appliedTheme;
}

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
function expectationFingerprint(
  expectations: FieldExpectation[],
): string {
  return JSON.stringify([...expectations].sort((left, right) =>
    `${left.target}:${left.id}:${left.path}`.localeCompare(
      `${right.target}:${right.id}:${right.path}`,
    )
  ));
}
function flattenLocationTree(locations: Location[]): TreeEntry[] {
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
  const rectangle = target.getBoundingClientRect();
  const position = rectangle.height ? (clientY - rectangle.top) / rectangle.height : .5;
  if (kind === "item") {
    return { id, intent: position < .5 ? "before" : "after", kind };
  }
  return { id, intent: position < .28 ? "before" : position > .72 ? "after" : "inside", kind };
}
function reorderDropTarget(
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
function reorderTargetAt(
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
function TouchDragHandle({
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
    if (scrollAtEdge(current.clientY)) {
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
      if (tapped) {
        suppressTapClick.current = true;
        onTap?.();
        setTimeout(() => {
          suppressTapClick.current = false;
        }, 0);
      }
      else if (target) onDrop(target);
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
type UncontrolledFormValue = boolean | string;
type UncontrolledFormValues = Readonly<Record<string, UncontrolledFormValue>>;
function reconcileUntouchedFormControls(
  form: HTMLFormElement | null,
  previous: UncontrolledFormValues,
  next: UncontrolledFormValues,
): void {
  if (!form) return;
  for (const [name, nextValue] of Object.entries(next)) {
    const control = form.elements.namedItem(name);
    if (
      !(control instanceof HTMLInputElement) &&
      !(control instanceof HTMLSelectElement) &&
      !(control instanceof HTMLTextAreaElement)
    ) {
      continue;
    }
    const previousValue = previous[name];
    if (
      control instanceof HTMLInputElement &&
      (control.type === "checkbox" || control.type === "radio") &&
      typeof previousValue === "boolean" &&
      typeof nextValue === "boolean"
    ) {
      if (control.checked === previousValue) control.checked = nextValue;
      continue;
    }
    if (
      typeof previousValue === "string" &&
      typeof nextValue === "string" &&
      control.value === previousValue
    ) {
      control.value = nextValue;
    }
  }
}
function optionalDimensions(data: FormData): Dimensions | null {
  const raw = ["width", "height", "depth"].map((field) =>
    String(data.get(field) ?? "").trim()
  );
  if (raw.every((value) => value === "")) return null;
  const [width, height, depth] = raw.map(Number);
  if (
    raw.some((value) => value === "") ||
    ![width, height, depth].every((value) => Number.isFinite(value) && value > 0)
  ) {
    throw new Error(
      "Enter positive width, height, and depth values, or clear all three dimensions.",
    );
  }
  const unit = String(data.get("dimensionUnit"));
  if (unit !== "cm" && unit !== "in") throw new Error("Choose a valid dimension unit.");
  return { depth, height, unit, width };
}

function locationFormValues(location: Location): UncontrolledFormValues {
  return {
    code: location.code,
    dark: location.conditions.dark,
    depth: String(location.dimensions?.depth ?? ""),
    description: location.description,
    dimensionUnit: location.dimensions?.unit ?? "in",
    dry: location.conditions.dry,
    foodSafe: location.conditions.foodSafe,
    height: String(location.dimensions?.height ?? ""),
    humidity: location.conditions.humidity,
    kind: location.kind,
    name: location.name,
    parentId: location.parentId ?? "",
    tags: location.tags.join(", "),
    temperature: location.conditions.temperature,
    width: String(location.dimensions?.width ?? ""),
  };
}

function itemFormValues(item: ItemRecord): UncontrolledFormValues {
  return {
    avoidHumidity: item.constraints.avoidHumidity,
    avoidWarmth: item.constraints.avoidWarmth,
    category: item.category,
    depth: String(item.dimensions?.depth ?? ""),
    description: item.description,
    dimensionUnit: item.dimensions?.unit ?? "in",
    foodOnly: item.constraints.foodOnly,
    frequency: item.frequency,
    height: String(item.dimensions?.height ?? ""),
    keepTogether: item.constraints.keepTogether ?? "",
    moveQuantity: String(item.quantity),
    name: item.name,
    quantity: String(item.quantity),
    requiredTags: item.constraints.requiredTags.join(", "),
    tags: item.tags.join(", "),
    unit: item.unit,
    width: String(item.dimensions?.width ?? ""),
  };
}
function formatTimestamp(value: string | null): string {
  if (!value) return "Never";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "Unknown" : date.toLocaleString([], { dateStyle: "medium", timeStyle: "short" });
}
function countLabel(
  count: number,
  singular: string,
  plural = `${singular}s`,
): string {
  return `${count} ${count === 1 ? singular : plural}`;
}
function responseError(
  value: unknown,
  fallback: string,
): string {
  return value &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      "error" in value &&
      typeof value.error === "string"
    ? value.error
    : fallback;
}
function BackupStatusIcon({
  presentation,
}: {
  presentation: BackupPresentation;
}) {
  const Icon = presentation.offline
    ? WifiOff
    : presentation.deviceOnly
      ? HardDrive
      : presentation.state === "blocked"
        ? AlertCircle
        : presentation.state === "pending"
          ? CircleDashed
          : presentation.state === "synced"
            ? CheckCircle2
            : HardDrive;
  return <Icon />;
}
function DismissibleWorkspaceNotice({
  message,
  onDismiss,
  onboarding = false,
}: {
  message: string;
  onDismiss: () => void;
  onboarding?: boolean;
}) {
  return <output
    className={`workspace-notice${onboarding ? " onboarding-notice" : ""}`}
  >
    <span>{message}</span>
    <button
      aria-label="Dismiss workspace message"
      className="icon small"
      onClick={onDismiss}
      type="button"
    >
      <X />
    </button>
  </output>;
}
function stateWorkspacePath(
  state: WorkspaceState,
  {
    itemId = null,
    locationId = null,
    view,
  }: {
    itemId?: string | null;
    locationId?: string | null;
    view: View;
  },
): string {
  const item = itemId
    ? state.items.find((candidate) => candidate.id === itemId)
    : undefined;
  const location = locationId
    ? state.locations.find((candidate) => candidate.id === locationId)
    : undefined;
  return workspacePath({
    itemId,
    itemLabel: item?.name,
    locationId,
    locationLabel: location
      ? `${location.code} ${location.name}`
      : undefined,
    view,
    workspaceId: state.workspace.id,
    workspaceLabel: state.workspace.name,
  });
}
async function perform(commit: Commit, command: Command, after?: () => void): Promise<boolean> {
  try {
    await commit(command);
    after?.();
    return true;
  } catch (error) {
    showFeedback(
      error instanceof Error ? error.message : "That change could not be applied",
      "error",
    );
    return false;
  }
}
function showFeedback(
  message: string,
  tone: FeedbackDetail["tone"] = "error",
): void {
  dispatchEvent(new CustomEvent<FeedbackDetail>(FEEDBACK_EVENT, {
    detail: { message, tone },
  }));
}
function dismissFeedback(): void {
  dispatchEvent(new Event(DISMISS_FEEDBACK_EVENT));
}
const pendingForms = new WeakSet<HTMLFormElement>();
function submitForm(
  event: React.FormEvent<HTMLFormElement>,
  action: (data: FormData) => Promise<boolean>,
  resetOnSuccess = true,
  focusAfterSuccess?: string,
): void {
  event.preventDefault();
  const form = event.currentTarget;
  if (pendingForms.has(form)) return;
  const data = new FormData(form);
  const submitControls = [
    ...form.querySelectorAll<HTMLButtonElement | HTMLInputElement>(
      'button:not([type]), button[type="submit"], input[type="submit"]',
    ),
  ];
  const activeSubmitControl = submitControls.find(
    (control) => control === document.activeElement,
  ) ?? null;
  const disabledBefore = submitControls.map((control) => control.disabled);
  pendingForms.add(form);
  form.setAttribute("aria-busy", "true");
  submitControls.forEach((control) => { control.disabled = true; });
  void Promise.resolve().then(() => action(data)).then((saved) => {
    if (saved && resetOnSuccess && form.isConnected) {
      form.reset();
      if (focusAfterSuccess) {
        form.querySelector<HTMLElement>(focusAfterSuccess)?.focus();
      }
    }
  }).catch((error) => {
    showFeedback(
      error instanceof Error ? error.message : "That change could not be applied",
    );
  }).finally(() => {
    pendingForms.delete(form);
    if (!form.isConnected) return;
    form.removeAttribute("aria-busy");
    submitControls.forEach((control, index) => {
      control.disabled = disabledBefore[index] ?? false;
    });
    if (
      activeSubmitControl?.isConnected &&
      document.activeElement === document.body
    ) {
      activeSubmitControl.focus();
    }
  });
}
function descendantIds(state: WorkspaceState, locationId: string): string[] {
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

function locationPlacementForDrop(
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

function useHierarchyChanges({
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

function updateSuggestedLocationCode(
  form: HTMLFormElement | null,
  existingCodes: readonly string[],
): void {
  if (!form) return;
  const code = form.elements.namedItem("code");
  const kind = form.elements.namedItem("kind");
  const name = form.elements.namedItem("name");
  if (
    !(code instanceof HTMLInputElement) ||
    !(kind instanceof HTMLSelectElement) ||
    !(name instanceof HTMLInputElement)
  ) {
    return;
  }
  if (code.dataset.userEdited === "true" && code.value.trim()) return;
  code.value = suggestLocationCode(
    name.value,
    kind.value as LocationKind,
    existingCodes,
  );
}

function LocationCreateFields({
  defaultKind,
  existingCodes,
  kindLabel,
  namePlaceholder,
}: {
  defaultKind: LocationKind;
  existingCodes: readonly string[];
  kindLabel: string;
  namePlaceholder: string;
}) {
  const update = (
    event: React.FormEvent<HTMLInputElement | HTMLSelectElement>,
  ) => updateSuggestedLocationCode(event.currentTarget.form, existingCodes);
  return <>
    <div className="form-pair">
      <input
        required
        name="code"
        aria-label="Short ID"
        autoComplete="off"
        placeholder="Suggested Short ID"
        autoCapitalize="characters"
        onInput={(event) => {
          event.currentTarget.dataset.userEdited = "true";
        }}
      />
      <select
        name="kind"
        aria-label={kindLabel}
        defaultValue={defaultKind}
        onChange={update}
      >
        {kinds.map((kind) => <option key={kind}>{kind}</option>)}
      </select>
    </div>
    <input
      required
      name="name"
      aria-label="Friendly name"
      autoComplete="off"
      placeholder={namePlaceholder}
      onInput={update}
    />
  </>;
}

interface StowplanAppProps {
  directDemo?: boolean;
}

export function StowplanApp({
  directDemo = false,
}: StowplanAppProps) {
  return <StowplanProvider>
    <Application directDemo={directDemo} />
  </StowplanProvider>;
}

function Application({
  directDemo,
}: Required<StowplanAppProps>) {
  const {
    account,
    accountId,
    authenticationReady,
    authorization,
    backupConfigured,
    blocked,
    catalogError,
    catalogHasMore,
    catalogLoading,
    dispatch,
    hubCards,
    initialize,
    lastSyncError,
    lastSyncedAt,
    loadMoreWorkspaces,
    localUpdatedAt,
    online,
    openWorkspace,
    pending,
    refreshWorkspaces,
    removeWorkspace,
    replace,
    setWorkspaceAccess,
    signedIn,
    state,
    syncing,
  } = useStowplan();
  const activeWorkspaceId = state?.workspace.id;
  const [view, setView] = useState<View>("capture");
  const [selected, setSelected] = useState<string | null>(null);
  const [inventoryLocationId, setInventoryLocationId] = useState<string | null>(null);
  const [inventoryItemId, setInventoryItemId] = useState<string | null>(null);
  const [showWelcome, setShowWelcome] = useState(false);
  const [theme, setTheme] = useState<ThemePreference>("system");
  const [appliedTheme, setAppliedTheme] = useState<AppliedTheme>("light");
  const [themeReady, setThemeReady] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [sidebarReady, setSidebarReady] = useState(false);
  const [workspaceNotice, setWorkspaceNotice] = useState("");
  const [
    dismissedBackupMessageKey,
    setDismissedBackupMessageKey,
  ] = useState<string | null>(null);
  const [
    dismissedAccessMessageKey,
    setDismissedAccessMessageKey,
  ] = useState<string | null>(null);
  const [jumpPaletteOpen, setJumpPaletteOpen] = useState(false);
  const [mobileMoreOpen, setMobileMoreOpen] = useState(false);
  const [feedback, setFeedback] = useState<FeedbackDetail | null>(null);
  const [preferencesSessionOnly, setPreferencesSessionOnly] = useState(false);
  const [
    preferenceStorageMessageDismissed,
    setPreferenceStorageMessageDismissed,
  ] = useState(false);
  const [guidanceTarget, setGuidanceTarget] = useState<GuidanceTarget | null>(null);
  const [routeStatus, setRouteStatus] = useState<"blocked" | "loading" | "ready">("loading");
  const routeRequest = useRef(0);
  const workspaceOpenController = useRef<AbortController | null>(
    null,
  );
  const directDemoHandled = useRef(false);
  const mobileMoreTrigger = useRef<HTMLButtonElement>(null);

  const cancelWorkspaceOpen = useCallback(() => {
    workspaceOpenController.current?.abort();
    workspaceOpenController.current = null;
  }, []);
  const beginWorkspaceOpen = useCallback(() => {
    cancelWorkspaceOpen();
    const controller = new AbortController();
    workspaceOpenController.current = controller;
    return controller;
  }, [cancelWorkspaceOpen]);
  const finishWorkspaceOpen = useCallback((
    controller: AbortController,
  ) => {
    if (workspaceOpenController.current === controller) {
      workspaceOpenController.current = null;
    }
  }, []);

  useLayoutEffect(() => {
    /* eslint-disable react-hooks/set-state-in-effect -- hydrate device-only preferences after the server-consistent first render */
    const saved = readPreference(THEME_STORAGE_KEY) as ThemePreference | null;
    const nextTheme = isThemePreference(saved) ? saved : "system";
    setTheme(nextTheme);
    setAppliedTheme(applyThemePreference(nextTheme));
    setThemeReady(true);
    /* eslint-enable react-hooks/set-state-in-effect */
  }, []);
  useEffect(() => {
    /* eslint-disable react-hooks/set-state-in-effect -- hydrate device-only preferences after the server-consistent first render */
    setSidebarCollapsed(
      readPreference(SIDEBAR_COLLAPSED_STORAGE_KEY) === "true",
    );
    if (preferenceStorageUnavailable()) setPreferencesSessionOnly(true);
    setSidebarReady(true);
    /* eslint-enable react-hooks/set-state-in-effect */
    if ("serviceWorker" in navigator) navigator.serviceWorker.register("/sw.js").catch(() => undefined);
  }, []);
  useEffect(() => {
    if (!themeReady) return;
    writePreference(THEME_STORAGE_KEY, theme);
    if (theme !== "system") return;
    const media = matchMedia("(prefers-color-scheme:dark)");
    const applySystemTheme = () => {
      setAppliedTheme(applyThemePreference("system"));
    };
    media.addEventListener("change", applySystemTheme);
    return () => media.removeEventListener("change", applySystemTheme);
  }, [theme, themeReady]);
  useEffect(() => {
    if (!sidebarReady) return;
    writePreference(
      SIDEBAR_COLLAPSED_STORAGE_KEY,
      String(sidebarCollapsed),
    );
  }, [sidebarCollapsed, sidebarReady]);
  useEffect(() => {
    const receivePreferenceStorageError = () =>
      setPreferencesSessionOnly(true);
    addEventListener(
      PREFERENCE_STORAGE_ERROR_EVENT,
      receivePreferenceStorageError,
    );
    /* eslint-disable react-hooks/set-state-in-effect -- storage can fail before child and parent effects subscribe */
    if (preferenceStorageUnavailable()) setPreferencesSessionOnly(true);
    /* eslint-enable react-hooks/set-state-in-effect */
    return () => removeEventListener(
      PREFERENCE_STORAGE_ERROR_EVENT,
      receivePreferenceStorageError,
    );
  }, []);
  useEffect(() => {
    const receiveFeedback = (event: Event) => {
      setFeedback((event as CustomEvent<FeedbackDetail>).detail);
    };
    const dismissCurrentFeedback = () => setFeedback(null);
    addEventListener(FEEDBACK_EVENT, receiveFeedback);
    addEventListener(DISMISS_FEEDBACK_EVENT, dismissCurrentFeedback);
    return () => {
      removeEventListener(FEEDBACK_EVENT, receiveFeedback);
      removeEventListener(DISMISS_FEEDBACK_EVENT, dismissCurrentFeedback);
    };
  }, []);
  useEffect(() => {
    if (!feedback) return;
    const timeout = setTimeout(() => setFeedback(null), 6_000);
    return () => clearTimeout(timeout);
  }, [feedback]);
  useEffect(() => {
    if (
      !activeWorkspaceId ||
      showWelcome
    ) return;
    const shortcut = (event: KeyboardEvent) => {
      if (
        event.key.toLocaleLowerCase() === "k" &&
        (event.metaKey || event.ctrlKey)
      ) {
        event.preventDefault();
        if (
          !jumpPaletteOpen &&
          document.querySelector('[aria-modal="true"]')
        ) {
          requestAnimationFrame(() => {
            if (!document.querySelector('[aria-modal="true"]')) {
              setJumpPaletteOpen(true);
              return;
            }
            const blocked = new Event(SEARCH_BLOCKED_EVENT, {
              cancelable: true,
            });
            if (dispatchEvent(blocked)) {
              showFeedback(
                "Close the open dialog before searching",
                "info",
              );
            }
          });
          return;
        }
        setJumpPaletteOpen((open) => !open);
      } else if (event.key === "Escape" && jumpPaletteOpen) {
        setJumpPaletteOpen(false);
      }
    };
    addEventListener("keydown", shortcut, true);
    return () => removeEventListener("keydown", shortcut, true);
  }, [activeWorkspaceId, jumpPaletteOpen, showWelcome]);

  const applyBrowserRoute = useCallback(async (route: AppRoute) => {
    const request = routeRequest.current + 1;
    routeRequest.current = request;
    cancelWorkspaceOpen();
    setWorkspaceNotice("");
    if (route.kind === "workspace-list") {
      setShowWelcome(true);
      setRouteStatus("ready");
      return;
    }
    if (route.kind === "home") {
      setShowWelcome(false);
      setRouteStatus("ready");
      return;
    }
    const openController = beginWorkspaceOpen();
    setRouteStatus("loading");
    try {
      const [existing, localWorkspacesBeforeOpen] = await Promise.all([
        readWorkspaceReplica(route.workspaceId),
        listWorkspaceReplicas(),
      ]);
      if (!existing && !authenticationReady) return;
      await openWorkspace(
        route.workspaceId,
        openController.signal,
      );
      const opened = await readWorkspaceReplica(route.workspaceId);
      if (routeRequest.current !== request) return;
      if (!opened) {
        throw new Error("Could not read the requested workspace from this device");
      }
      const staleItem = Boolean(
        route.itemId &&
        !opened.state.items.some(
          (item) => item.id === route.itemId && !item.archivedAt,
        ),
      );
      const staleLocation = Boolean(
        route.locationId &&
        !opened.state.locations.some(
          (candidate) =>
            candidate.id === route.locationId && !candidate.archivedAt,
        ),
      );
      setView(route.view);
      setMobileMoreOpen(false);
      setSelected(
        !staleLocation &&
          (route.view === "capture" || route.view === "spaces")
          ? route.locationId
          : null,
      );
      setInventoryLocationId(
        route.view === "inventory" && !staleLocation
          ? route.locationId
          : null,
      );
      setInventoryItemId(
        route.view === "inventory" && !staleItem
          ? route.itemId
          : null,
      );
      setGuidanceTarget(null);
      setShowWelcome(false);
      scrollAppToTop();
      if (staleItem) {
        const message =
          "This item link is stale. The item is missing or archived, so Stowplan did not open it.";
        setWorkspaceNotice(message);
      } else if (staleLocation) {
        const message =
          "This space link is stale. The space is missing or archived, so Stowplan did not open it.";
        setWorkspaceNotice(message);
      } else if (
        !existing &&
        localWorkspacesBeforeOpen.some(
          (workspace) => workspace.id !== route.workspaceId,
        )
      ) {
        setWorkspaceNotice("Shared workspace opened. Your previous local workspace is still available from the main menu.");
      }
      setRouteStatus(staleItem || staleLocation ? "blocked" : "ready");
    } catch (error) {
      if (routeRequest.current !== request) return;
      if (error instanceof WorkspaceOpenError && error.status === 401) {
        const returnTo = `${location.pathname}${location.search}${location.hash}`;
        location.assign(`/account?returnTo=${encodeURIComponent(returnTo)}`);
        return;
      }
      setShowWelcome(true);
      setWorkspaceNotice(error instanceof Error ? error.message : "Could not open the shared workspace");
      setRouteStatus("blocked");
    } finally {
      finishWorkspaceOpen(openController);
    }
  }, [
    authenticationReady,
    beginWorkspaceOpen,
    cancelWorkspaceOpen,
    finishWorkspaceOpen,
    openWorkspace,
  ]);
  const applyBrowserRouteRef = useRef(applyBrowserRoute);
  useLayoutEffect(() => {
    applyBrowserRouteRef.current = applyBrowserRoute;
  }, [applyBrowserRoute]);

  useLayoutEffect(() => {
    const openHistoryRoute = () => {
      void applyBrowserRouteRef.current(
        parseAppUrl(new URL(location.href)),
      );
    };
    addEventListener(STOWPLAN_HISTORY_EVENT, openHistoryRoute);
    document.documentElement.setAttribute(
      STOWPLAN_HISTORY_OWNER_ATTRIBUTE,
      "",
    );
    return () => {
      routeRequest.current += 1;
      workspaceOpenController.current?.abort();
      workspaceOpenController.current = null;
      document.documentElement.removeAttribute(
        STOWPLAN_HISTORY_OWNER_ATTRIBUTE,
      );
      removeEventListener(STOWPLAN_HISTORY_EVENT, openHistoryRoute);
    };
  }, []);

  useEffect(() => {
    const openCurrentRoute = () =>
      void applyBrowserRoute(parseAppUrl(new URL(location.href)));
    openCurrentRoute();
  }, [applyBrowserRoute]);

  const current = state
    ? state.locations.find((location) => location.id === selected && !location.archivedAt) ??
      state.locations.find((location) => !location.archivedAt) ??
      null
    : null;
  const validInventoryLocationId = state?.locations.some(
    (location) => location.id === inventoryLocationId && !location.archivedAt,
  )
    ? inventoryLocationId
    : null;
  const validInventoryItemId = state?.items.some(
    (item) => item.id === inventoryItemId && !item.archivedAt,
  )
    ? inventoryItemId
    : null;
  const canonicalPath = state
    ? stateWorkspacePath(state, {
        itemId: view === "inventory" ? validInventoryItemId : null,
        locationId:
          view === "capture" || view === "spaces"
            ? current?.id
            : view === "inventory"
              ? validInventoryLocationId
              : null,
        view,
      })
    : null;
  const collaborationPath = state
    ? stateWorkspacePath(state, {
        locationId: current?.id,
        view: "capture",
      })
    : WORKSPACE_LIST_PATH;

  useEffect(() => {
    if (
      routeStatus !== "ready" ||
      showWelcome ||
      !canonicalPath ||
      (directDemo && !directDemoHandled.current)
    ) return;
    const browserPath = `${location.pathname}${location.search}`;
    if (browserPath !== canonicalPath) {
      const itemModalEntry = isItemModalHistoryEntry(history.state);
      if (itemModalEntry && !validInventoryItemId) return;
      updateBrowserHistory(
        canonicalPath,
        "replace",
        validInventoryItemId && itemModalEntry
          ? ITEM_MODAL_HISTORY_STATE
          : BROWSER_HISTORY_STATE,
      );
    }
  }, [
    canonicalPath,
    directDemo,
    routeStatus,
    showWelcome,
    validInventoryItemId,
  ]);

  useEffect(() => {
    if (showWelcome) {
      document.title = "Workspaces · Stowplan";
      return;
    }
    if (!state) return;
    const viewLabel = nav.find((entry) => entry.id === view)?.label ?? "Workspace";
    document.title = `${viewLabel} · ${state.workspace.name} · Stowplan`;
  }, [showWelcome, state, view]);

  const writePath = useCallback((
    path: string,
    mode: "push" | "replace" = "push",
    itemModal = false,
  ) => {
    setRouteStatus("ready");
    setWorkspaceNotice("");
    const browserPath = `${location.pathname}${location.search}`;
    if (browserPath === path) return;
    updateBrowserHistory(
      path,
      mode,
      itemModal ? ITEM_MODAL_HISTORY_STATE : BROWSER_HISTORY_STATE,
    );
  }, []);

  const enter = useCallback((
    next: WorkspaceState,
    mode: "push" | "replace" = "replace",
    initialLocationId?: string,
  ) => {
    const locationId = initialLocationId ??
      next.locations.find((location) => !location.archivedAt)?.id ??
      null;
    setSelected(locationId);
    setInventoryLocationId(null);
    setInventoryItemId(null);
    setGuidanceTarget(null);
    setView("capture");
    setMobileMoreOpen(false);
    setShowWelcome(false);
    setRouteStatus("ready");
    setWorkspaceNotice("");
    scrollAppToTop();
    writePath(stateWorkspacePath(next, {
      locationId,
      view: "capture",
    }), mode);
  }, [writePath]);
  const start = useCallback(async (
    demo: boolean,
    name?: string,
    mode?: "push" | "replace",
    enterDemoTask = false,
  ) => {
    const next = demo ? createDemoState(newId("ws_demo")) : createEmptyState(name?.trim() || "My home");
    await initialize(next);
    enter(
      next,
      mode ??
        (location.pathname === WORKSPACE_LIST_PATH ? "push" : "replace"),
      enterDemoTask ? demoEntryLocationId(next) : undefined,
    );
  }, [enter, initialize]);
  const openDemo = useCallback(async (
    mode: "push" | "replace" = "push",
    enterDemoTask = false,
  ) => {
    const openController = beginWorkspaceOpen();
    const demo = (await listWorkspaceReplicas()).find((workspace) => workspace.id.startsWith("ws_demo"));
    try {
      if (demo) {
        await openWorkspace(demo.id, openController.signal);
        const next = await readWorkspaceReplica(demo.id);
        if (!next) throw new Error("Could not open kitchen demo");
        if (!openController.signal.aborted) {
          enter(
            next.state,
            mode,
            enterDemoTask
              ? demoEntryLocationId(next.state)
              : undefined,
          );
        }
        return;
      }
      await start(true, undefined, mode, enterDemoTask);
    } catch (error) {
      if (!openController.signal.aborted) throw error;
    } finally {
      finishWorkspaceOpen(openController);
    }
  }, [
    beginWorkspaceOpen,
    enter,
    finishWorkspaceOpen,
    openWorkspace,
    start,
  ]);
  useEffect(() => {
    if (
      !directDemo ||
      directDemoHandled.current ||
      routeStatus !== "ready"
    ) return;
    directDemoHandled.current = true;
    void openDemo("replace", true).catch((error) => {
      setShowWelcome(true);
      setRouteStatus("blocked");
      setWorkspaceNotice(
        error instanceof Error
          ? error.message
          : "Could not open the kitchen demo",
      );
    });
  }, [directDemo, openDemo, routeStatus]);
  const chooseWorkspace = async (workspaceId: string) => {
    const openController = beginWorkspaceOpen();
    try {
      await openWorkspace(workspaceId, openController.signal);
      const next = await readWorkspaceReplica(workspaceId);
      if (!next) throw new Error("Could not open workspace");
      if (!openController.signal.aborted) {
        enter(next.state, "push");
      }
    } catch (error) {
      if (!openController.signal.aborted) throw error;
    } finally {
      finishWorkspaceOpen(openController);
    }
  };
  const reviewWorkspaceRecovery = async (workspaceId: string) => {
    await chooseWorkspace(workspaceId);
    location.assign("/recovery");
  };
  const removeLocalWorkspace = async (workspaceId: string, expectedUpdatedAt?: string) => {
    await removeWorkspace(workspaceId, expectedUpdatedAt);
    setSelected(null);
  };
  const resetDemo = async () => {
    if (!state?.workspace.id.startsWith("ws_demo")) return;
    const resetWorkspaceId = state.workspace.id;
    const next = createDemoState(newId("ws_demo"));
    if (authorization?.kind !== "server") {
      await replace(next);
      enter(next, "push");
      showFeedback("Fresh private demo created", "success");
      return;
    }
    if (
      !accountId ||
      authorization.status !== "active" ||
      !authorization.capabilities.delete
    ) {
      throw new Error(
        "Workspace owner access is required to reset a backed-up demo",
      );
    }
    if (!online) {
      throw new Error(
        "Reconnect before resetting this backed-up demo",
      );
    }
    const resetAccountId = accountId;
    const serverResponse = await fetch(
      `/api/snapshot?workspaceId=${encodeURIComponent(resetWorkspaceId)}`,
      {
        cache: "no-store",
        headers: accountContextHeaders(resetAccountId),
      },
    );
    const serverBody = await serverResponse.json().catch(() => null) as unknown;
    if (!serverResponse.ok) {
      throw new Error(responseError(
        serverBody,
        "Could not review the backed-up demo before resetting it",
      ));
    }
    if (!responseMatchesAccount(serverResponse, resetAccountId)) {
      throw new Error(
        "The signed-in account changed before the demo reset",
      );
    }
    const serverSnapshot = parseAuthorizedRecoverySnapshot(
      serverBody,
      resetWorkspaceId,
      resetAccountId,
    );
    if (
      serverSnapshot.authorization.role !== "owner" ||
      !serverSnapshot.authorization.capabilities.delete
    ) {
      throw new Error(
        "Workspace owner access is required to reset a backed-up demo",
      );
    }
    const deleteResponse = await fetch(
      `/api/workspaces/${encodeURIComponent(resetWorkspaceId)}`,
      {
        body: JSON.stringify({
          confirmationName: serverSnapshot.state.workspace.name,
          expectedAccessRevision:
            serverSnapshot.authorization.accessRevision,
          expectedMembershipRevision:
            serverSnapshot.authorization.membershipRevision,
          expectedRevision: serverSnapshot.state.workspace.revision,
        }),
        headers: accountContextHeaders(resetAccountId, {
          "content-type": "application/json",
        }),
        method: "DELETE",
      },
    );
    const deletion = await deleteResponse.json().catch(() => null) as unknown;
    if (!deleteResponse.ok) {
      throw new Error(responseError(
        deletion,
        "The backed-up demo could not be deleted",
      ));
    }
    if (!responseMatchesAccount(deleteResponse, resetAccountId)) {
      throw new Error(
        "The signed-in account changed while the demo was being reset",
      );
    }
    if (
      !deletion ||
      typeof deletion !== "object" ||
      Array.isArray(deletion) ||
      !("deleted" in deletion) ||
      deletion.deleted !== true ||
      !("deletedAt" in deletion) ||
      typeof deletion.deletedAt !== "string" ||
      !("finalAccessRevision" in deletion) ||
      !Number.isSafeInteger(deletion.finalAccessRevision) ||
      !("workspaceId" in deletion) ||
      deletion.workspaceId !== resetWorkspaceId
    ) {
      throw new Error(
        "The server returned an invalid demo deletion confirmation",
      );
    }
    await setWorkspaceAccess(
      resetWorkspaceId,
      normalizeWorkspaceAccessState({
        accountId: resetAccountId,
        accessRevision: deletion.finalAccessRevision,
        checkedAt: deletion.deletedAt,
        kind: "server",
        membershipRevision:
          serverSnapshot.authorization.membershipRevision + 1,
        role: serverSnapshot.authorization.role,
        status: "deleted",
      }),
      {
        ...serverSnapshot.workspace,
        accountId: resetAccountId,
      },
    );
    await initialize(next);
    let retainedRecoveryCopy = false;
    try {
      await removeWorkspace(
        resetWorkspaceId,
        localUpdatedAt ?? undefined,
      );
    } catch {
      retainedRecoveryCopy = true;
    }
    enter(next, "push");
    showFeedback(
      retainedRecoveryCopy
        ? "Fresh demo created. The deleted server copy changed on this device, so its read-only recovery copy remains in Workspaces."
        : "Old demo deleted and fresh private demo created",
      retainedRecoveryCopy ? "info" : "success",
    );
  };
  const openWorkspaceMenu = () => {
    cancelWorkspaceOpen();
    setShowWelcome(true);
    setRouteStatus("ready");
    setWorkspaceNotice("");
    writePath(WORKSPACE_LIST_PATH);
  };
  const continueWorkspace = () => {
    setShowWelcome(false);
    setRouteStatus("ready");
    if (canonicalPath) writePath(canonicalPath);
  };

  if (routeStatus === "loading") {
    return <div className="loading">Opening the requested workspace view…</div>;
  }
  const workspaceHub = <WorkspaceHub
    accountState={{
      configured: backupConfigured,
      ready: authenticationReady,
      user: account,
    }}
    backupConfigured={backupConfigured}
    cards={hubCards}
    catalogError={catalogError}
    catalogLoading={catalogLoading}
    currentId={state?.workspace.id}
    hasMore={catalogHasMore}
    online={online}
    onContinue={state ? continueWorkspace : undefined}
    onLoadMore={loadMoreWorkspaces}
    onOpen={chooseWorkspace}
    onOpenDemo={openDemo}
    onRefresh={refreshWorkspaces}
    onReviewRecovery={reviewWorkspaceRecovery}
    onRemove={removeLocalWorkspace}
    onResetDemo={
      state?.workspace.id.startsWith("ws_demo")
        ? resetDemo
        : undefined
    }
    onStart={start}
    signedIn={signedIn}
  />;
  if (!state) {
    return <>{workspaceHub}{workspaceNotice &&
      <DismissibleWorkspaceNotice
        message={workspaceNotice}
        onDismiss={() => setWorkspaceNotice("")}
        onboarding
      />}</>;
  }
  if (showWelcome) {
    return <>{workspaceHub}{workspaceNotice &&
      <DismissibleWorkspaceNotice
        message={workspaceNotice}
        onDismiss={() => setWorkspaceNotice("")}
        onboarding
      />}</>;
  }
  const tabPath = (nextView: View) => stateWorkspacePath(state, {
    locationId:
      nextView === "capture" || nextView === "spaces"
        ? current?.id
        : nextView === "inventory"
          ? validInventoryLocationId
          : null,
    view: nextView,
  });
  const selectView = (nextView: View) => {
    setGuidanceTarget(null);
    setInventoryItemId(null);
    setView(nextView);
    setMobileMoreOpen(false);
    setRouteStatus("ready");
    scrollAppToTop();
    writePath(tabPath(nextView));
  };
  const selectLocation = (id: string) => {
    setSelected(id);
    if (view === "capture" || view === "spaces") {
      writePath(stateWorkspacePath(state, {
        locationId: id,
        view,
      }));
    }
  };
  const changeInventoryLocation = (id: string) => {
    const locationId = id || null;
    setInventoryLocationId(locationId);
    setInventoryItemId(null);
    setGuidanceTarget(null);
    writePath(stateWorkspacePath(state, {
      locationId,
      view: "inventory",
    }));
  };
  const changeInventoryItem = (id: string | null) => {
    setInventoryItemId(id);
    if (!id) setGuidanceTarget(null);
    if (
      !id &&
      inventoryItemId &&
      isItemModalHistoryEntry(history.state)
    ) {
      setRouteStatus("ready");
      setWorkspaceNotice("");
      window.History.prototype.back.call(history);
      return;
    }
    writePath(stateWorkspacePath(state, {
      itemId: id,
      locationId: id ? null : validInventoryLocationId,
      view: "inventory",
    }), id ? "push" : "replace", Boolean(id));
  };
  const openGuidanceTarget = (
    nextView: GuidanceTarget["view"],
    id: string,
    focus?: GuidanceFocus,
  ) => {
    if (nextView === "inventory") {
      const item = state.items.find((candidate) => candidate.id === id);
      if (item) setSelected(item.locationId);
      setInventoryItemId(id);
    } else {
      setSelected(id);
      setInventoryItemId(null);
    }
    setGuidanceTarget((previous) => ({
      focus,
      id,
      token: (previous?.token ?? 0) + 1,
      view: nextView,
    }));
    setView(nextView);
    scrollAppToTop();
    writePath(
      stateWorkspacePath(state, {
        itemId: nextView === "inventory" ? id : null,
        locationId: nextView === "inventory" ? null : id,
        view: nextView,
      }),
      "push",
      nextView === "inventory",
    );
  };
  const shareCurrentView = async () => {
    if (!canonicalPath) return;
    setFeedback(null);
    const url = new URL(canonicalPath, location.origin).href;
    const title = `${view === "access" ? "Workspace access" : nav.find((entry) => entry.id === view)?.label ?? "Workspace"} · ${state.workspace.name}`;
    try {
      if (typeof navigator.share === "function") {
        await navigator.share({ title, url });
        showFeedback("Shared this workspace view", "success");
        return;
      }
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(url);
        showFeedback(
          "Link copied. Anyone with workspace access can open this exact view.",
          "success",
        );
        return;
      }
      showFeedback(
        "Copy this view from the browser address bar to share it",
        "info",
      );
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") {
        return;
      }
      showFeedback(
        "Could not share automatically. Copy this view from the browser address bar.",
        "error",
      );
    }
  };
  const FeedbackIcon = feedback?.tone === "success"
    ? CheckCircle2
    : feedback?.tone === "info"
      ? Info
      : AlertCircle;
  const selectTheme = (nextTheme: ThemePreference) => {
    setTheme(nextTheme);
    setAppliedTheme(applyThemePreference(nextTheme));
  };
  const themeToggleLabel = appliedTheme === "dark"
    ? "Dark theme active. Switch to light theme"
    : "Light theme active. Switch to dark theme";
  const serverBacked = authorization?.kind === "server";
  const backupOptions = {
    accessStatus: authorization?.kind === "server"
      ? authorization.status
      : undefined,
    authenticationReady,
    backupConfigured,
    blocked,
    lastSyncError,
    lastSyncedAt,
    online,
    pending,
    serverBacked,
    signedIn,
    syncing,
  };
  const syncStatus = backupPresentation(backupOptions);
  const backupMessage = backupNotice(backupOptions);
  const backupMessageKey = backupMessage
    ? [
        state.workspace.id,
        backupMessage.title,
        backupMessage.message,
        lastSyncedAt ?? "never",
      ].join(":")
    : null;
  const showBackupMessage = Boolean(
    backupMessageKey &&
    backupMessageKey !== dismissedBackupMessageKey,
  );
  const backupRecoveryNeeded =
    syncStatus.state === "blocked" && signedIn;
  const accountReviewPath =
    `/account?workspace=${encodeURIComponent(state.workspace.id)}&returnTo=${
      encodeURIComponent(canonicalPath ?? tabPath(view))
    }`;
  const backupReviewPath = backupMessage?.action === "account"
    ? accountReviewPath
    : backupMessage?.action === "recovery" || backupRecoveryNeeded
      ? "/recovery"
      : WORKSPACE_LIST_PATH;
  const syncTitle = syncStatus.terminal
    ? `${syncStatus.label}. This retained device copy is not backed up online.`
    : backupMessage?.message ??
      (lastSyncedAt
        ? `Last successful backup: ${formatTimestamp(lastSyncedAt)}`
        : "This workspace has not been backed up online yet.");
  const syncLinkTitle = backupMessage?.action === "account"
    ? `${syncTitle} Open Account.`
    : backupMessage?.action === "recovery" || backupRecoveryNeeded
      ? `${syncTitle} Open Sync & recovery.`
      : `${syncTitle} Review all workspace backup statuses.`;
  const readOnlyReason = authorization
    ? workspaceReadOnlyReason(authorization)
    : null;
  const accessMessageKey = readOnlyReason
    ? [
        state.workspace.id,
        authorization?.kind,
        authorization?.status,
        authorization?.role,
        authorization?.accessRevision,
        readOnlyReason,
      ].join(":")
    : null;
  const showAccessMessage = Boolean(
    accessMessageKey &&
    accessMessageKey !== dismissedAccessMessageKey,
  );
  const readOnly = Boolean(readOnlyReason);
  return <div className="app-shell" data-sidebar-collapsed={sidebarCollapsed}>
    <aside aria-label="Workspace navigation">
      <Brand />
      <nav>
        {nav.map((entry) => <Nav key={entry.id} {...entry} active={entry.id === view} href={tabPath(entry.id)} select={() => selectView(entry.id)} />)}
        {account?.globalRole === "admin" && <a
          className="nav"
          href="/admin"
          title="Administration"
        >
          <ShieldCheck aria-hidden="true" />
          <span>Administration</span>
        </a>}
      </nav>
      <button
        className="sidebar-toggle"
        type="button"
        aria-label={sidebarCollapsed ? "Expand sidebar" : "Collapse sidebar"}
        title={sidebarCollapsed ? "Expand sidebar" : "Collapse sidebar"}
        onClick={() => setSidebarCollapsed((collapsed) => !collapsed)}
      >
        {sidebarCollapsed ? <PanelLeftOpen /> : <PanelLeftClose />}
        <span>{sidebarCollapsed ? "Expand sidebar" : "Collapse sidebar"}</span>
      </button>
      <a
        className="sync"
        href={backupReviewPath}
        aria-label={`Review workspace backup statuses: ${syncStatus.label}`}
        title={syncLinkTitle}
        onClick={backupReviewPath === WORKSPACE_LIST_PATH
          ? (event) => followAppLink(event, openWorkspaceMenu)
          : undefined}
      >
        <BackupStatusIcon presentation={syncStatus} />
        <span>{syncStatus.label}</span>
      </a>
    </aside>
    <main tabIndex={-1}>
      <header>
        <div>
          <p className="eyebrow">{state.workspace.name}</p>
          <h1>
            {view === "access"
              ? "Workspace access"
              : nav.find((entry) => entry.id === view)?.label}
          </h1>
        </div>
        <div className="header-actions">
          <button
            aria-keyshortcuts="Control+K Meta+K"
            aria-label="Search ⌘ / Ctrl K and jump"
            className="jump-trigger"
            onClick={() => setJumpPaletteOpen(true)}
          >
            <Search />
            <span>Search</span>
            <kbd>⌘ / Ctrl K</kbd>
          </button>
          <a
            aria-label="Workspaces and backup status"
            className="header-mobile-secondary icon"
            href={WORKSPACE_LIST_PATH}
            onClick={(event) => followAppLink(event, openWorkspaceMenu)}
          >
            <Home />
          </a>
          <button
            aria-label="Share this view"
            className="header-mobile-secondary icon"
            onClick={() => void shareCurrentView()}
          >
            <Share2 />
          </button>
          <button
            aria-label={themeToggleLabel}
            className="header-mobile-secondary icon"
            onClick={() => selectTheme(
              appliedTheme === "dark" ? "light" : "dark",
            )}
            title={themeToggleLabel}
          >
            {appliedTheme === "dark" ? <Moon /> : <Sun />}
          </button>
          <AccountMenu
            accountState={{
              configured: backupConfigured,
              ready: authenticationReady,
              user: account,
            }}
            returnTo={canonicalPath ?? WORKSPACE_LIST_PATH}
            workspaceId={state.workspace.id}
          />
        </div>
      </header>
      {!showBackupMessage && <a
        className="mobile-sync-status"
        data-attention={syncStatus.state === "blocked" || syncStatus.offline
          ? "true"
          : undefined}
        href={backupReviewPath}
        onClick={backupReviewPath === WORKSPACE_LIST_PATH
          ? (event) => followAppLink(event, openWorkspaceMenu)
          : undefined}
      >
        <BackupStatusIcon presentation={syncStatus} />
        <span>{syncStatus.label}</span>
        <ChevronRight />
      </a>}
      {showBackupMessage && backupMessage && <section
        className="sync-error-banner"
        role="alert"
      >
        <AlertCircle />
        <span>
          <strong>{backupMessage.title}</strong>
          <small>{backupMessage.message}</small>
        </span>
        <a
          href={backupReviewPath}
          onClick={backupReviewPath === WORKSPACE_LIST_PATH
            ? (event) => followAppLink(event, openWorkspaceMenu)
            : undefined}
        >
          {backupMessage.action === "account"
            ? "Sign in again"
            : "Review backup"}
        </a>
        <button
          aria-label="Dismiss backup message"
          className="icon small"
          onClick={() => setDismissedBackupMessageKey(backupMessageKey)}
          type="button"
        >
          <X />
        </button>
      </section>}
      {showAccessMessage && readOnlyReason && <section
        className="workspace-read-only-banner"
        role={authorization?.status === "active" ? "status" : "alert"}
      >
        <Info />
        <span>
          <strong>{authorization?.status === "active" &&
              authorization.role === "viewer"
            ? "Viewer access"
            : "Read-only workspace"}</strong>
          <small>{readOnlyReason} You can browse, search, inspect, and export.</small>
        </span>
        <button
          aria-label="Dismiss workspace access message"
          className="icon small"
          onClick={() => setDismissedAccessMessageKey(accessMessageKey)}
          type="button"
        >
          <X />
        </button>
      </section>}
      {preferencesSessionOnly &&
        !preferenceStorageMessageDismissed &&
        <section className="preference-storage-banner" role="status">
        <Info />
        <span><strong>Preferences are session-only</strong><small>Theme, sidebar, and panel choices will reset after reload because browser preference storage is unavailable.</small></span>
        <button
          aria-label="Dismiss preference storage message"
          className="icon small"
          onClick={() => setPreferenceStorageMessageDismissed(true)}
          type="button"
        >
          <X />
        </button>
      </section>}
      {workspaceNotice &&
        <DismissibleWorkspaceNotice
          message={workspaceNotice}
          onDismiss={() => setWorkspaceNotice("")}
        />}
      {readOnly && view !== "access" && <ReadOnlyWorkspace
        inventoryItemId={validInventoryItemId}
        inventoryLocationId={validInventoryLocationId}
        onInventoryItemChange={(id) => {
          if (view === "plan" && id) {
            openGuidanceTarget("inventory", id);
            return;
          }
          changeInventoryItem(id);
        }}
        onInventoryLocationChange={changeInventoryLocation}
        onLocationChange={(id) => {
          if (view === "plan") {
            openGuidanceTarget("spaces", id);
            return;
          }
          selectLocation(id);
        }}
        onOpenWorkspaceMenu={openWorkspaceMenu}
        readOnlyReason={
          readOnlyReason ??
          "Editing is unavailable until workspace access can be confirmed."
        }
        selectedLocationId={current?.id ?? null}
        setTheme={selectTheme}
        state={state}
        theme={theme}
        view={view}
        viewer={
          authorization?.status === "active" &&
          authorization.role === "viewer"
        }
      />}
      {view === "access" && authorization?.kind === "server" &&
        <WorkspaceAccessController
          authorization={authorization}
          currentUserId={accountId}
          key={[
            state.workspace.id,
            accountId ?? "signed-out",
          ].join(":")}
          localUpdatedAt={localUpdatedAt}
          onAccessChange={setWorkspaceAccess}
          onOpenWorkspaceHub={openWorkspaceMenu}
          onRemoveLocal={removeWorkspace}
          returnTo={collaborationPath}
          workspaceId={state.workspace.id}
        />}
      {view === "access" && authorization?.kind !== "server" &&
        <section className="panel" role="status">
          <h2>Device-only workspace</h2>
          <p>Back up this workspace to a signed-in account before managing members or invitations.</p>
        </section>}
      {!readOnly && view === "capture" && <Capture
        commit={dispatch}
        current={current}
        demoIntro={
          directDemo &&
          state.workspace.id.startsWith("ws_demo")
        }
        focusEditorKey={
          guidanceTarget?.view === "capture"
            ? guidanceTarget.token
            : null
        }
        select={selectLocation}
        state={state}
      />}
      {!readOnly && view === "spaces" && <Spaces state={state} current={current} select={selectLocation} commit={dispatch} focusEditorKey={guidanceTarget?.view === "spaces" ? guidanceTarget.token : null} focusEditorSection={guidanceTarget?.view === "spaces" ? guidanceTarget.focus : undefined} />}
      {!readOnly && view === "inventory" && <Inventory state={state} commit={dispatch} editing={validInventoryItemId} editFocus={guidanceTarget?.view === "inventory" ? guidanceTarget.focus : undefined} locationFilter={validInventoryLocationId ?? ""} onEditingChange={changeInventoryItem} onLocationFilterChange={changeInventoryLocation} onOpenLocation={(id) => openGuidanceTarget("spaces", id)} />}
      {!readOnly && view === "plan" && <Planner state={state} commit={dispatch} openGuidanceTarget={openGuidanceTarget} />}
      {!readOnly && view === "activity" && <History state={state} commit={dispatch} />}
      {!readOnly && view === "settings" && <Preferences state={state} commit={dispatch} theme={theme} setTheme={selectTheme} openMenu={openWorkspaceMenu} returnTo={canonicalPath ?? tabPath("settings")} serverBacked={authorization?.kind === "server"} />}
    </main>
    {feedback && <output
      className="feedback-toast"
      data-tone={feedback.tone}
      role={feedback.tone === "error" ? "alert" : "status"}
    >
      <FeedbackIcon />
      <span>{feedback.message}</span>
      <button className="icon small" aria-label="Dismiss message" onClick={() => setFeedback(null)}><X /></button>
    </output>}
    {jumpPaletteOpen && <JumpPalette
      close={() => setJumpPaletteOpen(false)}
      open={jumpPaletteOpen}
      openItem={(id) => openGuidanceTarget("inventory", id)}
      openLocation={(id) => openGuidanceTarget("spaces", id)}
      openView={selectView}
      state={state}
    />}
    <ModalDialog
      onClose={() => setMobileMoreOpen(false)}
      open={mobileMoreOpen}
      returnFocusRef={mobileMoreTrigger}
      title="More"
    >
      <div className="mobile-more-dialog">
        <nav
          aria-label="More workspace destinations"
          className="mobile-more-destinations"
        >
          {phoneMoreNav.map((entry) => <Nav
            key={entry.id}
            {...entry}
            active={entry.id === view}
            href={tabPath(entry.id)}
            select={() => selectView(entry.id)}
          />)}
        </nav>
        <div className="mobile-more-actions">
          <a
            aria-label="Workspaces and backup status"
            className="mobile-more-action"
            href={WORKSPACE_LIST_PATH}
            onClick={(event) => {
              setMobileMoreOpen(false);
              followAppLink(event, openWorkspaceMenu);
            }}
          >
            <Home aria-hidden="true" />
            <span>
              <strong>Workspaces and backup status</strong>
              <small>{syncStatus.label}</small>
            </span>
          </a>
          <button
            aria-label="Share this view"
            className="mobile-more-action"
            onClick={() => {
              setMobileMoreOpen(false);
              void shareCurrentView();
            }}
            type="button"
          >
            <Share2 aria-hidden="true" />
            <span>
              <strong>Share this view</strong>
              <small>Copy or send this exact workspace link</small>
            </span>
          </button>
          <button
            aria-label={themeToggleLabel}
            className="mobile-more-action"
            onClick={() => {
              setMobileMoreOpen(false);
              selectTheme(appliedTheme === "dark" ? "light" : "dark");
            }}
            type="button"
          >
            {appliedTheme === "dark"
              ? <Moon aria-hidden="true" />
              : <Sun aria-hidden="true" />}
            <span>
              <strong>{appliedTheme === "dark" ? "Use light theme" : "Use dark theme"}</strong>
              <small>Change the appearance on this device</small>
            </span>
          </button>
        </div>
        <button
          className="mobile-more-close"
          onClick={() => setMobileMoreOpen(false)}
          type="button"
        >
          Close
        </button>
      </div>
    </ModalDialog>
    <nav aria-label="Primary workspace navigation" className="bottom">
      {phonePrimaryNav.map((entry) => <Nav
        key={entry.id}
        {...entry}
        active={entry.id === view}
        href={tabPath(entry.id)}
        select={() => selectView(entry.id)}
      />)}
      <button
        aria-current={PHONE_MORE_VIEWS.includes(view) ? "page" : undefined}
        aria-expanded={mobileMoreOpen}
        aria-haspopup="dialog"
        aria-label="More"
        className="mobile-more-trigger nav"
        data-active={PHONE_MORE_VIEWS.includes(view)}
        onClick={() => setMobileMoreOpen(true)}
        ref={mobileMoreTrigger}
        type="button"
      >
        <Menu aria-hidden="true" />
        <span>More</span>
      </button>
    </nav>
  </div>;
}

function followAppLink(
  event: React.MouseEvent<HTMLAnchorElement>,
  navigate: () => void,
) {
  if (
    event.button !== 0 ||
    event.metaKey ||
    event.ctrlKey ||
    event.shiftKey ||
    event.altKey
  ) return;
  event.preventDefault();
  navigate();
}

function isItemModalHistoryEntry(value: unknown): boolean {
  return Boolean(
    value &&
    typeof value === "object" &&
    "stowplan" in value &&
    value.stowplan === true &&
    "itemModal" in value &&
    value.itemModal === true,
  );
}

function updateBrowserHistory(
  path: string,
  mode: "push" | "replace",
  state = BROWSER_HISTORY_STATE,
): void {
  const method = mode === "push"
    ? window.History.prototype.pushState
    : window.History.prototype.replaceState;
  method.call(history, state, "", path);
}

function scrollAppToTop(): void {
  window.scrollTo({ left: 0, top: 0 });
  document.querySelector<HTMLElement>(".app-shell > main")?.scrollTo({
    left: 0,
    top: 0,
  });
}

function Brand() {
  return <div className="brand" aria-label="Stowplan"><b>S</b><span><strong>Stowplan</strong><small>Know where everything lives</small></span></div>;
}
function Nav({ label, icon: Icon, active, href, select }: { label: string; icon: typeof Boxes; active: boolean; href: string; select: () => void }) {
  return <a className="nav" data-active={active} aria-current={active ? "page" : undefined} href={href} title={label} onClick={(event) => followAppLink(event, select)}><Icon /><span>{label}</span></a>;
}

function Capture({ state, current, select, commit, demoIntro, focusEditorKey }: { state: WorkspaceState; current: Location | null; select: (id: string) => void; commit: Commit; demoIntro: boolean; focusEditorKey: number | null }) {
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
    requestAnimationFrame(() => {
      const row = Array.from(
        document.querySelectorAll<HTMLElement>(
          ".capture-location-row[data-location-id]",
        ),
      ).find((candidate) => candidate.dataset.locationId === location.id);
      const behavior = matchMedia("(prefers-reduced-motion: reduce)").matches
        ? "auto"
        : "smooth";
      row?.scrollIntoView({ behavior, block: "center" });
      row?.querySelector<HTMLButtonElement>(".queue-row")?.focus({
        preventScroll: true,
      });
    });
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
  const openContainerReview = (
    kind: ContainerReview["kind"],
    location: Location,
    trigger: HTMLElement,
  ) => {
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
      kind,
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
        `${current.name} has no recorded items. Use Known empty & next to record that observation.`,
        "info",
      );
      return;
    }
    openContainerReview(CONTAINER_REVIEW_KIND.EMPTY, current, trigger);
  };
  const markKnownEmpty = async (trigger: HTMLElement) => {
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
      openContainerReview(CONTAINER_REVIEW_KIND.KNOWN_EMPTY, current, trigger);
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
    if (
      !containerReview ||
      containerReview.kind !== CONTAINER_REVIEW_KIND.EMPTY
    ) {
      showFeedback("Use the separate Empty container action before removing records");
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
  const emptySpaceActions = !captureComplete &&
      items.length > 0 &&
      !hasNestedSpaces
    ? <details
        className="capture-empty-actions"
        onToggle={(event) => {
          const disclosure = event.currentTarget;
          if (
            !disclosure.open ||
            !matchMedia(STACKED_TOUCH_LAYOUT_QUERY).matches
          ) return;
          requestAnimationFrame(() => disclosure.scrollIntoView({
            behavior: matchMedia("(prefers-reduced-motion: reduce)").matches
              ? "auto"
              : "smooth",
            block: "end",
          }));
        }}
      >
        <summary>
          <PackageX aria-hidden="true" />
          <span>
            <strong>Contents no longer match?</strong>
            <small>Review empty-space actions</small>
          </span>
        </summary>
        <div className="capture-empty-actions-body">
          <p>Known empty records an observation and never removes item records. Empty container removes the listed records after confirmation when the physical contents are gone.</p>
          <div>
            <button
              className="known-empty-action"
              onClick={(event) => void markKnownEmpty(event.currentTarget)}
              type="button"
            >
              <PackageX />
              <span>Known empty & next</span>
            </button>
            <button
              className="danger"
              onClick={(event) => reviewEmptyContainer(event.currentTarget)}
              type="button"
            >
              <Trash2 />
              <span>Empty container</span>
            </button>
          </div>
        </div>
      </details>
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
      })}{!items.length && <Empty title={emptyItemsTitle} text={emptyItemsText} />}</div>{emptySpaceActions}<div className="finish">{captureComplete ? <button className="reopen-capture" onClick={() => void reopenCapture()}><RotateCcw /><span>Reopen capture</span></button> : <>{!hasNestedSpaces && items.length === 0 && <button className="known-empty-action" onClick={(event) => void markKnownEmpty(event.currentTarget)}><PackageX /><span>Known empty & next</span></button>}<button className="primary" onClick={() => void finish("counted")}><CheckCircle2 /><span>Counted & next</span></button></>}</div></> : <Empty title="Add your first space" text="Give a room, cabinet, box, or drawer the same code as its physical label." />}</section>;
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
            <p className="eyebrow">
              {containerReview.kind === CONTAINER_REVIEW_KIND.EMPTY
                ? "Destructive inventory action"
                : "Observation only"}
            </p>
            <h2 id="container-review-title">
              {containerReview.kind === CONTAINER_REVIEW_KIND.EMPTY
                ? "Empty container?"
                : "Known empty is unavailable"}
            </h2>
          </div>
          <button
            aria-label={containerReview.kind === CONTAINER_REVIEW_KIND.EMPTY
              ? "Close empty container review"
              : "Close known-empty review"}
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
          {containerReview.kind === CONTAINER_REVIEW_KIND.EMPTY
            ? <>
              This action removes the item records below from <strong>{containerReview.locationName}</strong> and marks the space known empty as one undoable change. Use it only after the physical contents are gone.
            </>
            : <>
              <strong>Known empty records an observation. It never removes item records.</strong>{" "}
              {containerReview.locationName} still has the records below, so nothing has changed. Move or remove them before recording the space as known empty. If their physical contents are already gone, close this review and use the separate Empty container action.
            </>}
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
            {containerReview.kind === CONTAINER_REVIEW_KIND.EMPTY
              ? "Keep records"
              : "Keep counting"}
          </button>
          {containerReview.kind === CONTAINER_REVIEW_KIND.EMPTY && <button
            className="danger"
            disabled={emptying}
            onClick={() => void emptyContainer()}
          >
            <Trash2 />
            {emptying ? "Emptying..." : "Empty container"}
          </button>}
        </footer>
      </section>
    </div>}
    {editing && state.items.find((item) => item.id === editing) && <ItemEditor item={state.items.find((item) => item.id === editing) as ItemRecord} state={state} commit={commit} close={() => setEditing(null)} />}
  </>;
}

function Spaces({ state, current, select, commit, focusEditorKey, focusEditorSection }: { state: WorkspaceState; current: Location | null; select: (id: string) => void; commit: Commit; focusEditorKey: number | null; focusEditorSection?: GuidanceFocus }) {
  const [compactPanel, setCompactPanel] = useState<CompactPanel>(
    focusEditorKey === null ? "primary" : "secondary",
  );
  const [editingItem, setEditingItem] = useState<string | null>(null);
  const [dragPayload, setDragPayload] = useState<DragPayload | null>(null);
  const [dragging, setDragging] = useState(false);
  const [dropCue, setDropCue] = useState<DropTarget | null>(null);
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());
  const inspector = useRef<HTMLElement | null>(null);
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
            aria-label={`Earlier ${location.name}`}
            disabled={index === 0}
            onClick={() => reorderLocation(location, -1)}
          >
            <ArrowUp />
            Earlier
          </button>
          <button
            type="button"
            aria-label={`Later ${location.name}`}
            disabled={index === siblings.length - 1}
            onClick={() => reorderLocation(location, 1)}
          >
            <ArrowDown />
            Later
          </button>
          <button
            type="button"
            aria-label={`Edit details for ${location.name}`}
            onClick={() => showInspector(location)}
          >
            <Edit3 />
            Edit details
          </button>
          <button
            type="button"
            aria-label={`Move ${location.name}`}
            onClick={(event) => openMoveDialog(
              location,
              event.currentTarget,
            )}
          >
            <GripVertical />
            Move
          </button>
        </div>}
        {children.length > 0 && !isCollapsed &&
          <div className="tree-children" role="list">
            {branch(location.id, depth + 1)}
          </div>}
      </div>;
    },
  );
  const removeLocation = (location: Location) => {
    const descendants = descendantIds(state, location.id);
    const locationIds = [location.id, ...descendants];
    const itemIds = state.items.filter((item) => locationIds.includes(item.locationId)).map((item) => item.id);
    if (confirm(`Delete ${location.name}, ${countLabel(descendants.length, "nested space")}, and ${countLabel(itemIds.length, "item record")}? The deletion is recorded in Activity and can be undone until a later conflicting edit.`)) {
      void perform(commit, { type: "location.delete", id: location.id, descendantIds: descendants, itemIds }, () => select(live.find((candidate) => !locationIds.includes(candidate.id))?.id ?? ""));
    }
  };

  const treePanel = <section className="panel tree-panel" data-dragging={dragging}><div className="title"><div><p className="eyebrow">Your physical hierarchy</p><h2>Rooms → cabinets → boxes</h2></div></div><div className="tree-tools"><details className="tree-add"><summary><Plus /><span>Add top-level space</span></summary><form onSubmit={(event) => submitForm(event, addRoot)}><LocationCreateFields defaultKind="room" existingCodes={live.map((location) => location.code)} kindLabel="Space type" namePlaceholder="Friendly name" /><button>Add top-level space</button></form></details><details className="tree-help"><summary><Info /><span>Move spaces</span></summary><p>Drag a handle onto the top, middle, or bottom of another row to place before, move inside, or place after. On touch, press the handle, slide, and release.</p></details></div><div className="root-drop" data-drop-target="root" data-drop-intent={dropCue?.kind === "root" ? "inside" : undefined} onDragOver={(event) => dragOver(event, { id: null, intent: "inside", kind: "root" })} onDrop={(event) => drop(event, { id: null, intent: "inside", kind: "root" })}>Drop here to make a top-level room or area</div><p className="mobile-tree-hint">Tap a space for move and edit actions.</p><div className="location-tree" role="list" aria-label="Space hierarchy">{branch(null)}</div>{archived.length > 0 && <details className="archived"><summary>{archived.length} archived</summary>{archived.map((location) => <div key={location.id}><span>{location.code} · {location.name}</span><button onClick={() => void perform(commit, { type: "location.archive", id: location.id, archived: false })}>Restore</button></div>)}</details>}</section>;
  const inspectorPanel = <section className="panel inspector" id="space-inspector" ref={inspector} tabIndex={-1} aria-label={current ? `Edit ${current.name}` : "Space editor"}>{current && <button type="button" className="mobile-back-to-hierarchy" onClick={() => focusTreeLocation(current.id)}>Back to hierarchy</button>}{current ? <LocationEditor key={current.id} state={state} location={current} commit={commit} select={select} reorder={reorderLocation} remove={() => removeLocation(current)} editItem={setEditingItem} moveByDrop={finishTouchDrop} requestHierarchyChange={requestHierarchyChange} setDragging={setDragging} startNativeDrag={startNativeDrag} endNativeDrag={endNativeDrag} /> : <Empty title="Select a space" text="Edit it, move it, or drop an item or container onto it." />}</section>;
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
    <HierarchyChangeDialogs controller={hierarchy} state={state} />
    {editingItem && state.items.find((item) => item.id === editingItem) && <ItemEditor item={state.items.find((item) => item.id === editingItem) as ItemRecord} state={state} commit={commit} close={() => setEditingItem(null)} />}
  </>;
}

function HierarchyChangeDialogs({
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

function LocationEditor({ state, location, commit, select, reorder, remove, editItem, moveByDrop, requestHierarchyChange, setDragging, startNativeDrag, endNativeDrag }: { state: WorkspaceState; location: Location; commit: Commit; select: (id: string) => void; reorder: (location: Location, direction: -1 | 1) => void; remove: () => void; editItem: (id: string) => void; moveByDrop: (payload: DragPayload, target: DropTarget) => void; requestHierarchyChange: (command: LocationHierarchyCommand, trigger?: HTMLElement | null) => Promise<boolean>; setDragging: (dragging: boolean) => void; startNativeDrag: (event: React.DragEvent, payload: DragPayload) => void; endNativeDrag: () => void }) {
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
        <label className="space-kind-field">Type<select name="kind" defaultValue={location.kind}>{kinds.map((kind) => <option key={kind}>{kind}</option>)}</select></label>
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
    <div className="inspector-actions">
      <button disabled={siblingIndex <= 0} onClick={() => reorder(location, -1)}><ArrowUp /> Earlier</button>
      <button disabled={siblingIndex < 0 || siblingIndex === siblings.length - 1} onClick={() => reorder(location, 1)}><ArrowDown /> Later</button>
      <button disabled={!canArchive} title={canArchive ? undefined : "Move, archive, or delete live contents and nested spaces first."} onClick={() => void perform(commit, { type: "location.archive", id: location.id, archived: true }, () => select(state.locations.find((candidate) => !candidate.archivedAt && candidate.id !== location.id)?.id ?? ""))}><Archive /> Archive</button>
      <button className="danger" onClick={remove}><Trash2 /> Delete subtree</button>
    </div>
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

function Inventory({ state, commit, editing, editFocus, locationFilter, onEditingChange, onLocationFilterChange, onOpenLocation }: { state: WorkspaceState; commit: Commit; editing: string | null; editFocus?: GuidanceFocus; locationFilter: string; onEditingChange: (id: string | null) => void; onLocationFilterChange: (id: string) => void; onOpenLocation: (id: string) => void }) {
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

function ItemEditor({ item, state, commit, close, focus }: { item: ItemRecord; state: WorkspaceState; commit: Commit; close: () => void; focus?: GuidanceFocus }) {
  const [message, setMessage] = useState("");
  const [recertificationReady, setRecertificationReady] = useState(false);
  const [recertifying, setRecertifying] = useState(false);
  const [reopenedLocationId, setReopenedLocationId] = useState<string | null>(
    null,
  );
  const dialog = useRef<HTMLElement | null>(null);
  const itemForm = useRef<HTMLFormElement | null>(null);
  const moveForm = useRef<HTMLFormElement | null>(null);
  const formBaseline = useRef({
    id: item.id,
    values: itemFormValues(item),
  });
  const closeRef = useRef(close);
  const initialFocus = useRef(focus);
  const recertificationPrompt = useRef<HTMLElement | null>(null);
  const destinationOptions = flattenLocationTree(state.locations.filter((location) => !location.archivedAt && location.id !== item.locationId));
  const currentLocation = locationPath(state.locations, item.locationId);
  const currentLocationLabel = currentLocation.length ? currentLocation.map((location) => location.name).join(" › ") : "Unplaced";
  const currentLocationRecord = state.locations.find(
    (location) => location.id === item.locationId,
  );
  const captureComplete = Boolean(
    currentLocationRecord &&
    COMPLETE_CAPTURE_STATUSES.has(currentLocationRecord.captureStatus),
  );
  const reopenedLocation = reopenedLocationId
    ? state.locations.find((location) => location.id === reopenedLocationId)
    : null;
  const hasPlacementRules = item.constraints.foodOnly || item.constraints.avoidWarmth || item.constraints.avoidHumidity || Boolean(item.constraints.keepTogether) || item.constraints.requiredTags.length > 0;
  const hasOrganizationDetails =
    item.category !== DEFAULT_ITEM_CATEGORY ||
    item.frequency !== DEFAULT_ITEM_FREQUENCY ||
    item.tags.length > 0 ||
    item.unit !== DEFAULT_ITEM_UNIT;
  useLayoutEffect(() => {
    const previous = formBaseline.current;
    const next = itemFormValues(item);
    formBaseline.current = { id: item.id, values: next };
    if (previous.id !== item.id) {
      itemForm.current?.reset();
      moveForm.current?.reset();
      return;
    }
    reconcileUntouchedFormControls(itemForm.current, previous.values, next);
    reconcileUntouchedFormControls(moveForm.current, previous.values, next);
  }, [item]);
  useEffect(() => { closeRef.current = close; }, [close]);
  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const previousBodyOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const focusables = () => [...(dialog.current?.querySelectorAll<HTMLElement>("button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), summary, a[href]") ?? [])].filter((element) => element.getClientRects().length > 0);
    const keyboard = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        closeRef.current();
        return;
      }
      if (event.key !== "Tab") return;
      const available = focusables();
      if (!available.length) return;
      const currentIndex = available.indexOf(document.activeElement as HTMLElement);
      const nextIndex = event.shiftKey
        ? (currentIndex <= 0 ? available.length - 1 : currentIndex - 1)
        : (currentIndex < 0 || currentIndex === available.length - 1 ? 0 : currentIndex + 1);
      event.preventDefault();
      available[nextIndex]?.focus();
    };
    const frame = requestAnimationFrame(() => {
      if (captureComplete) {
        dialog.current
          ?.querySelector<HTMLButtonElement>("[data-reopen-capture]")
          ?.focus();
        return;
      }
      const requestedFocus = initialFocus.current;
      const coarsePointer = matchMedia("(pointer: coarse)").matches;
      if (requestedFocus === "item_details") {
        const section = dialog.current?.querySelector<HTMLDetailsElement>(
          '[data-guidance-section="item_details"]',
        );
        if (section) section.open = true;
        section?.scrollIntoView({ block: "start" });
        if (coarsePointer) section?.querySelector<HTMLElement>("summary")?.focus({ preventScroll: true });
        else section?.querySelector<HTMLInputElement>('input[name="category"]')?.focus({ preventScroll: true });
        return;
      }
      if (requestedFocus === "item_capacity") {
        const section = dialog.current?.querySelector<HTMLDetailsElement>(
          '[data-guidance-section="item_capacity"]',
        );
        if (section) section.open = true;
        section?.scrollIntoView({ block: "start" });
        if (coarsePointer) section?.querySelector<HTMLElement>("summary")?.focus({ preventScroll: true });
        else section?.querySelector<HTMLInputElement>('input[name="width"]')?.focus({ preventScroll: true });
        return;
      }
      if (coarsePointer) dialog.current?.focus();
      else dialog.current?.querySelector<HTMLInputElement>('input[name="name"]')?.focus();
    });
    addEventListener("keydown", keyboard);
    return () => {
      cancelAnimationFrame(frame);
      removeEventListener("keydown", keyboard);
      document.body.style.overflow = previousBodyOverflow;
      setTimeout(() => {
        let remainingFrames = ITEM_EDITOR_FOCUS_RESTORE_FRAMES;
        const restoreFocus = () => {
          if (remainingFrames > 0) {
            remainingFrames -= 1;
            requestAnimationFrame(restoreFocus);
            return;
          }
          if (document.querySelector("[aria-modal='true'][role='dialog']")) {
            return;
          }
          const focusTarget = previous?.isConnected
            ? previous
            : document.querySelector<HTMLElement>("main");
          focusTarget?.focus({ preventScroll: true });
        };
        requestAnimationFrame(restoreFocus);
      }, 0);
    };
  }, [captureComplete]);
  useEffect(() => {
    if (!recertificationReady) return;
    const frame = requestAnimationFrame(() => {
      recertificationPrompt.current?.scrollIntoView({
        behavior: matchMedia("(prefers-reduced-motion: reduce)").matches
          ? "auto"
          : "smooth",
        block: "nearest",
      });
      recertificationPrompt.current
        ?.querySelector<HTMLButtonElement>("button")
        ?.focus({ preventScroll: true });
    });
    return () => cancelAnimationFrame(frame);
  }, [recertificationReady]);
  const save = async (data: FormData) => {
    try {
      const dimensions = optionalDimensions(data);
      await commit({ type: "item.update", id: item.id, changes: {
        name: String(data.get("name")), quantity: Number(data.get("quantity")), unit: String(data.get("unit")), category: String(data.get("category")), frequency: String(data.get("frequency")) as Frequency,
        tags: splitList(data.get("tags")), description: String(data.get("description")), dimensions,
        constraints: { avoidHumidity: data.get("avoidHumidity") === "on", avoidWarmth: data.get("avoidWarmth") === "on", foodOnly: data.get("foodOnly") === "on", keepTogether: String(data.get("keepTogether")).trim() || null, requiredTags: splitList(data.get("requiredTags")) },
      } });
      setMessage("Saved on this device.");
      if (reopenedLocationId) setRecertificationReady(true);
      return true;
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Could not save item");
      return false;
    }
  };
  const move = async (data: FormData) => {
    try {
      const destinationId = String(data.get("destination"));
      const destination = state.locations.find(
        (location) => location.id === destinationId,
      );
      await commit({ type: "item.move", id: item.id, destinationId, quantity: Number(data.get("moveQuantity")) });
      if (reopenedLocationId) {
        setMessage(`Moved to ${destination?.name ?? "the selected space"}.`);
        setRecertificationReady(true);
      } else {
        close();
      }
      return true;
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Could not move item");
      return false;
    }
  };
  const reopenCapture = async () => {
    if (!currentLocationRecord) return;
    const locationId = currentLocationRecord.id;
    const reopened = await perform(commit, {
      type: "capture.status",
      id: locationId,
      status: "in_progress",
    });
    if (!reopened) return;
    setReopenedLocationId(locationId);
    requestAnimationFrame(() => {
      requestAnimationFrame(() =>
        dialog.current?.querySelector<HTMLInputElement>('input[name="name"]')
          ?.focus()
      );
    });
  };
  const recertifyCapture = async () => {
    if (!reopenedLocation || recertifying) return;
    setRecertifying(true);
    const recertified = await perform(commit, {
      type: "capture.status",
      id: reopenedLocation.id,
      status: RECERTIFIED_CAPTURE_STATUS,
    });
    setRecertifying(false);
    if (recertified) close();
  };
  if (captureComplete && currentLocationRecord) {
    return <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) close(); }}>
      <section ref={dialog} tabIndex={-1} className="modal item-editor-modal item-editor-locked" role="dialog" aria-modal="true" aria-labelledby="item-editor-title">
        <header className="item-editor-header">
          <div><p className="eyebrow">Item details</p><h2 id="item-editor-title">Review item</h2><p>{item.name}</p></div>
          <button className="icon" aria-label="Close item editor" onClick={close}><X /></button>
        </header>
        <div className="item-editor-context" aria-label="Current item summary">
          <span><small>Amount</small><strong>{item.quantity} {item.unit}</strong></span>
          <span><small>Stored in</small><strong>{currentLocationLabel}</strong></span>
        </div>
        <div className="capture-locked capture-locked-action" role="status">
          <CheckCircle2 />
          <span><strong>{currentLocationRecord.name} is read-only</strong><small>Reopen capture to edit or move this record, then mark the space counted again here.</small></span>
          <button type="button" data-reopen-capture onClick={() => void reopenCapture()}><RotateCcw /> Reopen capture</button>
        </div>
      </section>
    </div>;
  }
  return <div
    className="modal-backdrop"
    onMouseDown={(event) => {
      if (event.target === event.currentTarget) close();
    }}
  >
    <section
      ref={dialog}
      tabIndex={-1}
      className="modal item-editor-modal"
      role="dialog"
      aria-modal="true"
      aria-labelledby="item-editor-title"
    >
      <header className="item-editor-header">
        <div>
          <p className="eyebrow">Item details</p>
          <h2 id="item-editor-title">Edit item</h2>
          <p>{item.name}</p>
        </div>
        <button className="icon" aria-label="Close item editor" onClick={close}>
          <X />
        </button>
      </header>
      <div className="item-editor-context" aria-label="Current item summary">
        <span><small>Amount</small><strong>{item.quantity} {item.unit}</strong></span>
        <span><small>Stored in</small><strong>{currentLocationLabel}</strong></span>
      </div>
      <div className="item-editor-layout">
        <form
          ref={itemForm}
          onSubmit={(event) => submitForm(event, save, false)}
          className="item-editor-form"
        >
          <section className="item-section item-essential">
            <div className="item-section-heading">
              <b>1</b>
              <span>
                <strong>What is it?</strong>
                <small>Name, quantity, and a searchable description.</small>
              </span>
            </div>
            <div className="item-core-grid">
              <label className="item-name-field">
                Item name
                <input
                  autoComplete="off"
                  required
                  name="name"
                  defaultValue={item.name}
                />
              </label>
              <label>
                Quantity
                <input
                  required
                  name="quantity"
                  type="number"
                  min="0.01"
                  step="any"
                  defaultValue={item.quantity}
                />
              </label>
              <label className="item-description-field">
                Description
                <textarea
                  name="description"
                  defaultValue={item.description}
                  placeholder="Color, condition, or other identifying details"
                />
              </label>
            </div>
          </section>
          <details
            className="item-advanced"
            data-guidance-section="item_details"
          >
            <summary>
              <span>
                <strong>More item details</strong>
                <small>Unit, category, frequency, and search tags.</small>
              </span>
              <b>{hasOrganizationDetails ? "Configured" : "Optional"}</b>
            </summary>
            <div className="item-advanced-body">
              <div className="item-organize-grid">
                <label>
                  Unit
                  <input required name="unit" defaultValue={item.unit} />
                </label>
                <label>
                  Category
                  <input
                    name="category"
                    defaultValue={item.category}
                    placeholder="e.g. Baking"
                  />
                </label>
                <label>
                  How often is it used?
                  <select name="frequency" defaultValue={item.frequency}>
                    {frequencies.map((frequency) =>
                      <option key={frequency}>{frequency}</option>
                    )}
                  </select>
                </label>
                <label className="wide">
                  Search tags
                  <input
                    name="tags"
                    defaultValue={item.tags.join(", ")}
                    placeholder="washable, seasonal, breakfast"
                  />
                  <small>Separate tags with commas.</small>
                </label>
              </div>
            </div>
          </details>
          <details className="item-advanced">
            <summary>
              <span>
                <strong>Placement requirements</strong>
                <small>Only add rules that affect where this item can safely live.</small>
              </span>
              <b>{hasPlacementRules ? "Configured" : "Optional"}</b>
            </summary>
            <div className="item-advanced-body">
              <div className="constraint-grid">
                <label>
                  <input
                    type="checkbox"
                    name="foodOnly"
                    defaultChecked={item.constraints.foodOnly}
                  />
                  <span><strong>Food-safe only</strong><small>Keep it out of unsuitable spaces.</small></span>
                </label>
                <label>
                  <input
                    type="checkbox"
                    name="avoidWarmth"
                    defaultChecked={item.constraints.avoidWarmth}
                  />
                  <span><strong>Avoid warmth</strong><small>Exclude warm cabinets or zones.</small></span>
                </label>
                <label>
                  <input
                    type="checkbox"
                    name="avoidHumidity"
                    defaultChecked={item.constraints.avoidHumidity}
                  />
                  <span><strong>Avoid humidity</strong><small>Prefer dry storage.</small></span>
                </label>
              </div>
              <div className="item-organize-grid">
                <label>
                  Keep-together group
                  <input
                    name="keepTogether"
                    defaultValue={item.constraints.keepTogether ?? ""}
                    placeholder="e.g. Coffee station"
                  />
                </label>
                <label>
                  Required location tags
                  <input
                    name="requiredTags"
                    defaultValue={item.constraints.requiredTags.join(", ")}
                    placeholder="cool, dark"
                  />
                </label>
              </div>
            </div>
          </details>
          <details
            className="item-advanced"
            data-guidance-section="item_capacity"
          >
            <summary>
              <span>
                <strong>Exact dimensions</strong>
                <small>Useful when Stowplan needs to reason about capacity.</small>
              </span>
              <b>{item.dimensions ? "Measured" : "Optional"}</b>
            </summary>
            <div className="item-advanced-body">
              <div className="dimension-grid">
                <label>Width<input name="width" type="number" min="0.01" step="any" defaultValue={item.dimensions?.width} /></label>
                <label>Height<input name="height" type="number" min="0.01" step="any" defaultValue={item.dimensions?.height} /></label>
                <label>Depth<input name="depth" type="number" min="0.01" step="any" defaultValue={item.dimensions?.depth} /></label>
                <label>Unit<select name="dimensionUnit" defaultValue={item.dimensions?.unit ?? "in"}><option>in</option><option>cm</option></select></label>
              </div>
            </div>
          </details>
          <footer className="item-save-bar">
            <span>
              <strong>Changes stay on this device first.</strong>
              <small>Server backup follows when available.</small>
            </span>
            <button className="primary">Save item</button>
          </footer>
        </form>
        <aside className="item-editor-rail">
          <form
            ref={moveForm}
            onSubmit={(event) => submitForm(event, move, false)}
            className="move-card"
          >
            <p className="eyebrow">Placement</p>
            <h3>Move all or part</h3>
            <p>Currently in <strong>{currentLocationLabel}</strong>.</p>
            <label>
              How many?
              <input
                required
                name="moveQuantity"
                type="number"
                min="0.01"
                max={item.quantity}
                step="any"
                defaultValue={item.quantity}
              />
            </label>
            <label>
              Move to
              <select required name="destination" defaultValue="">
                <option value="" disabled>Choose a space…</option>
                {destinationOptions.map(({ depth, location }) =>
                  <option key={location.id} value={location.id}>
                    {`${"  ".repeat(depth)}${depth ? "↳ " : ""}${location.code} · ${location.name}`}
                  </option>
                )}
              </select>
            </label>
            <button>Move quantity</button>
            <small>Moving fewer than {item.quantity} creates a separate record at the destination.</small>
          </form>
          <details className="item-danger">
            <summary>More actions</summary>
            <button
              type="button"
              className="danger"
              onClick={() => {
                if (confirm(`Delete ${item.name}? You can undo this from Activity.`)) {
                  void perform(
                    commit,
                    { type: "item.delete", id: item.id },
                    close,
                  );
                }
              }}
            >
              <Trash2 /> Delete item record
            </button>
            <small>Deletion is recorded in Activity and can be undone.</small>
          </details>
        </aside>
      </div>
      {recertificationReady && reopenedLocation && <section
        aria-live="polite"
        className="item-recertification"
        ref={recertificationPrompt}
      >
        <CheckCircle2 aria-hidden="true" />
        <span>
          <strong>{reopenedLocation.name} needs a fresh count</strong>
          <small>Confirm the physical contents now match this edited record.</small>
        </span>
        <button
          className="primary"
          disabled={recertifying}
          onClick={() => void recertifyCapture()}
          type="button"
        >
          {recertifying ? "Marking counted..." : "Mark counted again"}
        </button>
      </section>}
      {message && <output className="form-message item-editor-message">{message}</output>}
    </section>
  </div>;
}

function emptyPlanGuidance(readiness: PlanReadiness): string {
  if (readiness.primaryGap === "inventory") {
    return "Record at least one item so Stowplan has something to improve.";
  }
  if (readiness.primaryGap === "destinations") {
    return "Count at least two shelves, drawers, boxes, or cabinets so there is a trustworthy alternative destination.";
  }
  if (readiness.primaryGap === "count") {
    return "Finish the first-pass decision for the remaining spaces, then try again.";
  }
  if (readiness.primaryGap === "item_details") {
    return "Add categories or placement requirements to quick-captured items so Stowplan can distinguish what belongs together and where it is safe.";
  }
  if (readiness.primaryGap === "destination_details") {
    return "Review destination suitability, such as food safety, temperature, humidity, or useful tags.";
  }
  if (readiness.primaryGap === "capacity") {
    return "The arrangement may already be good. Add measurements where fit matters, or adjust the priorities.";
  }
  return "The current arrangement already scores as well as the available alternatives.";
}

function PlanningReadinessPanel({
  readiness,
  state,
  openGuidanceTarget,
}: {
  readiness: PlanReadiness;
  state: WorkspaceState;
  openGuidanceTarget: (
    view: GuidanceTarget["view"],
    id: string,
    focus?: GuidanceFocus,
  ) => void;
}) {
  const firstLiveLocation = state.locations.find(
    (location) => !location.archivedAt,
  )?.id ?? "";
  const headline = readiness.level === "needs_inventory"
    ? "Record inventory before trusting a plan"
    : readiness.level === "needs_destinations"
      ? "Count more possible destinations"
      : readiness.level === "ready"
        ? "Planning evidence is strong"
        : "Enough to try, with gaps to review";
  const issues: {
    action?: () => void;
    actionLabel?: string;
    detail: string;
    priority: "complete" | "optional" | "required" | "review";
    title: string;
  }[] = [];
  if (readiness.activeItemIds.length === 0) {
    issues.push({
      action: () => openGuidanceTarget("capture", firstLiveLocation),
      actionLabel: "Open Capture",
      detail: "The planner needs at least one live item record.",
      priority: "required",
      title: "Add something to organize",
    });
  }
  if (readiness.countedDestinationIds.length < 2) {
    issues.push({
      action: () => openGuidanceTarget(
        "capture",
        readiness.uncountedLocationIds[0] ?? firstLiveLocation,
      ),
      actionLabel: "Continue count",
      detail: "Shelves, drawers, boxes, bins, cabinets, and containers can receive planned moves.",
      priority: "required",
      title: "Count two possible destinations",
    });
  } else if (readiness.uncountedLocationIds.length > 0) {
    issues.push({
      action: () => openGuidanceTarget(
        "capture",
        readiness.uncountedLocationIds[0] as string,
      ),
      actionLabel: "Continue count",
      detail: "Mark each counted or known empty so missing information is not mistaken for an empty space.",
      priority: "review",
      title: `${readiness.uncountedLocationIds.length} space${readiness.uncountedLocationIds.length === 1 ? "" : "s"} still need a first-pass decision`,
    });
  }
  if (readiness.uncategorizedItemIds.length > 0) {
    issues.push({
      action: () => openGuidanceTarget(
        "inventory",
        readiness.uncategorizedItemIds[0] as string,
        "item_details",
      ),
      actionLabel: "Review an item",
      detail: "Add a category, use frequency, or placement rule where it changes the right home.",
      priority: "review",
      title: `${readiness.uncategorizedItemIds.length} item${readiness.uncategorizedItemIds.length === 1 ? "" : "s"} still use quick-capture defaults`,
    });
  }
  if (readiness.destinationsUsingDefaultsIds.length > 0) {
    issues.push({
      action: () => openGuidanceTarget(
        "spaces",
        readiness.destinationsUsingDefaultsIds[0] as string,
        "space_suitability",
      ),
      actionLabel: "Review a space",
      detail: "Review food safety, temperature, humidity, and tags only where they matter.",
      priority: "review",
      title: `${countLabel(readiness.destinationsUsingDefaultsIds.length, "counted destination")} ${readiness.destinationsUsingDefaultsIds.length === 1 ? "uses" : "use"} basic suitability defaults`,
    });
  }
  if (
    readiness.unmeasuredDestinationIds.length > 0 ||
    readiness.unmeasuredItemIds.length > 0
  ) {
    issues.push({
      action: () => readiness.unmeasuredDestinationIds.length
        ? openGuidanceTarget(
            "spaces",
            readiness.unmeasuredDestinationIds[0] as string,
            "space_capacity",
          )
        : openGuidanceTarget(
            "inventory",
            readiness.unmeasuredItemIds[0] as string,
            "item_capacity",
          ),
      actionLabel: "Review capacity",
      detail: `${readiness.unmeasuredDestinationIds.length} storage space${readiness.unmeasuredDestinationIds.length === 1 ? "" : "s"} and ${readiness.unmeasuredItemIds.length} item record${readiness.unmeasuredItemIds.length === 1 ? "" : "s"} lack dimensions. Measure only where fit is uncertain.`,
      priority: "optional",
      title: "Capacity remains partly unverified",
    });
  }
  if (issues.length === 0) {
    issues.push({
      detail: "Generate a plan and review every physical move before marking it complete.",
      priority: "complete",
      title: "No obvious evidence gaps",
    });
  }
  const renderIssue = (issue: typeof issues[number]) => <li
    data-priority={issue.priority}
    key={`${issue.priority}-${issue.title}`}
  >
    <span><strong>{issue.title}</strong><small>{issue.detail}</small></span>
    {issue.action && issue.actionLabel && <button onClick={issue.action}>{issue.actionLabel}</button>}
  </li>;
  return <section className="plan-readiness" aria-label="Planning readiness">
    <header>
      <div>
        <p className="eyebrow">Planning readiness</p>
        <h3 id="plan-readiness-title">{headline}</h3>
      </div>
      <span data-level={readiness.level}>
        {countLabel(readiness.countedDestinationIds.length, "counted destination")}
      </span>
    </header>
    <p>{readiness.canGenerateUsefulPlan
      ? "You can generate a plan now. Resolving the items below will make its reasoning easier to trust."
      : "Generation stays available, but the current evidence is too thin for a useful recommendation."}</p>
    <ul>{renderIssue(issues[0] as typeof issues[number])}</ul>
    {issues.length > 1 && <details className="plan-readiness-more">
      <summary>{issues.length - 1} more way{issues.length === 2 ? "" : "s"} to improve confidence</summary>
      <ul>{issues.slice(1).map(renderIssue)}</ul>
    </details>}
  </section>;
}

function Planner({ state, commit, openGuidanceTarget }: { state: WorkspaceState; commit: Commit; openGuidanceTarget: (view: GuidanceTarget["view"], id: string, focus?: GuidanceFocus) => void }) {
  const activePlans = state.plans.filter((plan) => plan.status === "active");
  const active = activePlans[0];
  const hasConflictingPlans = activePlans.length > 1;
  const readiness = useMemo(() => assessPlanReadiness(state), [state]);
  const [weights, setWeights] = useState<PlanWeights>({ ...DEFAULT_PLAN_WEIGHTS });
  const [name, setName] = useState("Suggested reset");
  const [message, setMessage] = useState("");
  const [nextMoveFocusRequest, setNextMoveFocusRequest] = useState(0);
  const [planOptionsOpen, setPlanOptionsOpen] = useState(false);
  const nextMoveAction = useRef<HTMLButtonElement | null>(null);
  const nextMoveCard = useRef<HTMLElement | null>(null);
  const generate = async () => {
    const plan = buildMovePlan(state, { name, weights });
    if (!plan.steps.length) {
      setMessage("No beneficial moves were found.");
      return;
    }
    try {
      await commit({ type: "plan.create", plan });
      setMessage(`${plan.steps.length} explainable ${plan.steps.length === 1 ? "move" : "moves"} added to the new plan.`);
      setNextMoveFocusRequest((request) => request + 1);
      setPlanOptionsOpen(false);
    } catch (error) { setMessage(error instanceof Error ? error.message : "Could not create the plan"); }
  };
  const updateWeight = (key: keyof PlanWeights, value: number) => setWeights((current) => ({ ...current, [key]: value }));
  const complete = active?.steps.filter((step) => step.completedAt).length ?? 0;
  const nextStepIndex = active?.steps.findIndex((step) => !step.completedAt) ?? -1;
  const nextStep = nextStepIndex >= 0
    ? active?.steps[nextStepIndex] ?? null
    : null;
  const nextStepId = nextStep?.id ?? null;
  const placeLabel = (locationId: string) => {
    const path = locationPath(state.locations, locationId);
    return path.length ? path.map((location) => `${location.code} · ${location.name}`).join(" › ") : "Unknown space";
  };
  const subjectForStep = (step: PlanStep) => {
    const item = step.itemId
      ? state.items.find((candidate) => candidate.id === step.itemId)
      : null;
    const container = step.locationId
      ? state.locations.find((candidate) => candidate.id === step.locationId)
      : null;
    return {
      container,
      item,
      label: item
        ? `${step.quantity ?? item.quantity} ${item.unit} of ${item.name}`
        : container?.name ?? "container",
    };
  };
  const capacityIsUnverified = (step: PlanStep) => step.explanation.some(
    (reason) =>
      reason.includes("capacity is unmeasured") ||
      reason.includes("capacity cannot be verified"),
  );
  const completeStep = async (step: PlanStep) => {
    if (!active) return;
    const completesPlan = active.steps.filter(
      (candidate) => !candidate.completedAt,
    ).length === 1;
    const moved = await perform(commit, {
      type: "plan.step.complete",
      planId: active.id,
      stepId: step.id,
    });
    if (!moved) return;
    if (completesPlan) setMessage("");
    else setNextMoveFocusRequest((request) => request + 1);
  };
  useEffect(() => {
    if (!nextMoveFocusRequest || !nextStepId) return;
    let focusFrame = 0;
    const renderFrame = requestAnimationFrame(() => {
      focusFrame = requestAnimationFrame(() => {
        const card = nextMoveCard.current;
        if (!card) return;
        card.scrollIntoView({
          behavior: matchMedia("(prefers-reduced-motion: reduce)").matches
            ? "auto"
            : "smooth",
          block: "start",
        });
        card.focus({ preventScroll: true });
      });
    });
    return () => {
      cancelAnimationFrame(renderFrame);
      cancelAnimationFrame(focusFrame);
    };
  }, [nextMoveFocusRequest, nextStepId]);
  const keepNextActionVisible = (
    event: React.SyntheticEvent<HTMLDetailsElement>,
  ) => {
    if (!event.currentTarget.open) return;
    nextMoveAction.current?.scrollIntoView({
      block: "center",
      inline: "nearest",
    });
  };
  const nextSubject = nextStep ? subjectForStep(nextStep) : null;
  const nextItemId = nextSubject?.item?.id ?? null;
  const nextContainerId = nextSubject?.container?.id ?? null;
  const plannerHero = <section
    className="panel planner-hero"
    data-has-active={active ? "true" : undefined}
    data-open={!active || planOptionsOpen ? "true" : undefined}
  >
    <button
      aria-expanded={planOptionsOpen}
      className="planner-options-summary"
      onClick={() => setPlanOptionsOpen((open) => !open)}
      type="button"
    >
      <span>
        <strong>{active ? "Plan options" : "Create a move plan"}</strong>
        <small>{active
          ? "Priorities, readiness, replace, or discard"
          : "Generate now or review the available evidence"}</small>
      </span>
      <ChevronDown aria-hidden="true" />
    </button>
    <div className="planner-hero-body">
      <div className="planner-overview">
        <p className="eyebrow">Explainable recommendations</p>
        <h2>Fewer moves, better homes.</h2>
        <div className="plan-actions">
          <button className="primary" onClick={() => void generate()}>
            {active ? "Replace with fresh plan" : "Generate move plan"}
          </button>
          {active && !hasConflictingPlans && <button onClick={() => void perform(
            commit,
            { type: "plan.status", planId: active.id, status: "discarded" },
            () => setMessage(""),
          )}>
            Discard current plan
          </button>}
        </div>
        {message && <output className="form-message">{message}</output>}
        <p>Balance suitability, access, grouping, capacity, and move effort, including moving a whole nested box when that is simpler. Marking a step moved updates Inventory immediately; Activity can undo it.</p>
      </div>
      <details className="plan-settings">
        <summary>Plan priorities</summary>
        <label>Plan name<input autoComplete="off" name="planName" value={name} onChange={(event) => setName(event.target.value)} /></label>
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
      <PlanningReadinessPanel readiness={readiness} state={state} openGuidanceTarget={openGuidanceTarget} />
    </div>
  </section>;
  return <div className="content">
    {hasConflictingPlans && <section className="panel form-message" role="alert"><h3>Resolve overlapping active plans</h3><p>This older workspace contains {activePlans.length} active plans. Generate a fresh plan to replace all of them, or discard plans until one remains before executing a move.</p>{activePlans.map((plan) => <button key={plan.id} onClick={() => void perform(commit, { type: "plan.status", planId: plan.id, status: "discarded" })}>Discard {plan.name}</button>)}</section>}
    {active && !hasConflictingPlans && nextStep && nextSubject ? <>
      <div className="plan-progress"><strong>{active.name}</strong><span>{complete} of {active.steps.length} complete</span></div>
      <section
        aria-label="Next move"
        className="panel plan-next-move"
        data-step-id={nextStep.id}
        ref={nextMoveCard}
        tabIndex={-1}
      >
        <header>
          <div>
            <p className="eyebrow">Next move</p>
            <h3>Move {nextSubject.label}</h3>
          </div>
          <b>Step {nextStepIndex + 1} of {active.steps.length}</b>
        </header>
        <p className="plan-route">{placeLabel(nextStep.sourceId)} → {placeLabel(nextStep.destinationId)}</p>
        <button
          className="primary plan-next-action"
          data-step-state="ready"
          onClick={() => void completeStep(nextStep)}
          ref={nextMoveAction}
        >
          Mark moved
        </button>
        <details
          className="plan-step-support"
          onToggle={keepNextActionVisible}
        >
          <summary>Why this move and review details</summary>
          <div>
            {capacityIsUnverified(nextStep) && <em className="plan-confidence">Capacity unverified</em>}
            <p>{nextStep.explanation.join(" · ")}</p>
            <p className="plan-review-note">Review links do not move anything. Saving changed item or destination details discards this plan so the next plan uses the corrected evidence.</p>
            <div className="plan-review-actions">
              {nextItemId && <button onClick={() => openGuidanceTarget("inventory", nextItemId)}>Review item</button>}
              {nextContainerId && <button onClick={() => openGuidanceTarget("spaces", nextContainerId)}>Review container</button>}
              <button onClick={() => openGuidanceTarget("spaces", nextStep.destinationId)}>Review destination</button>
            </div>
          </div>
        </details>
      </section>
      <details className="panel plan-itinerary">
        <summary>Review full plan <span>{countLabel(active.steps.length, "move")}</span></summary>
        <ol>{active.steps.map((step, index) => {
          const subject = subjectForStep(step);
          const status = step.completedAt
            ? "Moved"
            : index === nextStepIndex
              ? "Next"
              : "Upcoming";
          return <li data-status={status.toLowerCase()} key={step.id}>
            <b>{index + 1}</b>
            <span>
              <strong>Move {subject.label}</strong>
              <small>{placeLabel(step.sourceId)} → {placeLabel(step.destinationId)}</small>
            </span>
            <em>{status}</em>
          </li>;
        })}</ol>
      </details>
    </> : null}
    {plannerHero}
    {(!active || hasConflictingPlans || !nextStep || !nextSubject) && <Empty title="No active plan" text={readiness.canGenerateUsefulPlan ? "There is enough evidence to try a plan. Review the readiness guidance, then generate when you are comfortable with the gaps." : emptyPlanGuidance(readiness)} />}
  </div>;
}
function History({ state, commit }: { state: WorkspaceState; commit: Commit }) {
  return <ActivityHistory
    onCommand={(command) => perform(commit, command)}
    state={state}
  />;
}
function Preferences({ state, commit, theme, setTheme, openMenu, returnTo, serverBacked }: { state: WorkspaceState; commit: Commit; theme: ThemePreference; setTheme: (theme: ThemePreference) => void; openMenu: () => void; returnTo: string; serverBacked: boolean }) {
  const [backupToolsOpen, setBackupToolsOpen] = useState(false);
  const [helpToolsOpen, setHelpToolsOpen] = useState(false);
  const workspaceNameBaseline = useRef({
    id: state.workspace.id,
    name: state.workspace.name,
  });
  const [workspaceNameDraft, setWorkspaceNameDraft] = useState(
    state.workspace.name,
  );
  useEffect(() => {
    const previous = workspaceNameBaseline.current;
    workspaceNameBaseline.current = {
      id: state.workspace.id,
      name: state.workspace.name,
    };
    setWorkspaceNameDraft((current) =>
      previous.id !== state.workspace.id || current === previous.name
        ? state.workspace.name
        : current
    );
  }, [state.workspace.id, state.workspace.name]);
  const download = () => {
    let url: string | null = null;
    try {
      const anchor = document.createElement("a");
      url = URL.createObjectURL(
        new Blob(
          [JSON.stringify(state, null, 2)],
          { type: "application/json" },
        ),
      );
      anchor.href = url;
      anchor.download = `stowplan-${state.workspace.id}.json`;
      anchor.click();
    } catch (error) {
      showFeedback(
        `Could not export this workspace: ${
          error instanceof Error ? error.message : "browser download failed"
        }`,
      );
    } finally {
      if (url) URL.revokeObjectURL(url);
    }
  };
  return <div className="content settings">
    <section className="panel">
      <h2>Workspace</h2>
      <form className="workspace-rename" onSubmit={(event) => submitForm(event, (data) => perform(commit, { type: "workspace.rename", name: String(data.get("workspaceName")) }), false)}>
        <label>Workspace name<input required maxLength={80} name="workspaceName" value={workspaceNameDraft} onChange={(event) => setWorkspaceNameDraft(event.currentTarget.value)} /></label>
        <button>Rename workspace</button>
      </form>
      <p className="muted settings-workspace-help">Switch workspaces, inspect backup status, or manage device copies.</p>
      <a className="settings-workspaces-link" href={WORKSPACE_LIST_PATH} onClick={(event) => followAppLink(event, openMenu)}><Home /> Workspaces and backup status</a>
      {serverBacked && <a href={workspacePath({ view: "access", workspaceId: state.workspace.id, workspaceLabel: state.workspace.name })}>Workspace access</a>}
      <h2>Appearance</h2>
      <div className="segments">{(["system", "light", "dark"] as const).map((entry) => <button aria-pressed={theme === entry} data-active={theme === entry} key={entry} onClick={() => setTheme(entry)}>{entry}</button>)}</div>
      <div className="settings-disclosure" data-open={backupToolsOpen ? "true" : undefined}>
        <button
          aria-expanded={backupToolsOpen}
          className="settings-disclosure-trigger"
          onClick={() => setBackupToolsOpen((open) => !open)}
          type="button"
        >
          <span><strong>Backup & recovery</strong><small>Export, restore, and print labels</small></span>
          <ChevronDown aria-hidden="true" />
        </button>
        <div className="settings-disclosure-body">
          <h2>Backup & recovery</h2>
          <p className="muted">Export a complete portable snapshot. Imports are validated and previewed before replacement.</p>
          <button onClick={download}>Export JSON backup</button>
          <a href="/recovery">Review sync issues or restore a backup</a>
          <a href="/labels">Print text and QR labels</a>
        </div>
      </div>
    </section>
    <section className="panel">
      <h2>Account & server backup</h2>
      <a href={`/account?workspace=${encodeURIComponent(state.workspace.id)}&returnTo=${encodeURIComponent(returnTo)}`}>Sign in or review this account</a>
      <div className="settings-disclosure" data-open={helpToolsOpen ? "true" : undefined}>
        <button
          aria-expanded={helpToolsOpen}
          className="settings-disclosure-trigger"
          onClick={() => setHelpToolsOpen((open) => !open)}
          type="button"
        >
          <span><strong>Help & source</strong><small>Guides, repository, and license</small></span>
          <ChevronDown aria-hidden="true" />
        </button>
        <div className="settings-disclosure-body">
          <h2>Help & source</h2>
          <a target="_blank" rel="noreferrer" href={USER_GUIDE_URL}>Open full user guide</a>
          <a href="/docs/">Read the offline quick guide</a>
          <a target="_blank" rel="noreferrer" href={SOURCE_REPOSITORY_URL}>View source repository</a>
          <p className="license">A Strange Lasers project<br />AGPL-3.0-only<br />Copyright © 2026 James Klein (j-256)</p>
        </div>
      </div>
    </section>
  </div>;
}
function Empty({ title, text }: { title: string; text: string }) {
  return <div className="empty"><b>□</b><h3>{title}</h3><p>{text}</p></div>;
}
