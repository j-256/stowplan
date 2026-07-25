"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  capabilitiesForWorkspaceRole,
  isWorkspaceRole,
  normalizeServerWorkspaceSummary,
  normalizeWorkspaceAccessState,
  serverWorkspaceAccess,
  shouldApplyWorkspaceAccess,
  workspaceAccountIdsMatch,
  type ServerWorkspaceSummary,
  type WorkspaceAccessState,
  type WorkspaceRole,
} from "../domain/workspace-access";
import {
  readWorkspaceReplica,
} from "./local-replica";
import {
  RetainedWorkspaceAccess,
  WorkspaceAccess,
  type ChangeWorkspaceMemberRoleInput,
  type ChangeWorkspaceMemberRoleResult,
  type CreateWorkspaceGuestLinkInput,
  type CreateWorkspaceGuestLinkResult,
  type DeleteServerWorkspaceInput,
  type DeleteServerWorkspaceResult,
  type GuestLinkStatusFilter,
  type LeaveWorkspaceInput,
  type LeaveWorkspaceResult,
  type RemoveWorkspaceMemberInput,
  type RemoveWorkspaceMemberResult,
  type RevokeWorkspaceGuestLinkInput,
  type RevokeWorkspaceGuestLinkResult,
  type TransferWorkspaceOwnershipInput,
  type TransferWorkspaceOwnershipResult,
  type WorkspaceAccessActions,
  type WorkspaceAccessData,
  type WorkspaceAccessPage,
  type TerminalWorkspaceAccessStatus,
  type WorkspaceGuestLink,
  type WorkspaceGuestLinksResult,
  type WorkspaceMember,
  type WorkspaceMembersResult,
} from "./workspace-access";
import {
  accountContextHeaders,
  responseMatchesAccount,
} from "../shared/account-context";

const INVALID_ACCESS_RESPONSE =
  "The server returned invalid workspace access data";
const MAXIMUM_VISIBLE_ERROR_LENGTH = 500;
export const TERMINAL_ACCESS_PERSISTENCE_WARNING =
  "The server workspace was deleted and editing is blocked in this tab, but this device could not save that read-only state. Retry before closing or reloading Stowplan.";

interface TerminalAccessPersistenceOutcome<Result> {
  persisted: boolean;
  result: Result;
  warning: string | null;
}

interface PendingTerminalAccessPersistence {
  authorization: WorkspaceAccessState;
  summary: ServerWorkspaceSummary;
}

interface WorkspaceAccessControllerProps {
  authorization: WorkspaceAccessState;
  currentUserId: string | null;
  localUpdatedAt: string | null;
  onAccessChange: (
    workspaceId: string,
    authorization: WorkspaceAccessState,
    summary?: ServerWorkspaceSummary | null,
  ) => Promise<void>;
  onOpenWorkspaceHub: () => void;
  onRemoveLocal: (
    workspaceId: string,
    expectedUpdatedAt?: string,
  ) => Promise<void>;
  returnTo?: string;
  workspaceId: string;
}

