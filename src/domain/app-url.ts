export const DEFAULT_WORKSPACE_VIEW = "capture";
export const WORKSPACE_LIST_PATH = "/workspaces";
export const WORKSPACE_VIEWS = Object.freeze([
  "capture",
  "spaces",
  "inventory",
  "plan",
  "activity",
  "settings",
] as const);

export type WorkspaceView = (typeof WORKSPACE_VIEWS)[number];

export type AppRoute =
  | { kind: "home" }
  | { kind: "workspace-list" }
  | {
      itemId: string | null;
      kind: "workspace";
      locationId: string | null;
      view: WorkspaceView;
      workspaceId: string;
    };

interface WorkspacePathInput {
  itemId?: string | null;
  locationId?: string | null;
  view: WorkspaceView;
  workspaceId: string;
}

const WORKSPACE_PATH_SEGMENT = "workspaces";
const LOCATION_PATH_SEGMENT = "locations";
const ITEM_PATH_SEGMENT = "items";
const WORKSPACE_VIEW_SET = new Set<string>(WORKSPACE_VIEWS);
const PARSE_BASE_URL = "https://stowplan.invalid";

function decodedSegment(segment: string | undefined): string | null {
  if (!segment) return null;
  try {
    const decoded = decodeURIComponent(segment);
    return decoded.trim() ? decoded : null;
  } catch {
    return null;
  }
}

function encodedSegment(segment: string, label: string): string {
  if (!segment.trim()) throw new Error(`${label} is required`);
  return encodeURIComponent(segment);
}

function workspaceView(value: string | null | undefined): WorkspaceView {
  return value && WORKSPACE_VIEW_SET.has(value)
    ? value as WorkspaceView
    : DEFAULT_WORKSPACE_VIEW;
}

function workspaceRoute(
  workspaceId: string,
  view: WorkspaceView,
  detailType?: string,
  detailId?: string,
): AppRoute {
  const decodedDetail = decodedSegment(detailId);
  const locationId =
    decodedDetail &&
    detailType === LOCATION_PATH_SEGMENT &&
    (view === "capture" || view === "spaces" || view === "inventory")
      ? decodedDetail
      : null;
  const itemId =
    decodedDetail &&
    detailType === ITEM_PATH_SEGMENT &&
    view === "inventory"
      ? decodedDetail
      : null;
  return {
    itemId,
    kind: "workspace",
    locationId,
    view,
    workspaceId,
  };
}

export function workspacePath({
  itemId,
  locationId,
  view,
  workspaceId,
}: WorkspacePathInput): string {
  const base =
    `${WORKSPACE_LIST_PATH}/${encodedSegment(workspaceId, "Workspace ID")}/${view}`;
  if (view === "inventory" && itemId) {
    return `${base}/${ITEM_PATH_SEGMENT}/${encodedSegment(itemId, "Item ID")}`;
  }
  if (
    locationId &&
    (view === "capture" || view === "spaces" || view === "inventory")
  ) {
    return `${base}/${LOCATION_PATH_SEGMENT}/${encodedSegment(locationId, "Location ID")}`;
  }
  return base;
}

export function parseAppUrl(input: string | URL): AppRoute {
  const url = input instanceof URL ? input : new URL(input, PARSE_BASE_URL);
  const segments = url.pathname.split("/").filter(Boolean);

  if (segments.length === 1 && segments[0] === WORKSPACE_PATH_SEGMENT) {
    return { kind: "workspace-list" };
  }

  if (segments[0] === WORKSPACE_PATH_SEGMENT) {
    const workspaceId = decodedSegment(segments[1]);
    if (!workspaceId) return { kind: "workspace-list" };
    return workspaceRoute(
      workspaceId,
      workspaceView(segments[2]),
      segments[3],
      segments[4],
    );
  }

  const legacyWorkspaceId = url.searchParams.get("workspace")?.trim();
  if (!legacyWorkspaceId) return { kind: "home" };
  const view = workspaceView(url.searchParams.get("view"));
  const legacyLocationId =
    view === "inventory"
      ? url.searchParams.get("location")
      : url.searchParams.get("container");
  const legacyItemId =
    view === "inventory"
      ? url.searchParams.get("item")
      : null;
  return {
    itemId: legacyItemId?.trim() || null,
    kind: "workspace",
    locationId: legacyLocationId?.trim() || null,
    view,
    workspaceId: legacyWorkspaceId,
  };
}

export function workspaceReturnTo(
  requested: string | null | undefined,
  workspaceId: string,
): string {
  const fallback = workspacePath({
    view: DEFAULT_WORKSPACE_VIEW,
    workspaceId,
  });
  if (!requested?.startsWith("/")) return fallback;
  try {
    const url = new URL(requested, PARSE_BASE_URL);
    if (url.origin !== PARSE_BASE_URL) return fallback;
    const route = parseAppUrl(url);
    if (route.kind !== "workspace" || route.workspaceId !== workspaceId) {
      return fallback;
    }
    return workspacePath({
      itemId: route.itemId,
      locationId: route.locationId,
      view: route.view,
      workspaceId,
    });
  } catch {
    return fallback;
  }
}
