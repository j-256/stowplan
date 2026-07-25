export const DEFAULT_WORKSPACE_VIEW = "capture";
export const INVITATION_OAUTH_RESUME_PATH =
  "/account?resume=invitation";
export const WORKSPACE_LIST_PATH = "/workspaces";
export const WORKSPACE_VIEWS = Object.freeze([
  "capture",
  "spaces",
  "inventory",
  "plan",
  "activity",
  "settings",
  "access",
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
  itemLabel?: string | null;
  locationId?: string | null;
  locationLabel?: string | null;
  view: WorkspaceView;
  workspaceId: string;
  workspaceLabel?: string | null;
}

const IDENTIFIER_SEPARATOR = "@";
const MAX_ROUTE_SLUG_LENGTH = 64;
const WORKSPACE_PATH_SEGMENT = "workspaces";
const LOCATION_PATH_SEGMENT = "locations";
const ITEM_PATH_SEGMENT = "items";
const WORKSPACE_VIEW_SET = new Set<string>(WORKSPACE_VIEWS);
const PARSE_BASE_URL = "https://stowplan.invalid";
const RETURN_TO_DECODE_PASSES = 4;

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

function identifierSegment(segment: string | undefined): string | null {
  if (!segment) return null;
  const separator = segment.indexOf(IDENTIFIER_SEPARATOR);
  return decodedSegment(
    separator >= 0 ? segment.slice(separator + 1) : segment,
  );
}

function identifierLabel(
  segment: string | undefined,
): string | null | undefined {
  if (!segment) return undefined;
  const separator = segment.indexOf(IDENTIFIER_SEPARATOR);
  return separator >= 0
    ? decodedSegment(segment.slice(0, separator))
    : undefined;
}

function readableSlug(value: string, fallback: string): string {
  const normalized = value
    .normalize("NFKD")
    .toLowerCase()
    .replace(/\p{Mark}/gu, "")
    .replace(/[^\p{Letter}\p{Number}]+/gu, "-")
    .replace(/^-+|-+$/gu, "");
  const shortened = [...normalized]
    .slice(0, MAX_ROUTE_SLUG_LENGTH)
    .join("")
    .replace(/-+$/u, "");
  return shortened || fallback;
}

function labeledSegment(
  id: string,
  label: string | null | undefined,
  fallback: string,
): string {
  const encodedId = encodedSegment(id, `${fallback} ID`);
  if (label === undefined) return encodedId;
  return `${
    encodeURIComponent(readableSlug(label ?? "", fallback))
  }${IDENTIFIER_SEPARATOR}${encodedId}`;
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
  const decodedDetail = identifierSegment(detailId);
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
  itemLabel,
  locationId,
  locationLabel,
  view,
  workspaceId,
  workspaceLabel,
}: WorkspacePathInput): string {
  const base =
    `${WORKSPACE_LIST_PATH}/${
      labeledSegment(workspaceId, workspaceLabel, "workspace")
    }/${view}`;
  if (view === "inventory" && itemId) {
    return `${base}/${ITEM_PATH_SEGMENT}/${
      labeledSegment(itemId, itemLabel, "item")
    }`;
  }
  if (
    locationId &&
    (view === "capture" || view === "spaces" || view === "inventory")
  ) {
    return `${base}/${LOCATION_PATH_SEGMENT}/${
      labeledSegment(locationId, locationLabel, "location")
    }`;
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
    const workspaceId = identifierSegment(segments[1]);
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
    const segments = url.pathname.split("/").filter(Boolean);
    const readablePath = segments[0] === WORKSPACE_PATH_SEGMENT;
    const detailLabel = readablePath
      ? identifierLabel(segments[4])
      : undefined;
    return workspacePath({
      itemId: route.itemId,
      itemLabel: route.itemId ? detailLabel : undefined,
      locationId: route.locationId,
      locationLabel: route.locationId ? detailLabel : undefined,
      view: route.view,
      workspaceId,
      workspaceLabel: readablePath
        ? identifierLabel(segments[1])
        : undefined,
    });
  } catch {
    return fallback;
  }
}

export function oauthReturnTo(
  requested: string | null | undefined,
): string {
  if (!requested?.startsWith("/")) return "/";
  try {
    const resolved = new URL(requested, PARSE_BASE_URL);
    if (resolved.origin !== PARSE_BASE_URL) return "/";
    let decoded = requested;
    for (
      let pass = 0;
      pass < RETURN_TO_DECODE_PASSES;
      pass += 1
    ) {
      if (decoded.toLowerCase().includes("/guest/")) {
        return INVITATION_OAUTH_RESUME_PATH;
      }
      const next = decodeURIComponent(decoded);
      if (next === decoded) break;
      decoded = next;
    }
    if (decoded.toLowerCase().includes("/guest/")) {
      return INVITATION_OAUTH_RESUME_PATH;
    }
    return `${resolved.pathname}${resolved.search}${resolved.hash}`;
  } catch {
    return "/";
  }
}
