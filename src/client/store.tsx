"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { applyCommand } from "../domain/commands";
import { createEnvelope } from "../domain/factories";
import { validateImportSnapshot } from "../domain/import";
import type {
  Command,
  CommandAuthorizationBasis,
  SyncReceipt,
  WorkspaceState,
} from "../domain/types";
import {
  hasForeignPendingWork,
  normalizeServerWorkspaceSummary,
  normalizeWorkspaceAccessState,
  requireWorkspaceWriteAccess,
  workspaceAccountIdsMatch,
  workspaceAccessForAccount,
  workspaceAccessFromSummary,
  type ServerWorkspaceSummary,
  type WorkspaceAccessState,
} from "../domain/workspace-access";
import {
  activateOrInsertServerWorkspaceReplica,
  activateWorkspaceReplica,
  canRebaseQueuedCommand,
  clearActiveServerWorkspaceCatalogAccount,
  deleteWorkspaceReplica,
  listWorkspaceReplicas,
  mergeServerWorkspaceCatalog,
  mutateReplica,
  mutateWorkspaceReplica,
  outboxEntryAccountId,
  readActiveServerWorkspaceCatalogAccount,
  readServerWorkspaceCatalog,
  readWorkspaceReplica,
  reconciliationTargets,
  replaceReplicaIfUnchanged,
  selectPendingSyncBatch,
  setActiveServerWorkspaceCatalogAccount,
  writeReplica,
  writeServerWorkspaceCatalogIfUnchanged,
  writeWorkspaceAuthorizationIfUnchanged,
  type LocalReplica,
  type LocalWorkspaceSummary,
  type ServerWorkspaceCatalog,
  WorkspaceAuthorizationConflictError,
} from "./local-replica";
import {
  mergeWorkspaceHub,
  type WorkspaceHubCard,
} from "./workspace-hub-state";
import { parseAuthorizedRecoverySnapshot } from "./recovery-permissions";
import {
  applyRefusedSyncResponse,
  applySuccessfulSyncResponse,
  inaccessibleWorkspaceAccess,
} from "./sync-reconciliation";
import {
  boundedRetryDelay,
  parseRetryAfter,
  retryWakeDelay,
  runWithConcurrency,
} from "./sync-scheduling";
import {
  ACCOUNT_CONTEXT_HEADER,
  accountContextHeaders,
  responseMatchesAccount,
} from "../shared/account-context";
import {
  ACCOUNT_CHANGE_MESSAGE_TYPE,
  WORKSPACE_CHANNEL_NAME,
} from "./account-channel";
import {
  normalizeAuthenticatedAccount,
  type AuthenticatedAccount,
} from "./account-state";
import {
  DEVICE_ONLY_BACKUP_ERROR,
  SIGN_IN_BACKUP_ERROR,
} from "./backup-presentation";

export { DEVICE_ONLY_BACKUP_ERROR } from "./backup-presentation";

export class WorkspaceOpenError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = "WorkspaceOpenError";
    this.status = status;
  }
}

class WorkspaceCatalogStaleError extends Error {
  constructor() {
    super("Workspace membership changed during pagination");
    this.name = "WorkspaceCatalogStaleError";
  }
}

const BACKUP_UNAVAILABLE_API_ERROR = "Durable storage is not configured";
const BACKUP_UNAVAILABLE_SESSION_KEY = "stowplan-backup-unavailable-at";
const BACKUP_RETRY_INTERVAL_MS = 5 * 60 * 1_000;
const MAXIMUM_CONCURRENT_RECONCILIATIONS = 2;

class RetryableSyncError extends Error {
  constructor(
    message: string,
    readonly retryAfterMs: number | null,
  ) {
    super(message);
    this.name = "RetryableSyncError";
  }
}

type BackupAccess = "available" | "checking" | "idle" | "signed-out" | "unavailable";

interface SyncResponseBody {
  authorization?: unknown;
  code?: string;
  error?: string;
  receipts?: SyncReceipt[];
  state?: WorkspaceState;
  workspace?: unknown;
}

function verifyAccountResponse(
  response: Response,
  accountId: string,
  onMismatch: () => void,
): void {
  const responseAccountId = response.headers.get(
    ACCOUNT_CONTEXT_HEADER,
  );
  if (
    (response.ok && !responseMatchesAccount(response, accountId)) ||
    (
      responseAccountId !== null &&
      responseAccountId !== accountId
    )
  ) {
    onMismatch();
    throw new Error(
      "The signed-in account changed while the request was running",
    );
  }
}

function requireActiveWorkspaceOpen(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  throw signal.reason instanceof Error
    ? signal.reason
    : new DOMException(
        "Workspace opening was cancelled",
        "AbortError",
      );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" &&
    !Array.isArray(value);
}

function syncAuthorization(
  value: unknown,
  accountId: string,
): WorkspaceAccessState | null {
  if (!isRecord(value) || value.kind !== "server") return null;
  const authorization = normalizeWorkspaceAccessState({
    ...value,
    accountId,
  });
  return authorization.kind === "server" ? authorization : null;
}

function visibleWorkspaceAccess(
  replica: LocalReplica,
  accountId: string | null,
  confirmedTerminalAccess?: WorkspaceAccessState,
): WorkspaceAccessState {
  const access = workspaceAccessForAccount(
    confirmedTerminalAccess ?? replica.authorization,
    accountId,
  );
  if (
    access.kind !== "server" ||
    !hasForeignPendingWork(replica.outbox, accountId)
  ) {
    return access;
  }
  return normalizeWorkspaceAccessState({
    ...access,
    accountId,
    capabilities: {
      delete: false,
      leave: false,
      manageAccess: false,
      read: true,
      write: false,
    },
    role: null,
    status: "unknown",
  });
}

function isConfirmedDeletedAccess(
  authorization: WorkspaceAccessState,
): boolean {
  return authorization.kind === "server" &&
    authorization.status === "deleted";
}

export function applyConfirmedTerminalAccessInMemory(
  current: LocalReplica | null,
  workspaceId: string,
  authorization: WorkspaceAccessState,
): LocalReplica | null {
  const candidate = normalizeWorkspaceAccessState(authorization);
  if (
    !current ||
    current.state.workspace.id !== workspaceId ||
    !isConfirmedDeletedAccess(candidate)
  ) {
    return current;
  }
  const existing = normalizeWorkspaceAccessState(current.authorization);
  const next = existing.kind === "server" &&
      existing.status === "deleted" &&
      workspaceAccountIdsMatch(existing.accountId, candidate.accountId)
    ? normalizeWorkspaceAccessState({
        ...candidate,
        accessRevision: Math.max(
          candidate.accessRevision,
          existing.accessRevision,
        ),
        membershipRevision: Math.max(
          candidate.membershipRevision,
          existing.membershipRevision,
        ),
      })
    : candidate;
  return {
    ...current,
    authorization: next,
  };
}

