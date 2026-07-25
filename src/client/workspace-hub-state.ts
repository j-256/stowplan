import {
  compareServerWorkspaceSummaries,
  shouldApplyWorkspaceAccess,
  workspaceAccessForAccount,
  workspaceAccountIdsMatch,
  workspaceAccessFromSummary,
  type ServerWorkspaceSummary,
  type WorkspaceAccessState,
  type WorkspaceCapabilities,
  type WorkspaceRole,
} from "../domain/workspace-access";
import type { LocalWorkspaceSummary } from "./local-replica";

export type WorkspaceCardState =
  | "device-only"
  | "server-only"
  | "synchronized"
  | "pending-upload"
  | "blocked"
  | "locally-newer"
  | "server-newer"
  | "offline"
  | "unavailable";

export type WorkspacePresence =
  | "local-only"
  | "server-only"
  | "local-and-server";

export interface WorkspaceHubCard {
  access: WorkspaceAccessState;
  blocked: number;
  capabilities: WorkspaceCapabilities;
  changes: LocalWorkspaceSummary["changes"];
  id: string;
  lastSyncAttemptAt: string | null;
  lastSyncError: string | null;
  lastSyncedAt: string | null;
  localName: string | null;
  localRevision: number | null;
  localUpdatedAt: string | null;
  name: string;
  pending: number;
  presence: WorkspacePresence;
  role: WorkspaceRole | null;
  serverName: string | null;
  serverRevision: number | null;
  serverUpdatedAt: string | null;
  state: WorkspaceCardState;
}

export interface WorkspaceHubMergeOptions {
  accountId?: string | null;
  online: boolean;
}

function newestServerSummary(
  current: ServerWorkspaceSummary | undefined,
  candidate: ServerWorkspaceSummary,
): ServerWorkspaceSummary {
  return !current ||
      compareServerWorkspaceSummaries(candidate, current) >= 0
    ? candidate
    : current;
}

function cardAccess(
  local: LocalWorkspaceSummary | undefined,
  server: ServerWorkspaceSummary | undefined,
  accountId: string | null | undefined,
): WorkspaceAccessState {
  const storedLocalAccess = local?.authorization;
  const localAccess = storedLocalAccess
    ? workspaceAccessForAccount(storedLocalAccess, accountId)
    : undefined;
  if (!server) {
    return localAccess ?? {
      accessRevision: 0,
      capabilities: {
        delete: false,
        leave: false,
        manageAccess: false,
        read: true,
        write: true,
      },
      checkedAt: null,
      kind: "device-only",
      membershipRevision: 0,
      role: "owner",
      status: "active",
    };
  }
  const serverAccess = workspaceAccessFromSummary(server, server.updatedAt);
  if (
    storedLocalAccess?.kind === "server" &&
    !workspaceAccountIdsMatch(
      storedLocalAccess.accountId,
      serverAccess.accountId,
    )
  ) {
    return serverAccess;
  }
  if (!localAccess || shouldApplyWorkspaceAccess(localAccess, serverAccess)) {
    return serverAccess;
  }
  return localAccess;
}

function cardState(
  local: LocalWorkspaceSummary | undefined,
  server: ServerWorkspaceSummary | undefined,
  access: WorkspaceAccessState,
  online: boolean,
): WorkspaceCardState {
  if (
    access.status === "deleted" ||
    access.status === "left" ||
    access.status === "revoked" ||
    access.status === "unknown"
  ) {
    return "unavailable";
  }
  if ((local?.blocked ?? 0) > 0) return "blocked";
  if ((local?.pending ?? 0) > 0) return "pending-upload";
  if (!local) return online ? "server-only" : "offline";
  if (!server) {
    return access.kind === "device-only"
      ? "device-only"
      : "locally-newer";
  }
  const localRevision = local.revision ?? 0;
  if (localRevision > server.revision) return "locally-newer";
  if (localRevision < server.revision) return "server-newer";
  return "synchronized";
}

