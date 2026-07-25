export const WORKSPACE_ROLES = Object.freeze([
  "owner",
  "editor",
  "viewer",
] as const);

export const WORKSPACE_ACCESS_STATUSES = Object.freeze([
  "active",
  "revoked",
  "left",
  "deleted",
  "unknown",
] as const);

export type WorkspaceRole = (typeof WORKSPACE_ROLES)[number];
export type WorkspaceAccessStatus =
  (typeof WORKSPACE_ACCESS_STATUSES)[number];
export type WorkspaceAccessKind = "device-only" | "server";

export interface WorkspaceCapabilities {
  delete: boolean;
  leave: boolean;
  manageAccess: boolean;
  read: boolean;
  write: boolean;
}

export interface WorkspaceAccessState {
  accountId?: string | null;
  accessRevision: number;
  capabilities: WorkspaceCapabilities;
  checkedAt: string | null;
  kind: WorkspaceAccessKind;
  membershipRevision: number;
  role: WorkspaceRole | null;
  status: WorkspaceAccessStatus;
}

export interface ServerWorkspaceSummary {
  accountId?: string | null;
  accessRevision: number;
  capabilities: WorkspaceCapabilities;
  id: string;
  membershipRevision: number;
  name: string;
  revision: number;
  role: WorkspaceRole;
  updatedAt: string;
}

export interface ServerWorkspaceAccessOptions {
  accountId?: string | null;
  accessRevision?: number;
  canLeave?: boolean;
  checkedAt?: string | null;
  membershipRevision?: number;
  status?: WorkspaceAccessStatus;
}

const WORKSPACE_ROLE_SET = new Set<string>(WORKSPACE_ROLES);
const WORKSPACE_ACCESS_STATUS_SET = new Set<string>(
  WORKSPACE_ACCESS_STATUSES,
);

const WORKSPACE_ROLE_RANK: Readonly<Record<WorkspaceRole, number>> =
  Object.freeze({
    editor: 1,
    owner: 2,
    viewer: 0,
  });

const NO_CAPABILITIES = Object.freeze({
  delete: false,
  leave: false,
  manageAccess: false,
  read: false,
  write: false,
});

const DEVICE_ONLY_CAPABILITIES = Object.freeze({
  delete: false,
  leave: false,
  manageAccess: false,
  read: true,
  write: true,
});

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function nonNegativeInteger(value: unknown, fallback = 0): number {
  return typeof value === "number" &&
      Number.isSafeInteger(value) &&
      value >= 0
    ? value
    : fallback;
}

function optionalString(value: unknown): string | null {
  return typeof value === "string" && value.trim()
    ? value
    : null;
}

export function isWorkspaceRole(value: unknown): value is WorkspaceRole {
  return typeof value === "string" && WORKSPACE_ROLE_SET.has(value);
}

export function isWorkspaceAccessStatus(
  value: unknown,
): value is WorkspaceAccessStatus {
  return typeof value === "string" &&
    WORKSPACE_ACCESS_STATUS_SET.has(value);
}

export function capabilitiesForWorkspaceRole(
  role: WorkspaceRole,
  canLeave = role !== "owner",
): WorkspaceCapabilities {
  return {
    delete: role === "owner",
    leave: canLeave,
    manageAccess: role === "owner",
    read: true,
    write: role === "owner" || role === "editor",
  };
}

export function deviceOnlyWorkspaceAccess(): WorkspaceAccessState {
  return {
    accountId: null,
    accessRevision: 0,
    capabilities: { ...DEVICE_ONLY_CAPABILITIES },
    checkedAt: null,
    kind: "device-only",
    membershipRevision: 0,
    role: "owner",
    status: "active",
  };
}

export function serverWorkspaceAccess(
  role: WorkspaceRole,
  options: ServerWorkspaceAccessOptions = {},
): WorkspaceAccessState {
  const status = options.status ?? "active";
  const active = status === "active";
  return {
    accountId: optionalString(options.accountId),
    accessRevision: nonNegativeInteger(options.accessRevision),
    capabilities: active
      ? capabilitiesForWorkspaceRole(role, options.canLeave)
      : {
          ...NO_CAPABILITIES,
          read: true,
        },
    checkedAt: options.checkedAt ?? null,
    kind: "server",
    membershipRevision: nonNegativeInteger(options.membershipRevision),
    role,
    status,
  };
}

function normalizeCapabilities(
  value: unknown,
  role: WorkspaceRole,
  status: WorkspaceAccessStatus,
): WorkspaceCapabilities {
  if (status !== "active") {
    return {
      ...NO_CAPABILITIES,
      read: true,
    };
  }
  const maximum = capabilitiesForWorkspaceRole(role);
  if (!isRecord(value)) return maximum;
  return {
    delete: maximum.delete && value.delete === true,
    leave: value.leave === true,
    manageAccess: maximum.manageAccess && value.manageAccess === true,
    read: maximum.read && value.read !== false,
    write: maximum.write && value.write === true,
  };
}

export function normalizeWorkspaceAccessState(
  value: unknown,
): WorkspaceAccessState {
  if (!isRecord(value) || value.kind !== "server") {
    return deviceOnlyWorkspaceAccess();
  }
  const role = isWorkspaceRole(value.role) ? value.role : null;
  const status = isWorkspaceAccessStatus(value.status)
    ? value.status
    : role
      ? "active"
      : "unknown";
  if (!role) {
    return {
      accountId: optionalString(value.accountId),
      accessRevision: nonNegativeInteger(value.accessRevision),
      capabilities: {
        ...NO_CAPABILITIES,
        read: true,
      },
      checkedAt: optionalString(value.checkedAt),
      kind: "server",
      membershipRevision: nonNegativeInteger(value.membershipRevision),
      role: null,
      status,
    };
  }
  return {
    accountId: optionalString(value.accountId),
    accessRevision: nonNegativeInteger(value.accessRevision),
    capabilities: normalizeCapabilities(value.capabilities, role, status),
    checkedAt: optionalString(value.checkedAt),
    kind: "server",
    membershipRevision: nonNegativeInteger(value.membershipRevision),
    role,
    status,
  };
}