function syncReceipts(value: unknown): SyncReceipt[] {
  if (!Array.isArray(value)) return [];
  return value.filter((receipt): receipt is SyncReceipt =>
    isRecord(receipt) &&
    typeof receipt.commandId === "string" &&
    typeof receipt.revision === "number" &&
    (
      receipt.status === "applied" ||
      receipt.status === "duplicate" ||
      receipt.status === "rejected"
    )
  );
}

function backupRetryDelay(now = Date.now()): number {
  try {
    const unavailableAt = Number(sessionStorage.getItem(BACKUP_UNAVAILABLE_SESSION_KEY));
    if (!Number.isFinite(unavailableAt) || unavailableAt <= 0) return 0;
    return Math.min(
      BACKUP_RETRY_INTERVAL_MS,
      Math.max(0, unavailableAt + BACKUP_RETRY_INTERVAL_MS - now),
    );
  } catch {
    return 0;
  }
}

function rememberBackupUnavailable(): void {
  try {
    sessionStorage.setItem(BACKUP_UNAVAILABLE_SESSION_KEY, String(Date.now()));
  } catch {
    // Capability caching is optional
  }
}

function forgetBackupUnavailable(): void {
  try {
    sessionStorage.removeItem(BACKUP_UNAVAILABLE_SESSION_KEY);
  } catch {
    // Capability caching is optional
  }
}

interface StoreValue {
  account: AuthenticatedAccount | null;
  accountId: string | null;
  authenticationReady: boolean;
  authorization: WorkspaceAccessState | null;
  backupConfigured: boolean | null;
  blocked: number;
  catalogError: string | null;
  catalogHasMore: boolean;
  catalogLoading: boolean;
  dispatch: (command: Command) => Promise<void>;
  hubCards: WorkspaceHubCard[];
  initialize: (state: WorkspaceState) => Promise<void>;
  lastSyncAttemptAt: string | null;
  lastSyncError: string | null;
  lastSyncedAt: string | null;
  loadMoreWorkspaces: () => Promise<void>;
  localUpdatedAt: string | null;
  online: boolean;
  openWorkspace: (
    workspaceId: string,
    signal?: AbortSignal,
  ) => Promise<void>;
  pending: number;
  refreshWorkspaces: () => Promise<void>;
  removeWorkspace: (workspaceId: string, expectedUpdatedAt?: string) => Promise<void>;
  setWorkspaceAccess: (
    workspaceId: string,
    authorization: WorkspaceAccessState,
    summary?: ServerWorkspaceSummary | null,
  ) => Promise<void>;
  signedIn: boolean;
  replace: (state: WorkspaceState) => Promise<void>;
  state: WorkspaceState | null;
  syncing: boolean;
  workspaceStatusRevision: number;
}

const Store = createContext<StoreValue | null>(null);