export async function persistConfirmedTerminalAccess<Result>(
  result: Result,
  persist: () => Promise<void>,
): Promise<TerminalAccessPersistenceOutcome<Result>> {
  try {
    await persist();
    return {
      persisted: true,
      result,
      warning: null,
    };
  } catch {
    return {
      persisted: false,
      result,
      warning: TERMINAL_ACCESS_PERSISTENCE_WARNING,
    };
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" &&
    !Array.isArray(value);
}

function safeInteger(value: unknown): value is number {
  return typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= 0;
}

function parsePage(value: unknown): WorkspaceAccessPage | null {
  if (
    !isRecord(value) ||
    typeof value.hasMore !== "boolean" ||
    !safeInteger(value.limit) ||
    value.limit < 1 ||
    (
      value.nextCursor !== null &&
      typeof value.nextCursor !== "string"
    )
  ) {
    return null;
  }
  if (value.hasMore && !value.nextCursor) return null;
  return {
    hasMore: value.hasMore,
    limit: value.limit,
    nextCursor: value.nextCursor as string | null,
  };
}

function parseMember(value: unknown): WorkspaceMember | null {
  if (
    !isRecord(value) ||
    typeof value.createdAt !== "string" ||
    typeof value.displayName !== "string" ||
    (
      value.email !== null &&
      typeof value.email !== "string"
    ) ||
    (
      value.identityKind !== "account" &&
      value.identityKind !== "guest"
    ) ||
    !safeInteger(value.membershipRevision) ||
    !isWorkspaceRole(value.role) ||
    typeof value.userId !== "string" ||
    !value.userId
  ) {
    return null;
  }
  return value as unknown as WorkspaceMember;
}

function parseGuestLink(value: unknown): WorkspaceGuestLink | null {
  if (
    !isRecord(value) ||
    typeof value.createdAt !== "string" ||
    typeof value.expiresAt !== "string" ||
    typeof value.guestLinkId !== "string" ||
    !value.guestLinkId ||
    (
      value.revokedAt !== null &&
      typeof value.revokedAt !== "string"
    ) ||
    (value.role !== "editor" && value.role !== "viewer") ||
    !["active", "used", "expired", "revoked"].includes(
      String(value.status),
    ) ||
    (
      value.usedAt !== null &&
      typeof value.usedAt !== "string"
    )
  ) {
    return null;
  }
  return value as unknown as WorkspaceGuestLink;
}

function parseAccessData(value: unknown): WorkspaceAccessData | null {
  if (!isRecord(value) || !isRecord(value.access)) return null;
  const workspace = normalizeServerWorkspaceSummary(value.workspace);
  if (
    !workspace ||
    !isWorkspaceRole(value.access.role) ||
    !safeInteger(value.access.accessRevision) ||
    !safeInteger(value.access.membershipRevision) ||
    value.access.role !== workspace.role ||
    value.access.accessRevision !== workspace.accessRevision ||
    value.access.membershipRevision !== workspace.membershipRevision ||
    !isRecord(value.guestLinkPolicy) ||
    !safeInteger(value.guestLinkPolicy.minimumExpiryHours) ||
    !safeInteger(value.guestLinkPolicy.maximumExpiryHours) ||
    !Array.isArray(value.guestLinkPolicy.roles) ||
    value.guestLinkPolicy.roles.some(
      role => role !== "editor" && role !== "viewer",
    )
  ) {
    return null;
  }
  const usage = isRecord(value.usage) &&
      isRecord(value.usage.activeGuestLinks) &&
      isRecord(value.usage.members) &&
      isRecord(value.usage.retainedGuestLinks) &&
      safeInteger(value.usage.activeGuestLinks.limit) &&
      safeInteger(value.usage.activeGuestLinks.used) &&
      safeInteger(value.usage.members.limit) &&
      safeInteger(value.usage.members.used) &&
      safeInteger(value.usage.owners) &&
      safeInteger(value.usage.retainedGuestLinks.limit) &&
      safeInteger(value.usage.retainedGuestLinks.used)
    ? value.usage as unknown as WorkspaceAccessData["usage"]
    : undefined;
  return {
    access: {
      accessRevision: workspace.accessRevision,
      capabilities: workspace.capabilities,
      membershipRevision: workspace.membershipRevision,
      role: workspace.role,
    },
    guestLinkPolicy: {
      maximumExpiryHours: value.guestLinkPolicy.maximumExpiryHours,
      minimumExpiryHours: value.guestLinkPolicy.minimumExpiryHours,
      roles: [...value.guestLinkPolicy.roles] as ("editor" | "viewer")[],
    },
    ...(usage ? { usage } : {}),
    workspace,
  };
}

function parseMembersResult(value: unknown): WorkspaceMembersResult | null {
  if (
    !isRecord(value) ||
    !safeInteger(value.accessRevision) ||
    !Array.isArray(value.members)
  ) {
    return null;
  }
  const page = parsePage(value.page);
  const members = value.members.map(parseMember);
  if (!page || members.some(member => member === null)) return null;
  return {
    accessRevision: value.accessRevision,
    members: members as WorkspaceMember[],
    page,
  };
}

function parseGuestLinksResult(
  value: unknown,
): WorkspaceGuestLinksResult | null {
  if (
    !isRecord(value) ||
    !safeInteger(value.accessRevision) ||
    !Array.isArray(value.guestLinks)
  ) {
    return null;
  }
  const page = parsePage(value.page);
  const guestLinks = value.guestLinks.map(parseGuestLink);
  if (!page || guestLinks.some(link => link === null)) return null;
  return {
    accessRevision: value.accessRevision,
    guestLinks: guestLinks as WorkspaceGuestLink[],
    page,
  };
}

export function visibleWorkspaceAccessData(
  data: WorkspaceAccessData,
  authorization: WorkspaceAccessState,
  currentUserId: string,
): WorkspaceAccessData | null {
  const sameMembershipRevision =
    authorization.membershipRevision === data.access.membershipRevision;
  const sameAccessRevision =
    authorization.accessRevision === data.access.accessRevision;
  const loadedAuthorization = normalizeWorkspaceAccessState({
    accountId: currentUserId,
    accessRevision: data.access.accessRevision,
    capabilities: data.access.capabilities,
    checkedAt: null,
    kind: "server",
    membershipRevision: data.access.membershipRevision,
    role: data.access.role,
    status: "active",
  });
  const equalVersionCapabilityTightening =
    sameMembershipRevision &&
    sameAccessRevision &&
    authorization.status === "active" &&
    authorization.role === data.access.role &&
    shouldApplyWorkspaceAccess(loadedAuthorization, authorization);
  const authorizationIsCurrent =
    authorization.kind === "server" &&
    workspaceAccountIdsMatch(
      authorization.accountId,
      currentUserId,
    ) &&
    (
      authorization.status !== "active" ||
      authorization.membershipRevision >
        data.access.membershipRevision ||
      (
        sameMembershipRevision &&
        authorization.accessRevision > data.access.accessRevision
      ) ||
      equalVersionCapabilityTightening
    );
  if (!authorizationIsCurrent) return data;
  if (
    authorization.status !== "active" ||
    authorization.role === null
  ) {
    return null;
  }
  return {
    ...data,
    access: {
      ...data.access,
      accessRevision: Math.max(
        data.access.accessRevision,
        authorization.accessRevision,
      ),
      capabilities: authorization.capabilities,
      membershipRevision: Math.max(
        data.access.membershipRevision,
        authorization.membershipRevision,
      ),
      role: authorization.role,
    },
  };
}

async function requestJson(
  url: string,
  accountId: string | null,
  init?: RequestInit,
): Promise<unknown> {
  if (!accountId) throw new Error("Sign in to review workspace access");
  const response = await fetch(url, {
    cache: "no-store",
    ...init,
    headers: accountContextHeaders(accountId, init?.headers),
  });
  const body = await response.json().catch(() => null);
  if (!response.ok) {
    const message = isRecord(body) && typeof body.error === "string"
      ? body.error.slice(0, MAXIMUM_VISIBLE_ERROR_LENGTH)
      : `The server request failed (${response.status})`;
    throw new Error(message);
  }
  if (!responseMatchesAccount(response, accountId)) {
    throw new Error(
      "The signed-in account changed; refresh before continuing",
    );
  }
  return body;
}

function mutationRequest(
  url: string,
  accountId: string | null,
  method: "DELETE" | "PATCH" | "POST",
  body: unknown,
): Promise<unknown> {
  return requestJson(url, accountId, {
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
    method,
  });
}

function mergeMembers(
  current: WorkspaceMembersResult | null,
  incoming: WorkspaceMembersResult,
): WorkspaceMembersResult {
  const members = new Map(
    current?.members.map(member => [member.userId, member]) ?? [],
  );
  for (const member of incoming.members) members.set(member.userId, member);
  return {
    ...incoming,
    members: [...members.values()].sort((left, right) =>
      left.createdAt.localeCompare(right.createdAt) ||
      left.userId.localeCompare(right.userId)
    ),
  };
}

function mergeGuestLinks(
  current: WorkspaceGuestLinksResult | null,
  incoming: WorkspaceGuestLinksResult,
): WorkspaceGuestLinksResult {
  const guestLinks = new Map(
    current?.guestLinks.map(link => [link.guestLinkId, link]) ?? [],
  );
  for (const link of incoming.guestLinks) {
    guestLinks.set(link.guestLinkId, link);
  }
  return {
    ...incoming,
    guestLinks: [...guestLinks.values()].sort((left, right) =>
      right.createdAt.localeCompare(left.createdAt) ||
      left.guestLinkId.localeCompare(right.guestLinkId)
    ),
  };
}

function downloadRecoveryBundle(
  workspaceId: string,
): Promise<void> {
  return readWorkspaceReplica(workspaceId).then((replica) => {
    if (!replica) {
      throw new Error("The local workspace is no longer available");
    }
    const url = URL.createObjectURL(new Blob(
      [JSON.stringify({
        exportedAt: new Date().toISOString(),
        format: "stowplan-recovery-v1",
        replica,
      }, null, 2)],
      { type: "application/json" },
    ));
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `stowplan-recovery-${workspaceId}.json`;
    anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 0);
  });
}

