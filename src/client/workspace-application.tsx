"use client";

import { useRouter } from "next/navigation";
import {
  type MouseEvent,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import {
  Activity,
  AlertCircle,
  Boxes,
  CheckCircle2,
  ChevronRight,
  CircleDashed,
  ClipboardList,
  HardDrive,
  Home,
  Info,
  Map as MapIcon,
  Menu,
  Moon,
  PackagePlus,
  Search,
  Settings,
  Share2,
  ShieldCheck,
  Sun,
  WifiOff,
  X,
} from "lucide-react";
import { createDemoState } from "../domain/demo";
import {
  createEmptyState,
  newId,
} from "../domain/factories";
import type { WorkspaceState } from "../domain/types";
import {
  normalizeWorkspaceAccessState,
  workspaceReadOnlyReason,
} from "../domain/workspace-access";
import {
  accountContextHeaders,
  responseMatchesAccount,
} from "../shared/account-context";
import {
  parseAppUrl,
  WORKSPACE_LIST_PATH,
  type AppRoute,
  type WorkspaceView,
} from "../domain/app-url";
import { listWorkspaceReplicas, readWorkspaceReplica } from "./local-replica";
import { JumpPalette } from "./jump-palette";
import { ModalDialog } from "./modal-dialog";
import {
  STOWPLAN_HISTORY_EVENT,
  STOWPLAN_HISTORY_OWNER_ATTRIBUTE,
} from "./browser-history-bridge";
import { AccountMenu } from "./account-menu";
import {
  ApplicationNavigationLink,
  ApplicationShell,
  ApplicationThemeToggle,
  PreferenceStorageBanner,
  type ApplicationNavigationItem,
} from "./application-shell";
import { useApplicationShellPreferences } from "./application-shell-preferences";
import {
  backupNotice,
  backupPresentation,
  type BackupPresentation,
} from "./backup-presentation";
import { ReadOnlyWorkspace } from "./read-only-workspace";
import { parseAuthorizedRecoverySnapshot } from "./recovery-permissions";
import { useStowplan, WorkspaceOpenError } from "./store";
import { WorkspaceHub } from "./workspace-hub";
import { WorkspaceAccessController } from "./workspace-access-controller";
import { Capture } from "./capture-view";
import { Inventory } from "./inventory-view";
import { Planner } from "./planner-view";
import { Spaces } from "./spaces-view";
import {
  History,
  Preferences,
} from "./workspace-preferences";
import {
  COMPLETE_CAPTURE_STATUSES,
  followAppLink,
  formatTimestamp,
  responseError,
  SEARCH_BLOCKED_EVENT,
  showFeedback,
  stateWorkspacePath,
} from "./workspace-view-helpers";
import type {
  FeedbackDetail,
  GuidanceFocus,
  GuidanceTarget,
} from "./workspace-view-types";

type View = WorkspaceView;
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

const BROWSER_HISTORY_STATE = Object.freeze({ stowplan: true });
const ITEM_MODAL_HISTORY_STATE = Object.freeze({
  ...BROWSER_HISTORY_STATE,
  itemModal: true,
});

const DISMISS_FEEDBACK_EVENT = "stowplan:feedback-dismiss";
const FEEDBACK_EVENT = "stowplan:feedback";
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
export function WorkspaceApplication({
  directDemo,
}: {
  directDemo: boolean;
}) {
  const router = useRouter();
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
  const {
    appliedTheme,
    preferenceStorageMessageDismissed,
    preferencesSessionOnly,
    selectTheme,
    setPreferenceStorageMessageDismissed,
    setSidebarCollapsed,
    sidebarCollapsed,
    theme,
  } = useApplicationShellPreferences();
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

  useEffect(() => {
    if ("serviceWorker" in navigator) navigator.serviceWorker.register("/sw.js").catch(() => undefined);
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
        router.push(`/account?returnTo=${encodeURIComponent(returnTo)}`);
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
    router,
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
    router.push("/recovery");
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
  const tabPath = (nextView: View) => state
    ? stateWorkspacePath(state, {
        locationId:
          nextView === "capture" || nextView === "spaces"
            ? current?.id
            : nextView === "inventory"
              ? validInventoryLocationId
              : null,
        view: nextView,
      })
    : WORKSPACE_LIST_PATH;
  const selectView = (nextView: View) => {
    if (!state) return;
    setGuidanceTarget(null);
    setInventoryItemId(null);
    setView(nextView);
    setMobileMoreOpen(false);
    setShowWelcome(false);
    setRouteStatus("ready");
    scrollAppToTop();
    writePath(tabPath(nextView));
  };
  const workspaceHub = <WorkspaceHub
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
  const hubNavigation: ApplicationNavigationItem[] = [
    {
      active: routeStatus !== "loading" && (showWelcome || !state),
      href: WORKSPACE_LIST_PATH,
      icon: Home,
      label: "Workspaces",
      onClick: (event) => followAppLink(event, openWorkspaceMenu),
    },
    ...(state
      ? nav.map((entry) => ({
          active: false,
          href: tabPath(entry.id),
          icon: entry.icon,
          label: entry.label,
          onClick: (event: MouseEvent<HTMLAnchorElement>) =>
            followAppLink(event, () => selectView(entry.id)),
        }))
      : []),
    ...(account?.globalRole === "admin"
      ? [{
          active: false,
          href: "/admin",
          icon: ShieldCheck,
          label: "Administration",
        }]
      : []),
  ];
  if (routeStatus === "loading" || !state || showWelcome) {
    return <ApplicationShell
      eyebrow={state?.workspace.name ?? "Your organizer"}
      headerActions={<>
        <ApplicationThemeToggle
          appliedTheme={appliedTheme}
          className="header-mobile-secondary icon"
          onChange={selectTheme}
        />
        <AccountMenu
          accountState={{
            configured: backupConfigured,
            ready: authenticationReady,
            user: account,
          }}
          returnTo={WORKSPACE_LIST_PATH}
        />
      </>}
      mobileNavigation={<nav
        aria-label="Primary application navigation"
        className="bottom application-bottom"
      >
        <ApplicationNavigationLink
          active={routeStatus !== "loading" && (showWelcome || !state)}
          href={WORKSPACE_LIST_PATH}
          icon={Home}
          label="Workspaces"
          onClick={(event) => followAppLink(event, openWorkspaceMenu)}
        />
        {state && phonePrimaryNav.map((entry) =>
          <ApplicationNavigationLink
            active={false}
            href={tabPath(entry.id)}
            icon={entry.icon}
            key={entry.id}
            label={entry.label}
            onClick={(event) =>
              followAppLink(event, () => selectView(entry.id))
            }
          />
        )}
      </nav>}
      navigation={hubNavigation}
      onSidebarCollapsedChange={setSidebarCollapsed}
      sidebarCollapsed={sidebarCollapsed}
      title="Workspaces"
    >
      {preferencesSessionOnly &&
        !preferenceStorageMessageDismissed &&
        <PreferenceStorageBanner
          onDismiss={() => setPreferenceStorageMessageDismissed(true)}
        />}
      {workspaceNotice && <DismissibleWorkspaceNotice
        message={workspaceNotice}
        onDismiss={() => setWorkspaceNotice("")}
      />}
      {routeStatus === "loading"
        ? <div className="application-loading" role="status">
            Opening the requested workspace view...
          </div>
        : workspaceHub}
    </ApplicationShell>;
  }
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
    : syncStatus.state === "pending" && serverBacked && signedIn && online
      ? "Changes are saved on this device immediately and normally appear for collaborators within five seconds."
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
  const workspaceNavigation: ApplicationNavigationItem[] = [
    {
      active: false,
      href: WORKSPACE_LIST_PATH,
      icon: Home,
      label: "Workspaces",
      onClick: (event) => followAppLink(event, openWorkspaceMenu),
    },
    ...nav.map((entry) => ({
      active: entry.id === view,
      href: tabPath(entry.id),
      icon: entry.icon,
      label: entry.label,
      onClick: (event: MouseEvent<HTMLAnchorElement>) =>
        followAppLink(event, () => selectView(entry.id)),
    })),
    ...(account?.globalRole === "admin"
      ? [{
          active: false,
          href: "/admin",
          icon: ShieldCheck,
          label: "Administration",
        }]
      : []),
  ];
  return <>
    <ApplicationShell
      eyebrow={state.workspace.name}
      headerActions={<>
        <button
          aria-keyshortcuts="Control+K Meta+K"
          aria-label="Search ⌘ / Ctrl K and jump"
          className="jump-trigger"
          onClick={() => setJumpPaletteOpen(true)}
          type="button"
        >
          <Search aria-hidden="true" />
          <span>Search</span>
          <kbd>⌘ / Ctrl K</kbd>
        </button>
        <a
          aria-label="Workspaces and backup status"
          className="header-mobile-secondary icon"
          href={WORKSPACE_LIST_PATH}
          onClick={(event) => followAppLink(event, openWorkspaceMenu)}
        >
          <Home aria-hidden="true" />
        </a>
        <button
          aria-label="Share this view"
          className="header-mobile-secondary icon"
          onClick={() => void shareCurrentView()}
          type="button"
        >
          <Share2 aria-hidden="true" />
        </button>
        <ApplicationThemeToggle
          appliedTheme={appliedTheme}
          className="header-mobile-secondary icon"
          onChange={selectTheme}
        />
        <AccountMenu
          accountState={{
            configured: backupConfigured,
            ready: authenticationReady,
            user: account,
          }}
          returnTo={canonicalPath ?? WORKSPACE_LIST_PATH}
          workspaceId={state.workspace.id}
        />
      </>}
      mobileNavigation={<nav
        aria-label="Primary workspace navigation"
        className="bottom"
      >
        {phonePrimaryNav.map((entry) => <ApplicationNavigationLink
          active={entry.id === view}
          href={tabPath(entry.id)}
          icon={entry.icon}
          key={entry.id}
          label={entry.label}
          onClick={(event) =>
            followAppLink(event, () => selectView(entry.id))
          }
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
      </nav>}
      navigation={workspaceNavigation}
      onSidebarCollapsedChange={setSidebarCollapsed}
      sidebarCollapsed={sidebarCollapsed}
      sidebarFooter={<a
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
      </a>}
      title={view === "access"
        ? "Workspace access"
        : nav.find((entry) => entry.id === view)?.label ?? "Workspace"}
    >
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
        <PreferenceStorageBanner
          onDismiss={() => setPreferenceStorageMessageDismissed(true)}
        />}
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
    </ApplicationShell>
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
          {phoneMoreNav.map((entry) => <ApplicationNavigationLink
            active={entry.id === view}
            href={tabPath(entry.id)}
            icon={entry.icon}
            key={entry.id}
            label={entry.label}
            onClick={(event) =>
              followAppLink(event, () => selectView(entry.id))
            }
          />)}
          {account?.globalRole === "admin" &&
            <ApplicationNavigationLink
              active={false}
              href="/admin"
              icon={ShieldCheck}
              label="Administration"
            />}
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
  </>;
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