export function StowplanProvider({ children }: { children: React.ReactNode }) {
  const [replica, setReplica] = useState<LocalReplica | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [online, setOnline] = useState(() => typeof navigator === "undefined" ? true : navigator.onLine);
  const [syncingWorkspaceIds, setSyncingWorkspaceIds] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const [workspaceStatusRevision, setWorkspaceStatusRevision] = useState(0);
  const [backupConfigured, setBackupConfigured] = useState<boolean | null>(null);
  const [backupAccess, setBackupAccess] = useState<BackupAccess>("idle");
  const [account, setAccount] = useState<AuthenticatedAccount | null>(null);
  const [accountId, setAccountId] = useState<string | null>(null);
  const [authenticationReady, setAuthenticationReady] = useState(false);
  const [signedIn, setSignedIn] = useState(false);
  const [catalog, setCatalog] = useState<ServerWorkspaceCatalog | null>(null);
  const [catalogLoading, setCatalogLoading] = useState(false);
  const [catalogError, setCatalogError] = useState<string | null>(null);
  const [localWorkspaces, setLocalWorkspaces] = useState<
    LocalWorkspaceSummary[]
  >([]);
  const [
    confirmedTerminalAuthorizations,
    setConfirmedTerminalAuthorizations,
  ] = useState<ReadonlyMap<string, WorkspaceAccessState>>(
    () => new Map(),
  );
  const mutationQueue = useRef<Promise<void>>(Promise.resolve());
  const accountIdRef = useRef<string | null>(null);
  const selectedWorkspaceIdRef = useRef<string | null>(null);
  const catalogRefreshEntries = useRef<ServerWorkspaceSummary[]>([]);
  const catalogRequest = useRef(0);
  const workspaceChannel = useRef<BroadcastChannel | null>(null);
  const queuedCommandIds = useRef(new Set<string>());
  const confirmedTerminalAccess =
    useRef(new Map<string, WorkspaceAccessState>());
  const flushPromises = useRef(new Map<string, Promise<void>>());
  const followUpFlushes = useRef(new Map<string, boolean>());
  const retryStates = useRef(new Map<string, {
    attempt: number;
    notBefore: number;
    timer: ReturnType<typeof setTimeout> | null;
  }>());
  const flushWorkspaceRef = useRef<(workspaceId: string, allowEmpty?: boolean) => Promise<void>>(
    () => Promise.resolve(),
  );
  const syncTimers = useRef(new Map<string, {
    idle: ReturnType<typeof setTimeout> | null;
    maximum: ReturnType<typeof setTimeout> | null;
  }>());

  useEffect(() => {
    void Promise.all([
      mutateReplica((current) => current),
      listWorkspaceReplicas(),
      readActiveServerWorkspaceCatalogAccount(),
    ]).then(async ([value, workspaces, activeAccountId]) => {
      if (backupRetryDelay() > 0) {
        setBackupConfigured(false);
        setBackupAccess("unavailable");
        setAuthenticationReady(true);
      } else {
        setAuthenticationReady(false);
        setBackupAccess("checking");
      }
      accountIdRef.current = activeAccountId;
      setAccountId(activeAccountId);
      setCatalog(
        activeAccountId
          ? await readServerWorkspaceCatalog(activeAccountId)
          : null,
      );
      setLocalWorkspaces(workspaces);
      setReplica(value);
      setLoaded(true);
    }).catch((error) => {
      setLoadError(error instanceof Error ? error.message : "On-device storage is unavailable");
      setLoaded(true);
    });
  }, []);
  useEffect(() => {
    if (backupAccess !== "checking") return;
    let active = true;
    void fetch("/api/auth/me", { cache: "no-store" }).then(async (response) => {
      const body = await response.json() as {
        configured?: boolean;
        user?: unknown;
      };
      if (!response.ok) throw new Error("Could not check server backup access");
      if (!active) return;
      if (!body.configured) {
        rememberBackupUnavailable();
        setAccount(null);
        setBackupConfigured(false);
        setBackupAccess("unavailable");
        setSignedIn(false);
        setAuthenticationReady(true);
        return;
      }
      forgetBackupUnavailable();
      setBackupConfigured(true);
      const authenticatedAccount = normalizeAuthenticatedAccount(body.user);
      if (authenticatedAccount) {
        accountIdRef.current = authenticatedAccount.userId;
        await setActiveServerWorkspaceCatalogAccount(
          authenticatedAccount.userId,
        );
        const cached = await readServerWorkspaceCatalog(
          authenticatedAccount.userId,
        );
        if (!active) return;
        setAccount(authenticatedAccount);
        setAccountId(authenticatedAccount.userId);
        setCatalog(cached);
        setSignedIn(true);
        setBackupAccess("available");
        setAuthenticationReady(true);
      } else {
        accountIdRef.current = null;
        await clearActiveServerWorkspaceCatalogAccount()
          .catch(() => undefined);
        if (!active) return;
        setAccount(null);
        setAccountId(null);
        setCatalog(null);
        setSignedIn(false);
        setBackupAccess("signed-out");
        setAuthenticationReady(true);
      }
    }).catch(() => {
      if (!active) return;
      setBackupConfigured(null);
      setBackupAccess("available");
      setAuthenticationReady(true);
    });
    return () => { active = false; };
  }, [backupAccess]);
  useEffect(() => {
    if (backupAccess !== "unavailable") return;
    const retry = setTimeout(
      () => {
        setBackupConfigured(null);
        setAuthenticationReady(false);
        setBackupAccess("checking");
      },
      backupRetryDelay() || BACKUP_RETRY_INTERVAL_MS,
    );
    return () => clearTimeout(retry);
  }, [backupAccess]);
  useEffect(() => {
    const update = () => setOnline(navigator.onLine);
    addEventListener("online", update);
    addEventListener("offline", update);
    return () => {
      removeEventListener("online", update);
      removeEventListener("offline", update);
    };
  }, []);
  useEffect(() => {
    void listWorkspaceReplicas()
      .then(setLocalWorkspaces)
      .catch(() => undefined);
  }, [replica?.updatedAt, workspaceStatusRevision]);
  useEffect(() => {
    selectedWorkspaceIdRef.current = replica?.state.workspace.id ?? null;
  }, [replica?.state.workspace.id]);

  const broadcastWorkspaceChange = useCallback((
    message:
      | { accountId: string; type: "catalog-updated" }
      | {
          type: "authorization-updated" | "replica-removed" | "replica-updated";
          workspaceId: string;
        },
  ) => {
    workspaceChannel.current?.postMessage(message);
  }, []);

  const clearSchedule = useCallback((workspaceId?: string) => {
    const entries = workspaceId
      ? [[workspaceId, syncTimers.current.get(workspaceId)] as const]
      : [...syncTimers.current.entries()];
    for (const [id, entry] of entries) {
      if (entry?.idle) clearTimeout(entry.idle);
      if (entry?.maximum) clearTimeout(entry.maximum);
      syncTimers.current.delete(id);
    }
  }, []);

  const clearRetry = useCallback((workspaceId?: string) => {
    const entries = workspaceId
      ? [[workspaceId, retryStates.current.get(workspaceId)] as const]
      : [...retryStates.current.entries()];
    for (const [id, entry] of entries) {
      if (entry?.timer) clearTimeout(entry.timer);
      retryStates.current.delete(id);
    }
  }, []);

  const scheduleRetry = useCallback((
    workspaceId: string,
    retryAfterMs: number | null,
  ) => {
    const current = retryStates.current.get(workspaceId) ?? {
      attempt: 0,
      notBefore: 0,
      timer: null,
    };
    if (current.timer) clearTimeout(current.timer);
    const delay = boundedRetryDelay(
      current.attempt,
      retryAfterMs,
    );
    const now = Date.now();
    const next = {
      attempt: current.attempt + 1,
      notBefore: Math.max(
        current.notBefore,
        Math.min(Number.MAX_SAFE_INTEGER, now + delay),
      ),
      timer: null as ReturnType<typeof setTimeout> | null,
    };
    const wake = () => {
      const scheduled = retryStates.current.get(workspaceId);
      if (scheduled !== next) return;
      const remaining = retryWakeDelay(next.notBefore);
      if (remaining > 0) {
        next.timer = setTimeout(wake, remaining);
        return;
      }
      next.timer = null;
      next.notBefore = 0;
      void flushWorkspaceRef.current(workspaceId, false);
    };
    next.timer = setTimeout(
      wake,
      retryWakeDelay(next.notBefore, now),
    );
    retryStates.current.set(workspaceId, next);
  }, []);

  useEffect(() => clearRetry(), [accountId, clearRetry]);

  const requestAuthenticationRefresh = useCallback(() => {
    setAuthenticationReady(false);
    setBackupAccess("checking");
  }, []);
  useEffect(() => {
    const refresh = () => requestAuthenticationRefresh();
    const visible = () => {
      if (document.visibilityState === "visible") refresh();
    };
    addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", visible);
    return () => {
      removeEventListener("focus", refresh);
      document.removeEventListener("visibilitychange", visible);
    };
  }, [requestAuthenticationRefresh]);

  const recordSyncAttempt = useCallback(async (workspaceId: string, error: string | null, syncedAt?: string) => {
    const attemptedAt = new Date().toISOString();
    const next = await mutateWorkspaceReplica(workspaceId, (latest) => ({
      ...latest,
      lastSyncAttemptAt: attemptedAt,
      lastSyncError: error,
      lastSyncedAt: syncedAt ?? latest.lastSyncedAt ?? null,
    }));
    if (next) {
      setWorkspaceStatusRevision((current) => current + 1);
      setReplica((current) => current?.state.workspace.id === workspaceId ? next : current);
      broadcastWorkspaceChange({ type: "replica-updated", workspaceId });
    }
  }, [broadcastWorkspaceChange]);

  const applyCatalogAuthorization = useCallback(async (
    entries: readonly ServerWorkspaceSummary[],
    complete: boolean,
    membershipRevision: number,
  ) => {
    if (!accountId || accountIdRef.current !== accountId) return;
    const selectedWorkspaceId = selectedWorkspaceIdRef.current;
    const checkedAt = new Date().toISOString();
    const presentIds = new Set(entries.map((entry) => entry.id));
    for (const summary of entries) {
      const current = await readWorkspaceReplica(summary.id);
      if (!current) continue;
      const expected = normalizeWorkspaceAccessState(current.authorization);
      try {
        const updated = await writeWorkspaceAuthorizationIfUnchanged(
          summary.id,
          workspaceAccessFromSummary(summary, checkedAt),
          expected,
          summary,
        );
        if (updated) {
          broadcastWorkspaceChange({
            type: "authorization-updated",
            workspaceId: summary.id,
          });
        }
      } catch {
        // A newer cross-tab role or local update wins
      }
    }
    if (complete) {
      const local = await listWorkspaceReplicas();
      for (const summary of local) {
        const expected = summary.authorization;
        const sameAccount = expected?.kind === "server" &&
          workspaceAccountIdsMatch(expected.accountId, accountId);
        if (
          !expected ||
          expected.kind !== "server" ||
          presentIds.has(summary.id) ||
          (
            sameAccount &&
            membershipRevision <= expected.membershipRevision
          )
        ) {
          continue;
        }
        const revoked = normalizeWorkspaceAccessState({
          ...expected,
          accountId,
          accessRevision: sameAccount ? expected.accessRevision : 0,
          capabilities: {
            delete: false,
            leave: false,
            manageAccess: false,
            read: true,
            write: false,
          },
          checkedAt,
          membershipRevision,
          role: null,
          status: "revoked",
        });
        try {
          const updated = await writeWorkspaceAuthorizationIfUnchanged(
            summary.id,
            revoked,
            expected,
          );
          if (updated) {
            broadcastWorkspaceChange({
              type: "authorization-updated",
              workspaceId: summary.id,
            });
          }
        } catch {
          // A newer cross-tab role or local update wins
        }
      }
    }
    const [selected, workspaces] = await Promise.all([
      selectedWorkspaceId
        ? readWorkspaceReplica(selectedWorkspaceId)
        : Promise.resolve(null),
      listWorkspaceReplicas(),
    ]);
    setReplica((current) =>
      (current?.state.workspace.id ?? null) === selectedWorkspaceId
        ? selected
        : current
    );
    setLocalWorkspaces(workspaces);
    setWorkspaceStatusRevision((current) => current + 1);
  }, [accountId, broadcastWorkspaceChange]);

  const requestCatalogPage = useCallback(async (
    cursor: string | null,
    restart: boolean,
  ) => {
    if (!accountId || !signedIn) {
      throw new Error("Sign in to refresh server workspaces.");
    }
    if (!navigator.onLine) {
      throw new Error("Connect to the network to refresh server workspaces.");
    }
    const requestAccountId = accountId;
    const requestId = catalogRequest.current + 1;
    catalogRequest.current = requestId;
    setCatalogLoading(true);
    setCatalogError(null);
    try {
      const url = new URL("/api/workspaces", location.origin);
      url.searchParams.set("limit", "25");
      if (cursor) url.searchParams.set("cursor", cursor);
      const response = await fetch(url, {
        cache: "no-store",
        headers: accountContextHeaders(requestAccountId),
      });
      verifyAccountResponse(
        response,
        requestAccountId,
        requestAuthenticationRefresh,
      );
      const body = await response.json().catch(() => null) as {
        code?: string;
        error?: string;
        membershipRevision?: number;
        page?: {
          hasMore?: boolean;
          nextCursor?: string | null;
        };
        workspaces?: unknown[];
      } | null;
      if (!response.ok) {
        if (body?.code === "ACCOUNT_CONTEXT_CHANGED") {
          requestAuthenticationRefresh();
        }
        if (response.status === 401) {
          setAccount(null);
          setSignedIn(false);
          setBackupAccess("signed-out");
        }
        if (
          response.status === 409 &&
          body?.code === "ACCESS_STALE" &&
          cursor
        ) {
          throw new WorkspaceCatalogStaleError();
        }
        throw new Error(body?.error ?? "Could not refresh server workspaces");
      }
      if (
        accountIdRef.current !== requestAccountId ||
        catalogRequest.current !== requestId
      ) {
        return;
      }
      if (
        !body ||
        !Array.isArray(body.workspaces) ||
        !Number.isSafeInteger(body.membershipRevision) ||
        Number(body.membershipRevision) < 0 ||
        typeof body.page?.hasMore !== "boolean"
      ) {
        throw new Error("The server returned an invalid workspace list");
      }
      const entries = body.workspaces.flatMap((value) => {
        const summary = normalizeServerWorkspaceSummary(value);
        return summary
          ? [{ ...summary, accountId: requestAccountId }]
          : [];
      });
      if (entries.length !== body.workspaces.length) {
        throw new Error("The server returned invalid workspace metadata");
      }
      const membershipRevision = Number(body.membershipRevision);
      const hasMore = body.page.hasMore;
      const nextCursor = typeof body.page.nextCursor === "string"
        ? body.page.nextCursor
        : null;
      if (hasMore && !nextCursor) {
        throw new Error("The server truncated the workspace list without a continuation");
      }
      if (restart) catalogRefreshEntries.current = entries;
      else catalogRefreshEntries.current = [
        ...catalogRefreshEntries.current,
        ...entries,
      ];
      const fetchedAt = new Date().toISOString();
      let persisted = await readServerWorkspaceCatalog(requestAccountId);
      const pageEntries = hasMore
        ? entries
        : catalogRefreshEntries.current;
      let next = mergeServerWorkspaceCatalog(
        persisted,
        {
          accountId: requestAccountId,
          entries: pageEntries,
          fetchedAt,
          hasMore,
          membershipRevision,
          nextCursor,
        },
        !hasMore,
      );
      try {
        await writeServerWorkspaceCatalogIfUnchanged(next, persisted);
      } catch {
        persisted = await readServerWorkspaceCatalog(requestAccountId);
        next = mergeServerWorkspaceCatalog(
          persisted,
          {
            accountId: requestAccountId,
            entries: pageEntries,
            fetchedAt,
            hasMore,
            membershipRevision,
            nextCursor,
          },
          !hasMore,
        );
        await writeServerWorkspaceCatalogIfUnchanged(next, persisted);
      }
      if (
        accountIdRef.current !== requestAccountId ||
        catalogRequest.current !== requestId
      ) {
        return;
      }
      setCatalog(next);
      broadcastWorkspaceChange({
        accountId: requestAccountId,
        type: "catalog-updated",
      });
      await applyCatalogAuthorization(
        pageEntries,
        !hasMore,
        membershipRevision,
      );
    } catch (error) {
      if (
        catalogRequest.current === requestId &&
        !(error instanceof WorkspaceCatalogStaleError)
      ) {
        const message = error instanceof Error
          ? error.message
          : "Could not refresh server workspaces";
        setCatalogError(message);
      }
      throw error;
    } finally {
      if (catalogRequest.current === requestId) setCatalogLoading(false);
    }
  }, [
    accountId,
    applyCatalogAuthorization,
    broadcastWorkspaceChange,
    requestAuthenticationRefresh,
    signedIn,
  ]);

  const refreshWorkspaces = useCallback(
    () => requestCatalogPage(null, true),
    [requestCatalogPage],
  );
  const loadMoreWorkspaces = useCallback(async () => {
    if (!catalog?.hasMore || !catalog.nextCursor) return Promise.resolve();
    try {
      await requestCatalogPage(catalog.nextCursor, false);
    } catch (error) {
      if (!(error instanceof WorkspaceCatalogStaleError)) throw error;
      await requestCatalogPage(null, true);
    }
  }, [catalog, requestCatalogPage]);

  useEffect(() => {
    if (!accountId || !signedIn || !online) return;
    const timer = setTimeout(
      () => void refreshWorkspaces().catch(() => undefined),
      0,
    );
    return () => clearTimeout(timer);
  }, [accountId, online, refreshWorkspaces, signedIn]);

  const flushWorkspace = useCallback((workspaceId: string, allowEmpty = false): Promise<void> => {
    const existing = flushPromises.current.get(workspaceId);
    if (existing) {
      followUpFlushes.current.set(
        workspaceId,
        allowEmpty || followUpFlushes.current.get(workspaceId) === true,
      );
      return existing;
    }
    const operation = (async () => {
      let attemptedWorkspaceId: string | null = null;
      let countedAsSyncing = false;
      try {
        const retry = retryStates.current.get(workspaceId);
        if (retry && retry.notBefore > Date.now()) return;
        if (
          backupAccess === "checking" ||
          backupAccess === "idle" ||
          backupAccess === "unavailable" ||
          backupConfigured === false
        ) return;
        const value = await readWorkspaceReplica(workspaceId);
        if (!value || !navigator.onLine) return;
        const storedAuthorization = normalizeWorkspaceAccessState(
          value.authorization,
        );
        if (backupAccess === "signed-out") {
          if (
            storedAuthorization.kind === "server" &&
            storedAuthorization.status === "active" &&
            value.lastSyncError !== SIGN_IN_BACKUP_ERROR
          ) {
            await recordSyncAttempt(workspaceId, SIGN_IN_BACKUP_ERROR);
          }
          return;
        }
        const requestAccountId = accountIdRef.current;
        if (!requestAccountId) return;
        if (
          storedAuthorization.kind === "server" &&
          !workspaceAccountIdsMatch(
            storedAuthorization.accountId,
            requestAccountId,
          )
        ) {
          return;
        }
        attemptedWorkspaceId = value.state.workspace.id;
        const pendingCount = value.outbox.filter(
          (entry) => entry.status === "pending",
        ).length;
        const batch = selectPendingSyncBatch(
          value.outbox,
          storedAuthorization.kind === "server"
            ? requestAccountId
            : undefined,
        );
        if (pendingCount > 0 && batch.length === 0) return;
        if (!allowEmpty && batch.length === 0) return;
        countedAsSyncing = true;
        setSyncingWorkspaceIds((current) => {
          const next = new Set(current);
          next.add(workspaceId);
          return next;
        });
        const response = await fetch("/api/sync", {
          method: "POST",
          headers: accountContextHeaders(requestAccountId, {
            "content-type": "application/json",
          }),
          body: JSON.stringify({ commands: batch.map(entry => entry.envelope), snapshot: value.state, workspaceId: value.state.workspace.id }),
        });
        verifyAccountResponse(
          response,
          requestAccountId,
          requestAuthenticationRefresh,
        );
        const rawBody = await response.json().catch(() => null);
        const body = isRecord(rawBody)
          ? rawBody as SyncResponseBody
          : null;
        if (accountIdRef.current !== requestAccountId) return;
        if (body?.code === "ACCOUNT_CONTEXT_CHANGED") {
          requestAuthenticationRefresh();
          throw new Error(
            "The signed-in account changed; queued work was not sent",
          );
        }
        if (response.status === 503) {
          if (body?.error === BACKUP_UNAVAILABLE_API_ERROR) {
            rememberBackupUnavailable();
            setBackupConfigured(false);
            setBackupAccess("unavailable");
            await recordSyncAttempt(value.state.workspace.id, DEVICE_ONLY_BACKUP_ERROR);
            return;
          }
          throw new RetryableSyncError(
            body?.error ?? "Server backup is temporarily unavailable.",
            parseRetryAfter(response.headers.get("retry-after")),
          );
        }
        if (response.status === 429) {
          throw new RetryableSyncError(
            body?.error ?? "Server backup is temporarily rate limited.",
            parseRetryAfter(response.headers.get("retry-after")),
          );
        }
        forgetBackupUnavailable();
        const authorization = syncAuthorization(
          body?.authorization,
          requestAccountId,
        );
        const effectiveAuthorization =
          response.status === 404 &&
            !authorization &&
            storedAuthorization.kind === "server"
            ? inaccessibleWorkspaceAccess(
                storedAuthorization,
                requestAccountId,
                new Date().toISOString(),
              )
            : authorization;
        const rawSummary = normalizeServerWorkspaceSummary(body?.workspace);
        const summary = rawSummary
          ? { ...rawSummary, accountId: requestAccountId }
          : null;
        const receipts = syncReceipts(body?.receipts);
        if (summary && summary.id !== value.state.workspace.id) {
          throw new Error("The server returned workspace metadata for another workspace");
        }
        if (!response.ok) {
          const message = body?.error ??
            `Sync failed (${response.status})`;
          const definitiveRefusal =
            receipts.length > 0 ||
            response.status === 403 ||
            response.status === 404 ||
            response.status === 410;
          const next = await mutateWorkspaceReplica(
            value.state.workspace.id,
            latest => applyRefusedSyncResponse(
              latest,
              batch,
              receipts,
              message,
              new Date().toISOString(),
              definitiveRefusal,
              { authorization: effectiveAuthorization, summary },
            ),
          );
          if (next) {
            setWorkspaceStatusRevision((current) => current + 1);
            setReplica((current) => current?.state.workspace.id === value.state.workspace.id ? next : current);
            broadcastWorkspaceChange({
              type: effectiveAuthorization
                ? "authorization-updated"
                : "replica-updated",
              workspaceId: value.state.workspace.id,
            });
          }
          setBackupConfigured(true);
          if (response.status === 401) {
            setBackupAccess("signed-out");
          } else {
            setBackupAccess("available");
          }
          if (response.status === 404) {
            void refreshWorkspaces().catch(() => undefined);
          }
          clearRetry(workspaceId);
          if (definitiveRefusal || response.status === 401) return;
          throw new Error(message);
        }
        setBackupConfigured(true);
        setBackupAccess("available");
        if (
          !body?.state ||
          body.state.workspace?.id !== value.state.workspace.id ||
          !authorization ||
          !summary
        ) {
          throw new Error("The server returned an invalid sync response");
        }
        const syncedAt = new Date().toISOString();
        const next = await mutateWorkspaceReplica(
          value.state.workspace.id,
          (latest) => {
            return applySuccessfulSyncResponse(
              latest,
              batch,
              body.state!,
              receipts,
              syncedAt,
              { authorization, summary },
            );
          },
        );
        if (next) {
          clearRetry(workspaceId);
          setWorkspaceStatusRevision((current) => current + 1);
          setReplica((current) => current?.state.workspace.id === value.state.workspace.id ? next : current);
          broadcastWorkspaceChange({
            type: "replica-updated",
            workspaceId: value.state.workspace.id,
          });
          if (pendingCount > batch.length) {
            followUpFlushes.current.set(workspaceId, false);
          }
        }
      } catch (error) {
        // Local state stays authoritative; visibility/manual/online events retry
        if (error instanceof RetryableSyncError) {
          scheduleRetry(workspaceId, error.retryAfterMs);
        }
        if (attemptedWorkspaceId) {
          await recordSyncAttempt(
            attemptedWorkspaceId,
            error instanceof Error
              ? error.message
              : "Server backup is temporarily unavailable.",
          );
        }
      } finally {
        if (countedAsSyncing) {
          setSyncingWorkspaceIds((current) => {
            const next = new Set(current);
            next.delete(workspaceId);
            return next;
          });
        }
      }
    })();
    flushPromises.current.set(workspaceId, operation);
    void operation.finally(() => {
      if (flushPromises.current.get(workspaceId) === operation) {
        flushPromises.current.delete(workspaceId);
      }
      if (followUpFlushes.current.has(workspaceId)) {
        const followUpAllowsEmpty = followUpFlushes.current.get(workspaceId) === true;
        followUpFlushes.current.delete(workspaceId);
        queueMicrotask(() => void flushWorkspaceRef.current(workspaceId, followUpAllowsEmpty));
      }
    });
    return operation;
  }, [
    backupAccess,
    backupConfigured,
    broadcastWorkspaceChange,
    clearRetry,
    recordSyncAttempt,
    refreshWorkspaces,
    requestAuthenticationRefresh,
    scheduleRetry,
  ]);
  useEffect(() => {
    flushWorkspaceRef.current = flushWorkspace;
  }, [flushWorkspace]);

  const schedule = useCallback((workspaceId: string) => {
    const current = syncTimers.current.get(workspaceId) ?? {
      idle: null,
      maximum: null,
    };
    if (current.idle) clearTimeout(current.idle);
    current.idle = setTimeout(() => {
      clearSchedule(workspaceId);
      void flushWorkspace(workspaceId, false);
    }, 1_800);
    if (!current.maximum) {
      current.maximum = setTimeout(() => {
        clearSchedule(workspaceId);
        void flushWorkspace(workspaceId, false);
      }, 8_000);
    }
    syncTimers.current.set(workspaceId, current);
  }, [clearSchedule, flushWorkspace]);

  const activeWorkspaceId = replica?.state.workspace.id;
  const syncing = Boolean(
    activeWorkspaceId && syncingWorkspaceIds.has(activeWorkspaceId),
  );
  useEffect(() => {
    if (typeof BroadcastChannel === "undefined") return;
    const channel = new BroadcastChannel(WORKSPACE_CHANNEL_NAME);
    workspaceChannel.current = channel;
    channel.onmessage = (event: MessageEvent<unknown>) => {
      const message = event.data;
      if (!message || typeof message !== "object") return;
      if (
        "type" in message &&
        message.type === ACCOUNT_CHANGE_MESSAGE_TYPE
      ) {
        requestAuthenticationRefresh();
        return;
      }
      if (
        "workspaceId" in message &&
        typeof message.workspaceId === "string"
      ) {
        void listWorkspaceReplicas()
          .then(setLocalWorkspaces)
          .catch(() => undefined);
        if (message.workspaceId === activeWorkspaceId) {
          if (
            "type" in message &&
            message.type === "replica-removed"
          ) {
            setReplica(null);
          } else {
            void readWorkspaceReplica(activeWorkspaceId)
              .then((current) => {
                setReplica(current);
              })
              .catch(() => undefined);
          }
        }
      }
      if (
        "accountId" in message &&
        typeof message.accountId === "string" &&
        message.accountId === accountId
      ) {
        void readServerWorkspaceCatalog(accountId)
          .then(setCatalog)
          .catch(() => undefined);
      }
    };
    return () => {
      if (workspaceChannel.current === channel) {
        workspaceChannel.current = null;
      }
      channel.close();
    };
  }, [
    accountId,
    activeWorkspaceId,
    requestAuthenticationRefresh,
  ]);
  useEffect(() => {
    if (!activeWorkspaceId) return;
    const reconcile = async () => {
      const workspaces = await listWorkspaceReplicas().catch(() => []);
      const targets = reconciliationTargets(workspaces, activeWorkspaceId);
      for (const target of targets) clearSchedule(target.workspaceId);
      await runWithConcurrency(
        targets,
        MAXIMUM_CONCURRENT_RECONCILIATIONS,
        (target) =>
          flushWorkspace(target.workspaceId, target.allowEmpty),
      );
    };
    const immediate = () => void reconcile();
    immediate();
    const visible = () => {
      if (document.visibilityState === "visible") immediate();
    };
    addEventListener("focus", immediate);
    addEventListener("online", immediate);
    document.addEventListener("visibilitychange", visible);
    const reconciliation = setInterval(immediate, 300_000);
    return () => {
      removeEventListener("focus", immediate);
      removeEventListener("online", immediate);
      document.removeEventListener("visibilitychange", visible);
      clearInterval(reconciliation);
    };
  }, [activeWorkspaceId, clearSchedule, flushWorkspace]);
  useEffect(() => () => {
    clearRetry();
    clearSchedule();
  }, [clearRetry, clearSchedule]);

  const dispatch = useCallback((command: Command) => {
    const visibleState = replica?.state;
    if (!visibleState) return Promise.resolve();
    const workspaceId = visibleState.workspace.id;
    const visibleAuthorization = visibleWorkspaceAccess(
      replica,
      accountId,
      confirmedTerminalAccess.current.get(workspaceId),
    );
    try {
      requireWorkspaceWriteAccess(visibleAuthorization);
    } catch (error) {
      return Promise.reject(error);
    }
    const commandAuthorization: CommandAuthorizationBasis | undefined =
      visibleAuthorization.kind === "server"
        ? {
            membershipRevision:
              visibleAuthorization.membershipRevision,
            workspaceAccessRevision:
              visibleAuthorization.accessRevision,
          }
        : undefined;
    const envelope = createEnvelope(visibleState, command, {
      authorization: commandAuthorization,
    });
    const priorCommandIds = [...queuedCommandIds.current];
    queuedCommandIds.current.add(envelope.id);
    const operation = mutationQueue.current.then(async () => {
      let next: LocalReplica | null;
      try {
        next = await mutateWorkspaceReplica(workspaceId, (current) => {
          requireWorkspaceWriteAccess(
            visibleWorkspaceAccess(
              current,
              accountIdRef.current,
              confirmedTerminalAccess.current.get(workspaceId),
            ),
          );
          const effectiveEnvelope = canRebaseQueuedCommand(
            current.state,
            envelope.baseRevision,
            priorCommandIds,
          )
            ? createEnvelope(current.state, command, {
                actorId: envelope.actorId,
                authorization: envelope.authorization,
                deviceId: envelope.deviceId,
                id: envelope.id,
                timestamp: envelope.timestamp,
              })
            : envelope;
          return {
            ...current,
            state: applyCommand(current.state, effectiveEnvelope).state,
            outbox: [
              ...current.outbox,
              {
                // Attribute the entry to the account the write was just
                // authorized for, matching the requireWorkspaceWriteAccess
                // check above, so it is never stored unattributed
                accountId: outboxEntryAccountId(accountIdRef.current),
                envelope: effectiveEnvelope,
                status: "pending",
              },
            ],
            updatedAt: new Date().toISOString(),
          };
        });
        if (!next) {
          throw new Error("This workspace was removed from this device. Reopen it before saving.");
        }
      } catch (error) {
        const latest = await readWorkspaceReplica(workspaceId)
          .catch(() => null);
        setReplica((current) =>
          current?.state.workspace.id === workspaceId ? latest : current
        );
        throw error;
      }
      setReplica((current) =>
        current?.state.workspace.id === workspaceId ? next : current
      );
      broadcastWorkspaceChange({ type: "replica-updated", workspaceId });
      schedule(workspaceId);
    });
    mutationQueue.current = operation.then(
      () => { queuedCommandIds.current.delete(envelope.id); },
      () => { queuedCommandIds.current.delete(envelope.id); },
    );
    return operation;
  }, [
    accountId,
    broadcastWorkspaceChange,
    replica,
    schedule,
  ]);

  const initialize = useCallback((state: WorkspaceState) => {
    const operation = mutationQueue.current.then(async () => {
      const next = {
        authorization: normalizeWorkspaceAccessState(undefined),
        lastSyncAttemptAt: null,
        lastSyncError: null,
        lastSyncedAt: null,
        outbox: [],
        serverSummary: null,
        state,
        updatedAt: new Date().toISOString(),
      } satisfies LocalReplica;
      await writeReplica(next);
      setReplica(next);
      broadcastWorkspaceChange({
        type: "replica-updated",
        workspaceId: state.workspace.id,
      });
    });
    mutationQueue.current = operation.catch(() => undefined);
    return operation;
  }, [broadcastWorkspaceChange]);

  const openWorkspace = useCallback((
    workspaceId: string,
    signal?: AbortSignal,
  ) => {
    const operation = mutationQueue.current.then(async () => {
      requireActiveWorkspaceOpen(signal);
      let next = await activateWorkspaceReplica(
        workspaceId,
        signal,
      );
      if (!next) {
        const requestAccountId = accountIdRef.current;
        if (!requestAccountId) {
          throw new WorkspaceOpenError(
            "Sign in to download this workspace",
            401,
          );
        }
        const response = await fetch(
          `/api/snapshot?workspaceId=${encodeURIComponent(workspaceId)}`,
          {
            cache: "no-store",
            headers: accountContextHeaders(requestAccountId),
            signal,
          },
        );
        verifyAccountResponse(
          response,
          requestAccountId,
          requestAuthenticationRefresh,
        );
        const body = await response.json() as unknown;
        requireActiveWorkspaceOpen(signal);
        if (accountIdRef.current !== requestAccountId) {
          throw new WorkspaceOpenError(
            "The signed-in account changed while the workspace was downloading",
            409,
          );
        }
        if (
          !response.ok &&
          isRecord(body) &&
          body.error ===
            "The signed-in account changed; refresh before continuing"
        ) {
          requestAuthenticationRefresh();
        }
        if (!response.ok) {
          throw new WorkspaceOpenError(
            isRecord(body) && typeof body.error === "string"
              ? body.error
              : "Could not open that workspace",
            response.status,
          );
        }
        const rawState = isRecord(body) ? body.state : undefined;
        const issues = validateImportSnapshot(rawState).filter(
          (issue) => issue.severity === "error",
        );
        if (issues.length > 0) {
          throw new WorkspaceOpenError(
            "The server workspace failed validation and was not saved on this device",
            502,
          );
        }
        let downloaded;
        try {
          downloaded = parseAuthorizedRecoverySnapshot(
            body,
            workspaceId,
            requestAccountId,
          );
        } catch (error) {
          throw new WorkspaceOpenError(
            error instanceof Error
              ? error.message
              : "The server returned inconsistent workspace access",
            502,
          );
        }
        requireActiveWorkspaceOpen(signal);
        const syncedAt = new Date().toISOString();
        next = await activateOrInsertServerWorkspaceReplica({
          authorization: downloaded.authorization,
          lastSyncAttemptAt: syncedAt,
          lastSyncError: null,
          lastSyncedAt: syncedAt,
          outbox: [],
          serverSummary: downloaded.workspace,
          state: downloaded.state,
          updatedAt: syncedAt,
        }, signal);
        requireActiveWorkspaceOpen(signal);
        broadcastWorkspaceChange({
          type: "replica-updated",
          workspaceId,
        });
      }
      requireActiveWorkspaceOpen(signal);
      setReplica(next);
    });
    mutationQueue.current = operation.catch(() => undefined);
    return operation;
  }, [broadcastWorkspaceChange, requestAuthenticationRefresh]);

  const replace = useCallback((state: WorkspaceState) => {
    const operation = mutationQueue.current.then(async () => {
      const currentWorkspaceId = replica?.state.workspace.id;
      if (!replica) throw new Error("The workspace is no longer open on this device.");
      requireWorkspaceWriteAccess(
        visibleWorkspaceAccess(
          replica,
          accountIdRef.current,
          confirmedTerminalAccess.current.get(
            replica.state.workspace.id,
          ),
        ),
      );
      const sameWorkspace =
        replica.state.workspace.id === state.workspace.id;
      const next = {
        authorization: sameWorkspace
          ? replica.authorization
          : normalizeWorkspaceAccessState(undefined),
        lastSyncAttemptAt: null,
        lastSyncError: null,
        lastSyncedAt: null,
        outbox: [],
        serverSummary: sameWorkspace ? replica.serverSummary : null,
        state,
        updatedAt: new Date().toISOString(),
      } satisfies LocalReplica;
      await replaceReplicaIfUnchanged(next, replica);
      if (currentWorkspaceId) clearSchedule(currentWorkspaceId);
      setReplica(next);
      if (
        currentWorkspaceId &&
        currentWorkspaceId !== state.workspace.id
      ) {
        broadcastWorkspaceChange({
          type: "replica-removed",
          workspaceId: currentWorkspaceId,
        });
      }
      broadcastWorkspaceChange({
        type: "replica-updated",
        workspaceId: state.workspace.id,
      });
    });
    mutationQueue.current = operation.catch(() => undefined);
    return operation;
  }, [broadcastWorkspaceChange, clearSchedule, replica]);

  const removeWorkspace = useCallback((workspaceId: string, expectedUpdatedAt?: string) => {
    const operation = mutationQueue.current.then(async () => {
      const deletion = await deleteWorkspaceReplica(
        workspaceId,
        expectedUpdatedAt,
      );
      clearRetry(workspaceId);
      clearSchedule(workspaceId);
      if (deletion.catalogAccountId) {
        if (accountIdRef.current === deletion.catalogAccountId) {
          setCatalog(deletion.catalog);
        }
        broadcastWorkspaceChange({
          accountId: deletion.catalogAccountId,
          type: "catalog-updated",
        });
      }
      const workspaces = await listWorkspaceReplicas();
      setLocalWorkspaces(workspaces);
      setReplica((current) =>
        current?.state.workspace.id === workspaceId ? null : current
      );
      broadcastWorkspaceChange({
        type: "replica-removed",
        workspaceId,
      });
    });
    mutationQueue.current = operation.catch(() => undefined);
    return operation;
  }, [broadcastWorkspaceChange, clearRetry, clearSchedule]);

  const setWorkspaceAccess = useCallback((
    workspaceId: string,
    authorization: WorkspaceAccessState,
    summary?: ServerWorkspaceSummary | null,
  ) => {
    const candidate = normalizeWorkspaceAccessState(authorization);
    const confirmedDeletion = isConfirmedDeletedAccess(candidate);
    if (
      confirmedTerminalAccess.current.has(workspaceId) &&
      !confirmedDeletion
    ) {
      return Promise.resolve();
    }
    if (confirmedDeletion) {
      confirmedTerminalAccess.current.set(workspaceId, candidate);
      setConfirmedTerminalAuthorizations((current) => {
        const next = new Map(current);
        next.set(workspaceId, candidate);
        return next;
      });
      clearSchedule(workspaceId);
      clearRetry(workspaceId);
      setReplica((current) =>
        applyConfirmedTerminalAccessInMemory(
          current,
          workspaceId,
          candidate,
        )
      );
      setWorkspaceStatusRevision((current) => current + 1);
    }
    const operation = mutationQueue.current.then(async () => {
      const current = await readWorkspaceReplica(workspaceId);
      if (!current) return;
      const expected = normalizeWorkspaceAccessState(
        current.authorization,
      );
      let next: LocalReplica | null;
      try {
        next = await writeWorkspaceAuthorizationIfUnchanged(
          workspaceId,
          candidate,
          expected,
          summary,
        );
      } catch (error) {
        if (error instanceof WorkspaceAuthorizationConflictError) {
          if (confirmedDeletion) throw error;
          return;
        }
        throw error;
      }
      if (next) {
        setReplica((active) => {
          if (active?.state.workspace.id !== workspaceId) return active;
          const terminal =
            confirmedTerminalAccess.current.get(workspaceId);
          return terminal
            ? applyConfirmedTerminalAccessInMemory(
                next,
                workspaceId,
                terminal,
              )
            : next;
        });
        setWorkspaceStatusRevision((current) => current + 1);
        broadcastWorkspaceChange({
          type: "authorization-updated",
          workspaceId,
        });
      }
    });
    mutationQueue.current = operation.catch(() => undefined);
    return operation;
  }, [broadcastWorkspaceChange, clearRetry, clearSchedule]);

  const hubCards = useMemo(
    () => mergeWorkspaceHub(
      localWorkspaces,
      catalog?.entries ?? [],
      { accountId, online },
    ),
    [accountId, catalog?.entries, localWorkspaces, online],
  );
  const value: StoreValue = {
    account,
    accountId,
    authenticationReady,
    authorization: replica
      ? visibleWorkspaceAccess(
          replica,
          accountId,
          confirmedTerminalAuthorizations.get(
            replica.state.workspace.id,
          ),
        )
      : null,
    backupConfigured,
    blocked: replica?.outbox.filter(entry => entry.status === "blocked").length ?? 0,
    catalogError,
    catalogHasMore: catalog?.hasMore ?? false,
    catalogLoading,
    dispatch,
    hubCards,
    initialize,
    lastSyncAttemptAt: replica?.lastSyncAttemptAt ?? null,
    lastSyncError: replica?.lastSyncError ?? null,
    lastSyncedAt: replica?.lastSyncedAt ?? null,
    loadMoreWorkspaces,
    localUpdatedAt: replica?.updatedAt ?? null,
    online,
    openWorkspace,
    pending: replica?.outbox.filter(entry => entry.status === "pending").length ?? 0,
    refreshWorkspaces,
    removeWorkspace,
    replace,
    setWorkspaceAccess,
    signedIn,
    state: replica?.state ?? null,
    syncing,
    workspaceStatusRevision,
  };
  if (!loaded) return <div className="loading">Opening your local workspace…</div>;
  if (loadError) return <main className="storage-error" role="alert"><h1>On-device storage could not be opened</h1><p>Stowplan has not changed your inventory. Check this browser&apos;s storage or private-browsing settings, then reload.</p><small>{loadError}</small><button onClick={() => location.reload()}>Reload Stowplan</button></main>;
  return <Store.Provider value={value}>{children}</Store.Provider>;
}

export function useStowplan() {
  const value = useContext(Store);
  if (!value) throw new Error("useStowplan requires StowplanProvider");
  return value;
}