export function WorkspaceAccessController({
  authorization,
  currentUserId,
  localUpdatedAt,
  onAccessChange,
  onOpenWorkspaceHub,
  onRemoveLocal,
  returnTo,
  workspaceId,
}: WorkspaceAccessControllerProps) {
  const [data, setData] = useState<WorkspaceAccessData | null>(null);
  const [memberResult, setMemberResult] =
    useState<WorkspaceMembersResult | null>(null);
  const [guestLinkResult, setGuestLinkResult] =
    useState<WorkspaceGuestLinksResult | null>(null);
  const memberQuery = useRef("");
  const guestStatus = useRef<GuestLinkStatusFilter>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const requestVersion = useRef(0);
  const [localTerminalTransition, setLocalTerminalTransition] = useState<
    Extract<TerminalWorkspaceAccessStatus, "deleted" | "left"> | null
  >(null);
  const [confirmedTerminalStatus, setConfirmedTerminalStatus] = useState<
    Extract<TerminalWorkspaceAccessStatus, "deleted"> | null
  >(null);
  const [terminalPersistenceWarning, setTerminalPersistenceWarning] =
    useState<string | null>(null);
  const pendingTerminalPersistence =
    useRef<PendingTerminalAccessPersistence | null>(null);
  const authoritativeTerminalStatus: TerminalWorkspaceAccessStatus | null =
    authorization.kind === "server" &&
      (
        authorization.status !== "active" ||
        authorization.role === null
      )
      ? authorization.status === "active"
        ? "unknown"
        : authorization.status
      : null;
  const terminalStatus =
    confirmedTerminalStatus ?? authoritativeTerminalStatus;

  const accessUrl = `/api/workspaces/${encodeURIComponent(workspaceId)}/access`;
  const membersUrl =
    `/api/workspaces/${encodeURIComponent(workspaceId)}/members`;
  const guestLinksUrl =
    `/api/workspaces/${encodeURIComponent(workspaceId)}/guest-links`;

  const persistAccess = useCallback(async (
    role: WorkspaceRole,
    accessRevision: number,
    membershipRevision: number,
    canLeave: boolean,
    summary: ServerWorkspaceSummary,
  ) => {
    const capabilities = capabilitiesForWorkspaceRole(role, canLeave);
    await onAccessChange(
      workspaceId,
      serverWorkspaceAccess(role, {
        accountId: currentUserId,
        accessRevision,
        canLeave,
        checkedAt: new Date().toISOString(),
        membershipRevision,
      }),
      {
        ...summary,
        accountId: currentUserId,
        accessRevision,
        capabilities,
        membershipRevision,
        role,
      },
    );
  }, [currentUserId, onAccessChange, workspaceId]);

  const loadAccess = useCallback(async (
    options: { includeLists: boolean; surfaceError: boolean },
  ) => {
    const version = requestVersion.current + 1;
    requestVersion.current = version;
    if (options.surfaceError) setError(null);
    const rawAccess = await requestJson(accessUrl, currentUserId);
    const nextData = parseAccessData(rawAccess);
    if (!nextData || nextData.workspace.id !== workspaceId) {
      throw new Error(INVALID_ACCESS_RESPONSE);
    }
    if (requestVersion.current !== version) return;
    setData(nextData);
    await persistAccess(
      nextData.access.role,
      nextData.access.accessRevision,
      nextData.access.membershipRevision,
      nextData.access.capabilities.leave,
      nextData.workspace,
    );
    if (
      !options.includeLists ||
      !nextData.access.capabilities.manageAccess
    ) {
      if (!nextData.access.capabilities.manageAccess) {
        setMemberResult(null);
        setGuestLinkResult(null);
      }
      return;
    }
    const memberSearch = new URLSearchParams();
    if (memberQuery.current) {
      memberSearch.set("q", memberQuery.current);
    }
    const guestSearch = new URLSearchParams();
    if (guestStatus.current) {
      guestSearch.set("status", guestStatus.current);
    }
    const [rawMembers, rawGuestLinks] = await Promise.all([
      requestJson(
        `${membersUrl}?${memberSearch.toString()}`,
        currentUserId,
      ),
      requestJson(
        `${guestLinksUrl}?${guestSearch.toString()}`,
        currentUserId,
      ),
    ]);
    const nextMembers = parseMembersResult(rawMembers);
    const nextGuestLinks = parseGuestLinksResult(rawGuestLinks);
    if (!nextMembers || !nextGuestLinks) {
      throw new Error(INVALID_ACCESS_RESPONSE);
    }
    if (requestVersion.current !== version) return;
    setMemberResult(nextMembers);
    setGuestLinkResult(nextGuestLinks);
  }, [
    accessUrl,
    currentUserId,
    guestLinksUrl,
    membersUrl,
    persistAccess,
    workspaceId,
  ]);

  useEffect(() => {
    if (terminalStatus) {
      requestVersion.current += 1;
      return;
    }
    let active = true;
    void Promise.resolve()
      .then(() => loadAccess({
        includeLists: true,
        surfaceError: true,
      }))
      .catch((failure) => {
        if (!active) return;
        setError(
          failure instanceof Error
            ? failure.message
            : "Could not load workspace access",
        );
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
      requestVersion.current += 1;
    };
  }, [loadAccess, terminalStatus]);

  const reconcileAfterMutation = useCallback(() => {
    void loadAccess({ includeLists: false, surfaceError: false })
      .catch(() => {
        setError(
          "The server confirmed the change, but access status could not be refreshed. Refresh before another access change.",
        );
      });
  }, [loadAccess]);

  const retryTerminalPersistence = useCallback(async () => {
    const pending = pendingTerminalPersistence.current;
    if (!pending) {
      setTerminalPersistenceWarning(null);
      return;
    }
    const outcome = await persistConfirmedTerminalAccess(
      undefined,
      () => onAccessChange(
        workspaceId,
        pending.authorization,
        pending.summary,
      ),
    );
    if (!outcome.persisted) {
      setTerminalPersistenceWarning(outcome.warning);
      throw new Error(outcome.warning ??
        TERMINAL_ACCESS_PERSISTENCE_WARNING);
    }
    pendingTerminalPersistence.current = null;
    setTerminalPersistenceWarning(null);
  }, [onAccessChange, workspaceId]);

  const actions = useMemo<WorkspaceAccessActions>(() => ({
    changeMemberRole: async (
      userId: string,
      input: ChangeWorkspaceMemberRoleInput,
    ) => {
      const value = await mutationRequest(
        `${membersUrl}/${encodeURIComponent(userId)}`,
        currentUserId,
        "PATCH",
        input,
      ) as ChangeWorkspaceMemberRoleResult;
      if (
        !isRecord(value) ||
        !safeInteger(value.accessRevision) ||
        !parseMember(value.member)
      ) {
        throw new Error(INVALID_ACCESS_RESPONSE);
      }
      if (data && userId === currentUserId) {
        await persistAccess(
          value.member.role,
          value.accessRevision,
          value.member.membershipRevision,
          value.member.role !== "owner",
          data.workspace,
        );
      }
      reconcileAfterMutation();
      return value;
    },
    createGuestLink: async (input: CreateWorkspaceGuestLinkInput) => {
      const value = await mutationRequest(
        guestLinksUrl,
        currentUserId,
        "POST",
        input,
      ) as CreateWorkspaceGuestLinkResult;
      if (
        !isRecord(value) ||
        !safeInteger(value.accessRevision) ||
        !parseGuestLink(value.guestLink) ||
        typeof value.oneTimeUrl !== "string" ||
        !value.oneTimeUrl
      ) {
        throw new Error(INVALID_ACCESS_RESPONSE);
      }
      reconcileAfterMutation();
      return value;
    },
    deleteServerWorkspace: async (input: DeleteServerWorkspaceInput) => {
      setLocalTerminalTransition("deleted");
      let value: DeleteServerWorkspaceResult;
      try {
        value = await mutationRequest(
          `/api/workspaces/${encodeURIComponent(workspaceId)}`,
          currentUserId,
          "DELETE",
          input,
        ) as DeleteServerWorkspaceResult;
      } catch (failure) {
        setLocalTerminalTransition(null);
        throw failure;
      }
      if (
        !isRecord(value) ||
        value.deleted !== true ||
        !safeInteger(value.finalAccessRevision) ||
        typeof value.deletedAt !== "string"
      ) {
        setLocalTerminalTransition(null);
        throw new Error(INVALID_ACCESS_RESPONSE);
      }
      if (data) {
        const pending = {
          authorization: normalizeWorkspaceAccessState({
            accountId: currentUserId,
            accessRevision: value.finalAccessRevision,
            capabilities: {
              delete: false,
              leave: false,
              manageAccess: false,
              read: true,
              write: false,
            },
            checkedAt: value.deletedAt,
            kind: "server",
            membershipRevision: data.access.membershipRevision + 1,
            role: data.access.role,
            status: "deleted",
          }),
          summary: {
            ...data.workspace,
            accountId: currentUserId,
          },
        };
        pendingTerminalPersistence.current = pending;
        setConfirmedTerminalStatus("deleted");
        const outcome = await persistConfirmedTerminalAccess(
          value,
          () => onAccessChange(
            workspaceId,
            pending.authorization,
            pending.summary,
          ),
        );
        if (outcome.persisted) {
          pendingTerminalPersistence.current = null;
        }
        setTerminalPersistenceWarning(outcome.warning);
        return outcome.result;
      }
      return value;
    },
    exportLocalRecovery: () => downloadRecoveryBundle(workspaceId),
    filterGuestLinks: async (status: GuestLinkStatusFilter) => {
      const search = new URLSearchParams();
      if (status) search.set("status", status);
      const value = parseGuestLinksResult(
        await requestJson(
          `${guestLinksUrl}?${search.toString()}`,
          currentUserId,
        ),
      );
      if (!value) throw new Error(INVALID_ACCESS_RESPONSE);
      guestStatus.current = status;
      setGuestLinkResult(value);
    },
    leaveWorkspace: async (input: LeaveWorkspaceInput) => {
      setLocalTerminalTransition("left");
      let value: LeaveWorkspaceResult;
      try {
        value = await mutationRequest(
          `/api/workspaces/${encodeURIComponent(workspaceId)}/membership`,
          currentUserId,
          "DELETE",
          input,
        ) as LeaveWorkspaceResult;
      } catch (failure) {
        setLocalTerminalTransition(null);
        throw failure;
      }
      if (
        !isRecord(value) ||
        value.left !== true ||
        !safeInteger(value.accessRevision) ||
        !safeInteger(value.membershipRevision)
      ) {
        throw new Error(INVALID_ACCESS_RESPONSE);
      }
      if (data) {
        await onAccessChange(
          workspaceId,
          normalizeWorkspaceAccessState({
            accountId: currentUserId,
            accessRevision: value.accessRevision,
            capabilities: {
              delete: false,
              leave: false,
              manageAccess: false,
              read: true,
              write: false,
            },
            checkedAt: new Date().toISOString(),
            kind: "server",
            membershipRevision: value.membershipRevision,
            role: data.access.role,
            status: "left",
          }),
          {
            ...data.workspace,
            accountId: currentUserId,
          },
        );
      }
      return value;
    },
    loadMoreGuestLinks: async (cursor: string) => {
      const search = new URLSearchParams({ cursor });
      if (guestStatus.current) {
        search.set("status", guestStatus.current);
      }
      const value = parseGuestLinksResult(
        await requestJson(
          `${guestLinksUrl}?${search.toString()}`,
          currentUserId,
        ),
      );
      if (!value) throw new Error(INVALID_ACCESS_RESPONSE);
      setGuestLinkResult(current => mergeGuestLinks(current, value));
    },
    loadMoreMembers: async (cursor: string) => {
      const search = new URLSearchParams({ cursor });
      if (memberQuery.current) {
        search.set("q", memberQuery.current);
      }
      const value = parseMembersResult(
        await requestJson(
          `${membersUrl}?${search.toString()}`,
          currentUserId,
        ),
      );
      if (!value) throw new Error(INVALID_ACCESS_RESPONSE);
      setMemberResult(current => mergeMembers(current, value));
    },
    refresh: async () => {
      await loadAccess({ includeLists: true, surfaceError: true });
    },
    removeLocalReplica: async () => {
      await onRemoveLocal(
        workspaceId,
        localUpdatedAt ?? undefined,
      );
      onOpenWorkspaceHub();
    },
    removeMember: async (
      userId: string,
      input: RemoveWorkspaceMemberInput,
    ) => {
      const value = await mutationRequest(
        `${membersUrl}/${encodeURIComponent(userId)}`,
        currentUserId,
        "DELETE",
        input,
      ) as RemoveWorkspaceMemberResult;
      if (
        !isRecord(value) ||
        !safeInteger(value.accessRevision) ||
        !isRecord(value.removed) ||
        value.removed.userId !== userId
      ) {
        throw new Error(INVALID_ACCESS_RESPONSE);
      }
      reconcileAfterMutation();
      return value;
    },
    revokeGuestLink: async (
      guestLinkId: string,
      input: RevokeWorkspaceGuestLinkInput,
    ) => {
      const value = await mutationRequest(
        `${guestLinksUrl}/${encodeURIComponent(guestLinkId)}`,
        currentUserId,
        "DELETE",
        input,
      ) as RevokeWorkspaceGuestLinkResult;
      if (
        !isRecord(value) ||
        !safeInteger(value.accessRevision) ||
        !parseGuestLink(value.guestLink)
      ) {
        throw new Error(INVALID_ACCESS_RESPONSE);
      }
      reconcileAfterMutation();
      return value;
    },
    searchMembers: async (query: string) => {
      const search = new URLSearchParams();
      if (query) search.set("q", query);
      const value = parseMembersResult(
        await requestJson(
          `${membersUrl}?${search.toString()}`,
          currentUserId,
        ),
      );
      if (!value) throw new Error(INVALID_ACCESS_RESPONSE);
      memberQuery.current = query;
      setMemberResult(value);
    },
    transferOwnership: async (
      input: TransferWorkspaceOwnershipInput,
    ) => {
      const value = await mutationRequest(
        `/api/workspaces/${encodeURIComponent(workspaceId)}/ownership-transfers`,
        currentUserId,
        "POST",
        input,
      ) as TransferWorkspaceOwnershipResult;
      const actor = isRecord(value) ? parseMember(value.actor) : null;
      const target = isRecord(value) ? parseMember(value.target) : null;
      if (
        !isRecord(value) ||
        !safeInteger(value.accessRevision) ||
        !actor ||
        !target
      ) {
        throw new Error(INVALID_ACCESS_RESPONSE);
      }
      if (data) {
        await persistAccess(
          actor.role,
          value.accessRevision,
          actor.membershipRevision,
          actor.role !== "owner",
          data.workspace,
        );
      }
      reconcileAfterMutation();
      return value;
    },
  }), [
    currentUserId,
    data,
    guestLinksUrl,
    loadAccess,
    localUpdatedAt,
    membersUrl,
    onAccessChange,
    onOpenWorkspaceHub,
    onRemoveLocal,
    persistAccess,
    reconcileAfterMutation,
    workspaceId,
  ]);

  const preserveLocalLifecycle = Boolean(
    data &&
    terminalStatus &&
    localTerminalTransition === terminalStatus,
  );
  if (terminalStatus && !preserveLocalLifecycle) {
    return <RetainedWorkspaceAccess
      onOpenWorkspaceHub={onOpenWorkspaceHub}
      status={terminalStatus}
    />;
  }
  if (!currentUserId) {
    return <section role="alert">
      Sign in to review workspace access.
    </section>;
  }
  if (loading && !data) {
    return <div className="loading">Loading workspace access...</div>;
  }
  if (!data) {
    return <section role="alert">
      <h2>Workspace access is unavailable</h2>
      <p>{error ?? "Could not load workspace access."}</p>
      <button
        onClick={() => {
          setLoading(true);
          void loadAccess({ includeLists: true, surfaceError: true })
            .catch((failure) => setError(
              failure instanceof Error
                ? failure.message
                : "Could not load workspace access",
            ))
            .finally(() => setLoading(false));
        }}
        type="button"
      >
        Try again
      </button>
    </section>;
  }
  const visibleData = preserveLocalLifecycle
    ? data
    : visibleWorkspaceAccessData(
        data,
        authorization,
        currentUserId,
      );
  if (!visibleData) {
    return <RetainedWorkspaceAccess
      onOpenWorkspaceHub={onOpenWorkspaceHub}
      status="unknown"
    />;
  }
  return <WorkspaceAccess
    actions={actions}
    currentUserId={currentUserId}
    data={visibleData}
    guestLinkResult={guestLinkResult}
    initialError={error}
    memberResult={memberResult}
    onRetryTerminalPersistence={retryTerminalPersistence}
    returnTo={returnTo}
    terminalPersistenceWarning={terminalPersistenceWarning}
    terminalStatus={preserveLocalLifecycle
      ? localTerminalTransition
      : null}
  />;
}