function newestTimestamp(
  local: LocalWorkspaceSummary | undefined,
  server: ServerWorkspaceSummary | undefined,
): string {
  return [local?.updatedAt, server?.updatedAt]
    .filter((value): value is string => Boolean(value))
    .sort()
    .at(-1) ?? "";
}

export function mergeWorkspaceHub(
  localWorkspaces: readonly LocalWorkspaceSummary[],
  serverWorkspaces: readonly ServerWorkspaceSummary[],
  options: WorkspaceHubMergeOptions,
): WorkspaceHubCard[] {
  const localById = new Map(
    localWorkspaces.map((workspace) => [workspace.id, workspace]),
  );
  const serverById = new Map<string, ServerWorkspaceSummary>();
  for (const local of localWorkspaces) {
    if (!local.serverSummary) continue;
    if (
      local.authorization?.kind === "server" &&
      local.authorization.status !== "active"
    ) {
      continue;
    }
    if (
      options.accountId &&
      local.serverSummary.accountId &&
      !workspaceAccountIdsMatch(
        local.serverSummary.accountId,
        options.accountId,
      )
    ) {
      continue;
    }
    serverById.set(
      local.id,
      newestServerSummary(serverById.get(local.id), local.serverSummary),
    );
  }
  for (const server of serverWorkspaces) {
    serverById.set(
      server.id,
      newestServerSummary(serverById.get(server.id), server),
    );
  }
  const ids = new Set([...localById.keys(), ...serverById.keys()]);
  return [...ids].map((id) => {
    const local = localById.get(id);
    const server = serverById.get(id);
    const access = cardAccess(local, server, options.accountId);
    const visibleServer = local &&
        access.kind === "server" &&
        access.status !== "active"
      ? undefined
      : server;
    const state = cardState(
      local,
      visibleServer,
      access,
      options.online,
    );
    const presence: WorkspacePresence = local && visibleServer
      ? "local-and-server"
      : local
        ? "local-only"
        : "server-only";
    const name = state === "server-newer" ||
        (state === "synchronized" && visibleServer)
      ? visibleServer?.name ?? local?.name ?? id
      : local?.name ?? visibleServer?.name ?? id;
    return {
      access,
      blocked: local?.blocked ?? 0,
      capabilities: access.capabilities,
      changes: local?.changes ?? [],
      id,
      lastSyncAttemptAt: local?.lastSyncAttemptAt ?? null,
      lastSyncError: local?.lastSyncError ?? null,
      lastSyncedAt: local?.lastSyncedAt ?? null,
      localName: local?.name ?? null,
      localRevision: local?.revision ?? null,
      localUpdatedAt: local?.updatedAt ?? null,
      name,
      pending: local?.pending ?? 0,
      presence,
      role: access.kind === "server" && access.status !== "active"
        ? null
        : visibleServer || access.kind === "server"
          ? access.role
          : null,
      serverName: visibleServer?.name ?? null,
      serverRevision: visibleServer?.revision ?? null,
      serverUpdatedAt: visibleServer?.updatedAt ?? null,
      state,
    };
  }).sort((left, right) => {
    const rightUpdated = newestTimestamp(
      localById.get(right.id),
      serverById.get(right.id),
    );
    const leftUpdated = newestTimestamp(
      localById.get(left.id),
      serverById.get(left.id),
    );
    return rightUpdated.localeCompare(leftUpdated) ||
      left.id.localeCompare(right.id);
  });
}

export function workspaceHubCardMatches(
  card: WorkspaceHubCard,
  query: string,
): boolean {
  const normalized = query.trim().toLocaleLowerCase();
  if (!normalized) return true;
  return [
    card.name,
    card.localName,
    card.serverName,
    card.role,
    card.state,
  ].some((value) => value?.toLocaleLowerCase().includes(normalized));
}