export function normalizeServerWorkspaceSummary(
  value: unknown,
): ServerWorkspaceSummary | null {
  if (!isRecord(value) || !isWorkspaceRole(value.role)) return null;
  const id = optionalString(value.id);
  const name = optionalString(value.name);
  const updatedAt = optionalString(value.updatedAt);
  if (!id || !name || !updatedAt) return null;
  return {
    accountId: optionalString(value.accountId),
    accessRevision: nonNegativeInteger(value.accessRevision),
    capabilities: normalizeCapabilities(
      value.capabilities,
      value.role,
      "active",
    ),
    id,
    membershipRevision: nonNegativeInteger(value.membershipRevision),
    name,
    revision: nonNegativeInteger(value.revision),
    role: value.role,
    updatedAt,
  };
}

export function workspaceAccountIdsMatch(
  left: string | null | undefined,
  right: string | null | undefined,
): boolean {
  return optionalString(left) === optionalString(right);
}

export function workspaceAccessForAccount(
  value: unknown,
  accountId: string | null | undefined,
): WorkspaceAccessState {
  const access = normalizeWorkspaceAccessState(value);
  const currentAccountId = optionalString(accountId);
  if (
    access.kind !== "server" ||
    !currentAccountId ||
    workspaceAccountIdsMatch(access.accountId, currentAccountId)
  ) {
    return access;
  }
  return {
    accountId: currentAccountId,
    accessRevision: access.accessRevision,
    capabilities: {
      ...NO_CAPABILITIES,
      read: true,
    },
    checkedAt: access.checkedAt,
    kind: "server",
    membershipRevision: access.membershipRevision,
    role: null,
    status: "unknown",
  };
}

export function workspaceAccessFromSummary(
  summary: ServerWorkspaceSummary,
  checkedAt: string,
): WorkspaceAccessState {
  return {
    accountId: optionalString(summary.accountId),
    accessRevision: summary.accessRevision,
    capabilities: normalizeCapabilities(
      summary.capabilities,
      summary.role,
      "active",
    ),
    checkedAt,
    kind: "server",
    membershipRevision: summary.membershipRevision,
    role: summary.role,
    status: "active",
  };
}

export function shouldApplyWorkspaceAccess(
  current: WorkspaceAccessState,
  candidate: WorkspaceAccessState,
): boolean {
  if (candidate.kind === "device-only") return current.kind === "device-only";
  if (current.kind === "device-only") return true;
  const currentAccountId = optionalString(current.accountId);
  const candidateAccountId = optionalString(candidate.accountId);
  if (
    candidateAccountId &&
    candidateAccountId !== currentAccountId
  ) {
    return true;
  }
  if (currentAccountId && !candidateAccountId) return false;
  if (candidate.membershipRevision !== current.membershipRevision) {
    return candidate.membershipRevision > current.membershipRevision;
  }
  if (candidate.accessRevision !== current.accessRevision) {
    return candidate.accessRevision > current.accessRevision;
  }
  if (current.status !== candidate.status) {
    return current.status === "active" && candidate.status !== "active";
  }
  if (current.role !== candidate.role) {
    if (candidate.role === null) return true;
    if (current.role === null) return false;
    return WORKSPACE_ROLE_RANK[candidate.role] <
      WORKSPACE_ROLE_RANK[current.role];
  }
  return !Object.keys(candidate.capabilities).some((capability) => {
    const key = capability as keyof WorkspaceCapabilities;
    return candidate.capabilities[key] && !current.capabilities[key];
  });
}

export function compareServerWorkspaceSummaries(
  left: ServerWorkspaceSummary,
  right: ServerWorkspaceSummary,
): number {
  if (left.membershipRevision !== right.membershipRevision) {
    return left.membershipRevision - right.membershipRevision;
  }
  if (left.accessRevision !== right.accessRevision) {
    return left.accessRevision - right.accessRevision;
  }
  if (left.revision !== right.revision) return left.revision - right.revision;
  return left.updatedAt.localeCompare(right.updatedAt);
}

export function workspaceReadOnlyReason(
  access: WorkspaceAccessState,
): string | null {
  if (access.capabilities.write) return null;
  if (access.status === "deleted") {
    return "The server workspace was deleted. This retained device copy is read-only.";
  }
  if (access.status === "left") {
    return "You left this workspace. This retained device copy is read-only.";
  }
  if (access.status === "revoked") {
    return "Your workspace access was removed. This retained device copy is read-only.";
  }
  if (access.role === "viewer") {
    return "Viewer access allows browsing and export, but not editing.";
  }
  return "Editing is unavailable until workspace access can be confirmed.";
}

export class WorkspacePermissionError extends Error {
  readonly code = "WORKSPACE_READ_ONLY";

  constructor(message: string) {
    super(message);
    this.name = "WorkspacePermissionError";
  }
}

export function requireWorkspaceWriteAccess(
  access: WorkspaceAccessState,
): void {
  const reason = workspaceReadOnlyReason(access);
  if (reason) throw new WorkspacePermissionError(reason);
}
