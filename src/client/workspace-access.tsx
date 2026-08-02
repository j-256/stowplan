"use client";

import {
  useId,
  useMemo,
  useRef,
  useState,
  type FormEvent,
} from "react";
import {
  capabilitiesForWorkspaceRole,
  type ServerWorkspaceSummary,
  type WorkspaceAccessStatus,
  type WorkspaceCapabilities,
  type WorkspaceRole,
} from "../domain/workspace-access";
import { GUEST_LINK_EXPIRY_HOURS } from "../shared/api-quotas";
import { ModalDialog } from "./modal-dialog";
import styles from "./workspace-access.module.css";

const MEMBER_ROLES = Object.freeze([
  "viewer",
  "editor",
  "owner",
] as const);
const GUEST_LINK_ROLES = Object.freeze([
  "viewer",
  "editor",
] as const);
const GUEST_LINK_STATUSES = Object.freeze([
  "active",
  "used",
  "expired",
  "revoked",
] as const);
const TERMINAL_ACCESS_COPY = Object.freeze({
  deleted: {
    detail:
      "The server workspace was deleted immediately and cannot be recovered. This retained device copy is read-only and is no longer backed up.",
    title: "Server workspace deleted",
  },
  left: {
    detail:
      "You left the server workspace. This retained device copy is read-only and is no longer backed up.",
    title: "Server membership ended",
  },
  revoked: {
    detail:
      "Your server membership was removed. This retained device copy is read-only and is no longer backed up.",
    title: "Workspace access removed",
  },
  unknown: {
    detail:
      "Active server access cannot be confirmed for this account. This retained device copy remains read-only unless a later signed-in reconciliation restores access.",
    title: "Workspace access unavailable",
  },
} satisfies Record<TerminalWorkspaceAccessStatus, {
  detail: string;
  title: string;
}>);

export type GuestLinkRole = (typeof GUEST_LINK_ROLES)[number];
export type GuestLinkStatus = (typeof GUEST_LINK_STATUSES)[number];
export type GuestLinkStatusFilter = GuestLinkStatus | null;
export type TerminalWorkspaceAccessStatus =
  Exclude<WorkspaceAccessStatus, "active">;

export interface WorkspaceAccessSnapshot {
  accessRevision: number;
  capabilities: WorkspaceCapabilities;
  membershipRevision: number;
  role: WorkspaceRole;
}

export interface WorkspaceAccessUsageCounter {
  limit: number;
  used: number;
}

export interface WorkspaceAccessUsage {
  activeGuestLinks: WorkspaceAccessUsageCounter;
  members: WorkspaceAccessUsageCounter;
  owners: number;
  retainedGuestLinks: WorkspaceAccessUsageCounter;
}

export interface WorkspaceAccessData {
  access: WorkspaceAccessSnapshot;
  guestLinkPolicy: {
    maximumExpiryHours: number;
    minimumExpiryHours: number;
    roles: GuestLinkRole[];
  };
  usage?: WorkspaceAccessUsage;
  workspace: ServerWorkspaceSummary;
}

export interface WorkspaceAccessPage {
  hasMore: boolean;
  limit: number;
  nextCursor: string | null;
}

export interface WorkspaceMember {
  createdAt: string;
  displayName: string;
  email: string | null;
  identityKind: "account" | "guest";
  membershipRevision: number;
  role: WorkspaceRole;
  userId: string;
}

export interface WorkspaceGuestLink {
  createdAt: string;
  expiresAt: string;
  guestLinkId: string;
  revokedAt: string | null;
  role: GuestLinkRole;
  status: GuestLinkStatus;
  usedAt: string | null;
}

export interface WorkspaceMembersResult {
  accessRevision: number;
  members: WorkspaceMember[];
  page: WorkspaceAccessPage;
}

export interface WorkspaceGuestLinksResult {
  accessRevision: number;
  guestLinks: WorkspaceGuestLink[];
  page: WorkspaceAccessPage;
}

export interface ChangeWorkspaceMemberRoleInput {
  expectedAccessRevision: number;
  expectedMembershipRevision: number;
  role: WorkspaceRole;
}

export interface ChangeWorkspaceMemberRoleResult {
  accessRevision: number;
  member: WorkspaceMember;
}

export interface RemoveWorkspaceMemberInput {
  expectedAccessRevision: number;
  expectedMembershipRevision: number;
}

export interface RemoveWorkspaceMemberResult {
  accessRevision: number;
  removed: {
    at: string;
    role: WorkspaceRole;
    userId: string;
  };
}

export interface TransferWorkspaceOwnershipInput {
  expectedAccessRevision: number;
  expectedActorMembershipRevision: number;
  expectedTargetMembershipRevision: number;
  targetUserId: string;
}

export interface TransferWorkspaceOwnershipResult {
  accessRevision: number;
  actor: WorkspaceMember;
  target: WorkspaceMember;
}

export interface LeaveWorkspaceInput {
  expectedAccessRevision: number;
  expectedMembershipRevision: number;
}

export interface LeaveWorkspaceResult {
  accessRevision: number;
  left: true;
  localReplicaDispositionRequired: true;
  membershipRevision: number;
  workspaceId: string;
}

export interface CreateWorkspaceGuestLinkInput {
  expectedAccessRevision: number;
  expiresInHours: number;
  returnTo?: string;
  role: GuestLinkRole;
}

export interface CreateWorkspaceGuestLinkResult {
  accessRevision: number;
  guestLink: WorkspaceGuestLink;
  oneTimeUrl: string;
}

export interface RevokeWorkspaceGuestLinkInput {
  expectedAccessRevision: number;
}

export interface RevokeWorkspaceGuestLinkResult {
  accessRevision: number;
  guestLink: WorkspaceGuestLink;
}

export interface DeleteServerWorkspaceInput {
  confirmationName: string;
  expectedAccessRevision: number;
  expectedMembershipRevision: number;
  expectedRevision: number;
}

export interface DeleteServerWorkspaceResult {
  deleted: true;
  deletedAt: string;
  deletionId: string;
  finalAccessRevision: number;
  finalSnapshotRevision: number;
  localReplicaDispositionRequired: true;
  recovery: "not_available";
  workspaceId: string;
}

export interface WorkspaceAccessActions {
  changeMemberRole: (
    userId: string,
    input: ChangeWorkspaceMemberRoleInput,
  ) => Promise<ChangeWorkspaceMemberRoleResult>;
  createGuestLink: (
    input: CreateWorkspaceGuestLinkInput,
  ) => Promise<CreateWorkspaceGuestLinkResult>;
  deleteServerWorkspace: (
    input: DeleteServerWorkspaceInput,
  ) => Promise<DeleteServerWorkspaceResult>;
  exportLocalRecovery: () => Promise<void>;
  filterGuestLinks: (
    status: GuestLinkStatusFilter,
  ) => Promise<void>;
  leaveWorkspace: (
    input: LeaveWorkspaceInput,
  ) => Promise<LeaveWorkspaceResult>;
  loadMoreGuestLinks: (cursor: string) => Promise<void>;
  loadMoreMembers: (cursor: string) => Promise<void>;
  refresh: () => Promise<void>;
  removeLocalReplica: () => Promise<void>;
  removeMember: (
    userId: string,
    input: RemoveWorkspaceMemberInput,
  ) => Promise<RemoveWorkspaceMemberResult>;
  revokeGuestLink: (
    guestLinkId: string,
    input: RevokeWorkspaceGuestLinkInput,
  ) => Promise<RevokeWorkspaceGuestLinkResult>;
  searchMembers: (query: string) => Promise<void>;
  transferOwnership: (
    input: TransferWorkspaceOwnershipInput,
  ) => Promise<TransferWorkspaceOwnershipResult>;
}

export interface WorkspaceAccessProps {
  actions: WorkspaceAccessActions;
  currentUserId: string;
  data: WorkspaceAccessData;
  guestLinkResult: WorkspaceGuestLinksResult | null;
  initialError?: string | null;
  listsLoading?: boolean;
  memberResult: WorkspaceMembersResult | null;
  onRetryTerminalPersistence?: () => Promise<void>;
  returnTo?: string;
  terminalPersistenceWarning?: string | null;
  terminalStatus?: Extract<
    TerminalWorkspaceAccessStatus,
    "deleted" | "left"
  > | null;
}

export interface RetainedWorkspaceAccessProps {
  onOpenWorkspaceHub: () => void;
  status: TerminalWorkspaceAccessStatus;
}

interface Feedback {
  message: string;
  tone: "error" | "success";
}

interface PendingRoleChange {
  member: WorkspaceMember;
  role: WorkspaceRole;
}

interface LocalDisposition {
  kind: "deleted" | "left";
  serverTime: string | null;
}

interface MemberOverrides {
  accessRevision: number;
  values: Record<string, WorkspaceMember | null>;
}

interface GuestLinkOverrides {
  accessRevision: number;
  values: Record<string, WorkspaceGuestLink>;
}

function formatTimestamp(value: string | null): string {
  if (!value) return "Not available";
  const date = new Date(value);
  return Number.isFinite(date.getTime())
    ? date.toLocaleString()
    : "Not available";
}

function roleLabel(role: WorkspaceRole): string {
  return `${role[0].toUpperCase()}${role.slice(1)}`;
}

function guestStatusLabel(status: GuestLinkStatus): string {
  return `${status[0].toUpperCase()}${status.slice(1)}`;
}

function memberName(member: WorkspaceMember): string {
  return member.displayName.trim() || member.email || "Workspace member";
}

function errorMessage(error: unknown, fallback: string): string {
  if (error instanceof Error && error.message.trim()) {
    return error.message.slice(0, 500);
  }
  return fallback;
}

export function validGuestLinkExpiry(value: number): boolean {
  return Number.isSafeInteger(value) &&
    value >= GUEST_LINK_EXPIRY_HOURS.minimum &&
    value <= GUEST_LINK_EXPIRY_HOURS.maximum;
}

export function matchesWorkspaceDeletionConfirmation(
  workspaceName: string,
  confirmation: string,
): boolean {
  return confirmation === workspaceName;
}

export function isShareCancellation(error: unknown): boolean {
  return Boolean(
    error &&
      typeof error === "object" &&
      "name" in error &&
      error.name === "AbortError",
  );
}

function accessExplanation(role: WorkspaceRole): string {
  if (role === "viewer") {
    return "Viewer access allows navigation, search, inspection, and authorized export. Editing and access management are unavailable.";
  }
  if (role === "editor") {
    return "Editor access allows ordinary workspace changes. Membership, invite links, ownership transfer, and server deletion remain owner-only.";
  }
  return "Owner access includes ordinary workspace changes and self-service collaboration management.";
}

function mergeMembers(
  members: readonly WorkspaceMember[],
  overrides: Readonly<Record<string, WorkspaceMember | null>>,
): WorkspaceMember[] {
  const merged = new Map(members.map((member) => [member.userId, member]));
  for (const [userId, member] of Object.entries(overrides)) {
    if (!merged.has(userId)) continue;
    if (member) merged.set(userId, member);
    else merged.delete(userId);
  }
  return [...merged.values()].sort((left, right) =>
    left.createdAt.localeCompare(right.createdAt) ||
    left.userId.localeCompare(right.userId)
  );
}

function mergeGuestLinks(
  guestLinks: readonly WorkspaceGuestLink[],
  overrides: Readonly<Record<string, WorkspaceGuestLink>>,
): WorkspaceGuestLink[] {
  const merged = new Map(
    guestLinks.map((guestLink) => [
      guestLink.guestLinkId,
      guestLink,
    ]),
  );
  for (const guestLink of Object.values(overrides)) {
    merged.set(guestLink.guestLinkId, guestLink);
  }
  return [...merged.values()].sort((left, right) =>
    right.createdAt.localeCompare(left.createdAt) ||
    left.guestLinkId.localeCompare(right.guestLinkId)
  );
}

function nextCapabilities(
  role: WorkspaceRole,
  ownerCount: number,
): WorkspaceCapabilities {
  return capabilitiesForWorkspaceRole(
    role,
    role !== "owner" || ownerCount > 1,
  );
}

function DialogActionFeedback({ feedback }: { feedback: Feedback | null }) {
  if (!feedback) return null;
  return <output
    className={feedback.tone === "error" ? styles.alert : styles.status}
    role={feedback.tone === "error" ? "alert" : "status"}
  >
    {feedback.message}
  </output>;
}

export function RetainedWorkspaceAccess({
  onOpenWorkspaceHub,
  status,
}: RetainedWorkspaceAccessProps) {
  const copy = TERMINAL_ACCESS_COPY[status];
  const titleId = useId();
  return <section
    aria-labelledby={titleId}
    className={styles.surface}
  >
    <header className={styles.hero}>
      <div>
        <p className="eyebrow">Workspace access</p>
        <h1 id={titleId}>Retained device copy</h1>
        <p>Access management is unavailable without active server authorization for this workspace.</p>
      </div>
    </header>
    <section className={styles.lifecycleNotice} role="alert">
      <h2>{copy.title}</h2>
      <p>{copy.detail}</p>
    </section>
    <section className={styles.summary}>
      <div>
        <p className="eyebrow">Local recovery</p>
        <h2>Read-only copy retained</h2>
        <p>You can still browse, search, inspect, and export this local copy. Review it from the workspace hub before deciding whether to remove it from this device.</p>
      </div>
      <div className={styles.headerActions}>
        <button onClick={onOpenWorkspaceHub} type="button">
          Workspaces and backup status
        </button>
      </div>
    </section>
  </section>;
}

export function WorkspaceAccess(props: WorkspaceAccessProps) {
  return <WorkspaceAccessContent
    {...props}
    key={props.data.workspace.id}
  />;
}

function WorkspaceAccessContent({
  actions,
  currentUserId,
  data,
  guestLinkResult,
  initialError = null,
  listsLoading = false,
  memberResult,
  onRetryTerminalPersistence,
  returnTo,
  terminalPersistenceWarning = null,
  terminalStatus = null,
}: WorkspaceAccessProps) {
  const [accessOverride, setAccessOverride] =
    useState<WorkspaceAccessSnapshot | null>(null);
  const [usageOverride, setUsageOverride] = useState<{
    accessRevision: number;
    value: WorkspaceAccessUsage;
  } | null>(null);
  const [memberOverrides, setMemberOverrides] = useState<MemberOverrides>({
    accessRevision: 0,
    values: {},
  });
  const [guestLinkOverrides, setGuestLinkOverrides] =
    useState<GuestLinkOverrides>({
      accessRevision: 0,
      values: {},
    });
  const busyRef = useRef(false);
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<Feedback | null>(null);
  const [memberQuery, setMemberQuery] = useState("");
  const [guestStatus, setGuestStatus] =
    useState<GuestLinkStatusFilter>(null);
  const [guestRole, setGuestRole] = useState<GuestLinkRole>("viewer");
  const [guestExpiry, setGuestExpiry] = useState(
    String(GUEST_LINK_EXPIRY_HOURS.default),
  );
  const [pendingRoleChange, setPendingRoleChange] =
    useState<PendingRoleChange | null>(null);
  const [pendingRemoval, setPendingRemoval] =
    useState<WorkspaceMember | null>(null);
  const [pendingTransfer, setPendingTransfer] =
    useState<WorkspaceMember | null>(null);
  const [leaveOpen, setLeaveOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deleteConfirmation, setDeleteConfirmation] = useState("");
  const [oneTimeLink, setOneTimeLink] =
    useState<CreateWorkspaceGuestLinkResult | null>(null);
  const [copyStatus, setCopyStatus] = useState("");
  const [lifecycleOutcome, setLifecycleOutcome] =
    useState<LocalDisposition | null>(null);
  const [dispositionOpen, setDispositionOpen] = useState(false);
  const [localRemoved, setLocalRemoved] = useState(false);
  const createGuestLinkButtonRef = useRef<HTMLButtonElement>(null);
  const titleId = useId();
  const terminalKind = lifecycleOutcome?.kind ?? terminalStatus;

  const listedAccessRevision = Math.max(
    data.access.accessRevision,
    guestLinkResult?.accessRevision ?? 0,
    memberResult?.accessRevision ?? 0,
  );
  const serverAccess = listedAccessRevision === data.access.accessRevision
    ? data.access
    : {
        ...data.access,
        accessRevision: listedAccessRevision,
      };
  const access = !accessOverride ||
      serverAccess.membershipRevision > accessOverride.membershipRevision ||
      (
        serverAccess.membershipRevision ===
          accessOverride.membershipRevision &&
        serverAccess.accessRevision >= accessOverride.accessRevision
      )
    ? serverAccess
    : accessOverride;
  const usage = usageOverride &&
      usageOverride.accessRevision > serverAccess.accessRevision
    ? usageOverride.value
    : data.usage;

  const visibleMembers = useMemo(
    () => mergeMembers(
      memberResult?.members ?? [],
      memberOverrides.accessRevision >
          (memberResult?.accessRevision ?? 0)
        ? memberOverrides.values
        : {},
    ),
    [memberOverrides, memberResult],
  );
  const mergedGuestLinks = useMemo(
    () => mergeGuestLinks(
      guestLinkResult?.guestLinks ?? [],
      guestLinkOverrides.accessRevision >
          (guestLinkResult?.accessRevision ?? 0)
        ? guestLinkOverrides.values
        : {},
    ),
    [guestLinkOverrides, guestLinkResult],
  );
  const visibleGuestLinks = guestStatus
    ? mergedGuestLinks.filter((guestLink) =>
        guestLink.status === guestStatus)
    : mergedGuestLinks;
  const ownerCount = usage?.owners ??
    visibleMembers.filter((member) => member.role === "owner").length;
  const canManageAccess = access.role === "owner" &&
    access.capabilities.manageAccess &&
    !terminalKind;
  const canLeave = access.capabilities.leave && !terminalKind;
  const canDelete = access.role === "owner" &&
    access.capabilities.delete &&
    !terminalKind;
  const policyMatchesServerContract =
    data.guestLinkPolicy.minimumExpiryHours ===
      GUEST_LINK_EXPIRY_HOURS.minimum &&
    data.guestLinkPolicy.maximumExpiryHours ===
      GUEST_LINK_EXPIRY_HOURS.maximum &&
    GUEST_LINK_ROLES.every((role) =>
      data.guestLinkPolicy.roles.includes(role)
    );
  const anyDialogOpen = Boolean(
    pendingRoleChange ||
      pendingRemoval ||
      pendingTransfer ||
      leaveOpen ||
      deleteOpen ||
      oneTimeLink ||
      (dispositionOpen && lifecycleOutcome),
  );

  const perform = async <Result,>(
    key: string,
    action: () => Promise<Result>,
    fallback: string,
  ): Promise<Result | null> => {
    if (busyRef.current) return null;
    busyRef.current = true;
    setBusyKey(key);
    setFeedback(null);
    try {
      return await action();
    } catch (error) {
      setFeedback({
        message: errorMessage(error, fallback),
        tone: "error",
      });
      return null;
    } finally {
      busyRef.current = false;
      setBusyKey(null);
    }
  };

  const updateAccessRevision = (accessRevision: number) => {
    setAccessOverride({
      ...access,
      accessRevision: Math.max(access.accessRevision, accessRevision),
    });
  };

  const updateUsage = (
    accessRevision: number,
    update: (current: WorkspaceAccessUsage) => WorkspaceAccessUsage,
  ) => {
    if (!usage) return;
    setUsageOverride({
      accessRevision,
      value: update(usage),
    });
  };

  const refresh = async () => {
    await perform(
      "refresh",
      actions.refresh,
      "Could not refresh workspace access",
    );
  };

  const searchMembers = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    await perform(
      "member-search",
      () => actions.searchMembers(memberQuery.trim()),
      "Could not search workspace members",
    );
  };

  const confirmRoleChange = async () => {
    if (!pendingRoleChange) return;
    const { member, role } = pendingRoleChange;
    const result = await perform(
      `member-role:${member.userId}`,
      () => actions.changeMemberRole(member.userId, {
        expectedAccessRevision: access.accessRevision,
        expectedMembershipRevision: member.membershipRevision,
        role,
      }),
      "Could not change the workspace role",
    );
    if (!result) return;
    setMemberOverrides((current) => ({
      accessRevision: result.accessRevision,
      values: {
        ...current.values,
        [result.member.userId]: result.member,
      },
    }));
    updateUsage(result.accessRevision, (current) => ({
      ...current,
      owners: Math.max(
        0,
        current.owners +
          (member.role === "owner" ? -1 : 0) +
          (result.member.role === "owner" ? 1 : 0),
      ),
    }));
    updateAccessRevision(result.accessRevision);
    setPendingRoleChange(null);
    setFeedback({
      message: `${memberName(result.member)}'s role is now ${result.member.role}`,
      tone: "success",
    });
  };

  const confirmRemoval = async () => {
    if (!pendingRemoval) return;
    const member = pendingRemoval;
    const result = await perform(
      `member-remove:${member.userId}`,
      () => actions.removeMember(member.userId, {
        expectedAccessRevision: access.accessRevision,
        expectedMembershipRevision: member.membershipRevision,
      }),
      "Could not remove the workspace member",
    );
    if (!result) return;
    setMemberOverrides((current) => ({
      accessRevision: result.accessRevision,
      values: {
        ...current.values,
        [member.userId]: null,
      },
    }));
    updateUsage(result.accessRevision, (current) => ({
      ...current,
      members: {
        ...current.members,
        used: Math.max(0, current.members.used - 1),
      },
      owners: Math.max(
        0,
        current.owners - (member.role === "owner" ? 1 : 0),
      ),
    }));
    updateAccessRevision(result.accessRevision);
    setPendingRemoval(null);
    setFeedback({
      message: `${memberName(member)} was removed from the workspace`,
      tone: "success",
    });
  };

  const confirmTransfer = async () => {
    if (!pendingTransfer) return;
    const target = pendingTransfer;
    const result = await perform(
      `ownership:${target.userId}`,
      () => actions.transferOwnership({
        expectedAccessRevision: access.accessRevision,
        expectedActorMembershipRevision: access.membershipRevision,
        expectedTargetMembershipRevision: target.membershipRevision,
        targetUserId: target.userId,
      }),
      "Could not transfer workspace ownership",
    );
    if (!result) return;
    setMemberOverrides((current) => ({
      accessRevision: result.accessRevision,
      values: {
        ...current.values,
        [result.actor.userId]: result.actor,
        [result.target.userId]: result.target,
      },
    }));
    setAccessOverride({
      accessRevision: result.accessRevision,
      capabilities: nextCapabilities(result.actor.role, ownerCount),
      membershipRevision: result.actor.membershipRevision,
      role: result.actor.role,
    });
    setPendingTransfer(null);
    setFeedback({
      message: `Ownership transferred to ${memberName(result.target)}`,
      tone: "success",
    });
  };

  const createGuestLink = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const expiresInHours = Number(guestExpiry);
    if (!policyMatchesServerContract) {
      setFeedback({
        message: "Invite-link creation is unavailable because the server expiry policy could not be verified",
        tone: "error",
      });
      return;
    }
    if (!validGuestLinkExpiry(expiresInHours)) {
      setFeedback({
        message: `Expiry must be a whole number from ${GUEST_LINK_EXPIRY_HOURS.minimum} through ${GUEST_LINK_EXPIRY_HOURS.maximum} hours`,
        tone: "error",
      });
      return;
    }
    const result = await perform(
      "guest-create",
      () => actions.createGuestLink({
        expectedAccessRevision: access.accessRevision,
        expiresInHours,
        ...(returnTo ? { returnTo } : {}),
        role: guestRole,
      }),
      "Could not create the invite link",
    );
    if (!result) return;
    setGuestLinkOverrides((current) => ({
      accessRevision: result.accessRevision,
      values: {
        ...current.values,
        [result.guestLink.guestLinkId]: result.guestLink,
      },
    }));
    updateUsage(result.accessRevision, (current) => ({
      ...current,
      activeGuestLinks: {
        ...current.activeGuestLinks,
        used: current.activeGuestLinks.used + 1,
      },
      retainedGuestLinks: {
        ...current.retainedGuestLinks,
        used: current.retainedGuestLinks.used + 1,
      },
    }));
    updateAccessRevision(result.accessRevision);
    setCopyStatus("");
    setOneTimeLink(result);
  };

  const revokeGuestLink = async (guestLink: WorkspaceGuestLink) => {
    const result = await perform(
      `guest-revoke:${guestLink.guestLinkId}`,
      () => actions.revokeGuestLink(guestLink.guestLinkId, {
        expectedAccessRevision: access.accessRevision,
      }),
      "Could not revoke the invite link",
    );
    if (!result) return;
    setGuestLinkOverrides((current) => ({
      accessRevision: result.accessRevision,
      values: {
        ...current.values,
        [result.guestLink.guestLinkId]: result.guestLink,
      },
    }));
    updateUsage(result.accessRevision, (current) => ({
      ...current,
      activeGuestLinks: {
        ...current.activeGuestLinks,
        used: Math.max(0, current.activeGuestLinks.used - 1),
      },
    }));
    updateAccessRevision(result.accessRevision);
    setFeedback({
      message: "Invite link revoked",
      tone: "success",
    });
  };

  const filterGuestLinks = async (status: GuestLinkStatusFilter) => {
    const previous = guestStatus;
    setGuestStatus(status);
    const result = await perform(
      "guest-filter",
      () => actions.filterGuestLinks(status),
      "Could not filter invite links",
    );
    if (result === null) setGuestStatus(previous);
  };

  const confirmLeave = async () => {
    const result = await perform(
      "leave",
      () => actions.leaveWorkspace({
        expectedAccessRevision: access.accessRevision,
        expectedMembershipRevision: access.membershipRevision,
      }),
      "Could not leave the workspace",
    );
    if (!result) return;
    setLeaveOpen(false);
    setLifecycleOutcome({
      kind: "left",
      serverTime: null,
    });
    setDispositionOpen(true);
    setAccessOverride({
      ...access,
      accessRevision: result.accessRevision,
      capabilities: {
        delete: false,
        leave: false,
        manageAccess: false,
        read: true,
        write: false,
      },
      membershipRevision: result.membershipRevision,
    });
    setFeedback({
      message: "You left the server workspace. The device copy was retained for your decision.",
      tone: "success",
    });
  };

  const confirmDelete = async () => {
    if (!matchesWorkspaceDeletionConfirmation(
      data.workspace.name,
      deleteConfirmation,
    )) {
      return;
    }
    const result = await perform(
      "delete",
      () => actions.deleteServerWorkspace({
        confirmationName: deleteConfirmation,
        expectedAccessRevision: access.accessRevision,
        expectedMembershipRevision: access.membershipRevision,
        expectedRevision: data.workspace.revision,
      }),
      "Could not delete the server workspace",
    );
    if (!result) return;
    setDeleteOpen(false);
    setDeleteConfirmation("");
    setLifecycleOutcome({
      kind: "deleted",
      serverTime: result.deletedAt,
    });
    setDispositionOpen(true);
    setAccessOverride({
      ...access,
      accessRevision: result.finalAccessRevision,
      capabilities: {
        delete: false,
        leave: false,
        manageAccess: false,
        read: true,
        write: false,
      },
    });
    setFeedback({
      message: "The server workspace was deleted immediately. The device copy was retained for your decision.",
      tone: "success",
    });
  };

  const exportLocalRecovery = async () => {
    const result = await perform(
      "export",
      actions.exportLocalRecovery,
      "Could not export the local recovery copy",
    );
    if (result !== null) {
      setFeedback({
        message: "Local recovery copy exported",
        tone: "success",
      });
    }
  };

  const removeLocalReplica = async () => {
    const result = await perform(
      "remove-local",
      actions.removeLocalReplica,
      "Could not remove the local workspace",
    );
    if (result !== null) {
      setDispositionOpen(false);
      setLocalRemoved(true);
      setFeedback({
        message: "The workspace was removed from this device",
        tone: "success",
      });
    }
  };

  const retryTerminalPersistence = async () => {
    if (!onRetryTerminalPersistence) return;
    const result = await perform(
      "terminal-persistence",
      onRetryTerminalPersistence,
      "This device still could not save the server deletion state",
    );
    if (result !== null) {
      setFeedback({
        message: "This device recorded the server deletion state",
        tone: "success",
      });
    }
  };

  const copyOneTimeUrl = async () => {
    if (!oneTimeLink) return;
    setCopyStatus("");
    setFeedback(null);
    try {
      if (!navigator.clipboard?.writeText) {
        throw new Error("Clipboard access is unavailable");
      }
      await navigator.clipboard.writeText(oneTimeLink.oneTimeUrl);
      setCopyStatus("Invite URL copied");
    } catch (error) {
      setFeedback({
        message: errorMessage(
          error,
          "Could not copy automatically. Select the URL and copy it manually.",
        ),
        tone: "error",
      });
    }
  };

  const shareOneTimeUrl = async () => {
    if (!oneTimeLink) return;
    setCopyStatus("");
    setFeedback(null);
    try {
      if (typeof navigator.share === "function") {
        await navigator.share({
          title: `${data.workspace.name} invitation`,
          url: oneTimeLink.oneTimeUrl,
        });
        return;
      }
      await copyOneTimeUrl();
    } catch (error) {
      if (isShareCancellation(error)) return;
      setFeedback({
        message: "Could not share automatically. Copy the invite URL instead.",
        tone: "error",
      });
    }
  };

  const closeOneTimeLink = () => {
    setOneTimeLink(null);
    setCopyStatus("");
    setFeedback(null);
  };

  return <section
    aria-labelledby={titleId}
    className={styles.surface}
  >
    <header className={styles.hero}>
      <div>
        <p className="eyebrow">Workspace access</p>
        <h1 id={titleId}>{data.workspace.name}</h1>
        <p>{terminalKind
          ? "Active server access has ended. The retained device copy is read-only."
          : accessExplanation(access.role)}</p>
      </div>
      {!terminalKind &&
        <div className={styles.headerActions}>
          <span className={styles.roleBadge}>{roleLabel(access.role)}</span>
          <button
            disabled={busyKey === "refresh"}
            onClick={() => void refresh()}
            type="button"
          >
            {busyKey === "refresh" ? "Refreshing..." : "Refresh access"}
          </button>
        </div>}
    </header>

    {initialError &&
      <output className={styles.alert} role="alert">
        {initialError}
      </output>}

    {terminalPersistenceWarning && !anyDialogOpen &&
      <section className={styles.alert} role="alert">
        <p>{terminalPersistenceWarning}</p>
        {onRetryTerminalPersistence &&
          <button
            disabled={busyKey === "terminal-persistence"}
            onClick={() => void retryTerminalPersistence()}
            type="button"
          >
            {busyKey === "terminal-persistence"
              ? "Retrying..."
              : "Retry saving device status"}
          </button>}
      </section>}

    {feedback && !anyDialogOpen &&
      <output
        className={feedback.tone === "error"
          ? styles.alert
          : styles.status}
        role={feedback.tone === "error" ? "alert" : "status"}
      >
        {feedback.message}
      </output>}

    {terminalKind &&
      <section className={styles.lifecycleNotice} role="alert">
        <h2>{terminalKind === "left"
          ? "Server membership ended"
          : "Server workspace deleted"}</h2>
        <p>{terminalKind === "left"
          ? localRemoved
            ? "Your server membership ended and the device copy was removed."
            : "This retained device copy is read-only and is not backed up to the server."
          : `Deletion was immediate and is not recoverable${lifecycleOutcome?.serverTime ? ` as of ${formatTimestamp(lifecycleOutcome.serverTime)}` : ""}.${localRemoved ? " The device copy was removed." : " The retained device copy is read-only."}`}</p>
        <button
          disabled={localRemoved}
          onClick={() => {
            setFeedback(null);
            setDispositionOpen(true);
          }}
          type="button"
        >
          Review device copy choices
        </button>
      </section>}

    {localRemoved &&
      <section className={styles.lifecycleNotice} aria-live="polite">
        <h2>Device copy removed</h2>
        <p>No local replica remains on this device.</p>
      </section>}

    {!terminalKind &&
      <details className={styles.summary}>
        <summary>
          <span>
            <strong>{roleLabel(access.role)} role permissions</strong>
            <small>Review what you can do in this workspace</small>
          </span>
        </summary>
        <div className={styles.summaryBody}>
          <p>{accessExplanation(access.role)}</p>
          <dl className={styles.capabilities}>
            <div><dt>Read</dt><dd>{access.capabilities.read ? "Allowed" : "Unavailable"}</dd></div>
            <div><dt>Edit workspace</dt><dd>{access.capabilities.write ? "Allowed" : "Read-only"}</dd></div>
            <div><dt>Manage access</dt><dd>{access.capabilities.manageAccess ? "Allowed" : "Owner-only"}</dd></div>
            <div><dt>Leave workspace</dt><dd>{access.capabilities.leave ? "Allowed" : "Guarded"}</dd></div>
            <div><dt>Delete server copy</dt><dd>{access.capabilities.delete ? "Allowed" : "Owner-only"}</dd></div>
          </dl>
        </div>
      </details>}

    {!terminalKind && (canManageAccess
      ? <>
          <section className={styles.section} aria-labelledby="guest-links-title">
            <header className={styles.sectionHeader}>
              <div>
                <p className="eyebrow">One-time enrollment</p>
                <h2 id="guest-links-title">Invite links</h2>
                <p>Each URL can be redeemed once before it expires. Redemption creates a viewer or editor membership that remains until the member leaves or is removed. Raw URLs are shown only once after creation.</p>
              </div>
              {usage &&
                <span className={styles.quota}>
                  {usage.activeGuestLinks.used} of {usage.activeGuestLinks.limit} active
                </span>}
            </header>

            {!policyMatchesServerContract &&
              <p className={styles.alert} role="alert">
                Invite-link creation is disabled because the server did not report the supported {GUEST_LINK_EXPIRY_HOURS.minimum} through {GUEST_LINK_EXPIRY_HOURS.maximum} hour policy.
              </p>}

            <form className={styles.guestForm} onSubmit={createGuestLink}>
              <fieldset>
                <legend>Membership role</legend>
                <div className={styles.roleChoices}>
                  {GUEST_LINK_ROLES.map((role) =>
                    <label key={role}>
                      <input
                        checked={guestRole === role}
                        name="guest-role"
                        onChange={() => setGuestRole(role)}
                        type="radio"
                        value={role}
                      />
                      <span>{roleLabel(role)}</span>
                    </label>)}
                </div>
              </fieldset>
              <label>
                <span>Invitation expires after hours</span>
                <input
                  inputMode="numeric"
                  max={GUEST_LINK_EXPIRY_HOURS.maximum}
                  min={GUEST_LINK_EXPIRY_HOURS.minimum}
                  onChange={(event) =>
                    setGuestExpiry(event.currentTarget.value)}
                  required
                  step={1}
                  type="number"
                  value={guestExpiry}
                />
                <small>Choose a whole number from {GUEST_LINK_EXPIRY_HOURS.minimum} through {GUEST_LINK_EXPIRY_HOURS.maximum}. Expiry controls enrollment, not the resulting membership duration.</small>
              </label>
              <button
                className="primary"
                disabled={!policyMatchesServerContract ||
                  busyKey === "guest-create"}
                ref={createGuestLinkButtonRef}
                type="submit"
              >
                {busyKey === "guest-create"
                  ? "Creating..."
                  : "Create invite link"}
              </button>
            </form>

            <label className={styles.filter}>
              <span>Invite link status</span>
              <select
                disabled={busyKey === "guest-filter"}
                onChange={(event) => {
                  const status = event.currentTarget.value;
                  void filterGuestLinks(
                    status ? status as GuestLinkStatus : null,
                  );
                }}
                value={guestStatus ?? ""}
              >
                <option value="">All statuses</option>
                {GUEST_LINK_STATUSES.map((status) =>
                  <option key={status} value={status}>
                    {guestStatusLabel(status)}
                  </option>)}
              </select>
            </label>

            <ul className={styles.guestList}>
              {visibleGuestLinks.map((guestLink) =>
                <li key={guestLink.guestLinkId}>
                  <div>
                    <strong>{roleLabel(guestLink.role)} invitation</strong>
                    <span
                      className={styles.linkStatus}
                      data-status={guestLink.status}
                    >
                      {guestStatusLabel(guestLink.status)}
                    </span>
                  </div>
                  <dl>
                    <div><dt>Created</dt><dd>{formatTimestamp(guestLink.createdAt)}</dd></div>
                    <div><dt>Expires</dt><dd>{formatTimestamp(guestLink.expiresAt)}</dd></div>
                    {guestLink.usedAt &&
                      <div><dt>Used</dt><dd>{formatTimestamp(guestLink.usedAt)}</dd></div>}
                    {guestLink.revokedAt &&
                      <div><dt>Revoked</dt><dd>{formatTimestamp(guestLink.revokedAt)}</dd></div>}
                  </dl>
                  {guestLink.status === "active" &&
                    <button
                      className={styles.danger}
                      disabled={busyKey ===
                        `guest-revoke:${guestLink.guestLinkId}`}
                      onClick={() => void revokeGuestLink(guestLink)}
                      type="button"
                    >
                      Revoke invite
                    </button>}
                </li>)}
            </ul>
            {listsLoading && guestLinkResult === null
              ? <p className={styles.empty} role="status">Loading invite links...</p>
              : visibleGuestLinks.length === 0 &&
              <p className={styles.empty}>No invite links match this filter.</p>}
            {guestLinkResult?.page.hasMore &&
              guestLinkResult.page.nextCursor &&
              <button
                className={styles.loadMore}
                disabled={busyKey === "guests-more"}
                onClick={() => void perform(
                  "guests-more",
                  () => actions.loadMoreGuestLinks(
                    guestLinkResult.page.nextCursor!,
                  ),
                  "Could not load more invite links",
                )}
                type="button"
              >
                {busyKey === "guests-more"
                  ? "Loading..."
                  : "Load more invite links"}
              </button>}
            {guestLinkResult?.page.hasMore &&
              !guestLinkResult.page.nextCursor &&
              <p className={styles.alert} role="alert">
                More invite links exist, but the continuation cursor is unavailable. Refresh access before treating this list as complete.
              </p>}
          </section>

          <section className={styles.section} aria-labelledby="members-title">
            <header className={styles.sectionHeader}>
              <div>
                <p className="eyebrow">Collaboration</p>
                <h2 id="members-title">Members</h2>
                <p>Role changes take effect only after the server confirms them.</p>
              </div>
              {usage &&
                <span className={styles.quota}>
                  {usage.members.used} of {usage.members.limit} members
                </span>}
            </header>

            <form className={styles.searchForm} onSubmit={searchMembers}>
              <label>
                <span>Search members</span>
                <input
                  maxLength={120}
                  onChange={(event) =>
                    setMemberQuery(event.currentTarget.value)}
                  type="search"
                  value={memberQuery}
                />
              </label>
              <button
                disabled={busyKey === "member-search"}
                type="submit"
              >
                Search
              </button>
            </form>

            <ul className={styles.memberList}>
              {visibleMembers.map((member) => {
                const ownMembership = member.userId === currentUserId;
                const finalOwner = member.role === "owner" &&
                  ownerCount <= 1;
                return <li key={member.userId}>
                  <div className={styles.memberIdentity}>
                    <strong>{memberName(member)}</strong>
                    <span>{member.email ?? "Email unavailable"}</span>
                    <small>
                      {member.identityKind === "guest"
                        ? "Guest identity"
                        : "Account member"}
                      {ownMembership ? " · You" : ""}
                      {` · Joined ${formatTimestamp(member.createdAt)}`}
                    </small>
                  </div>
                  <label className={styles.roleControl}>
                    <span>Role for {memberName(member)}</span>
                    <select
                      aria-describedby={finalOwner
                        ? `final-owner-${member.userId}`
                        : undefined}
                      disabled={ownMembership ||
                        busyKey === `member-role:${member.userId}`}
                      onChange={(event) => {
                        const role = event.currentTarget.value as WorkspaceRole;
                        if (role !== member.role) {
                          setFeedback(null);
                          setPendingRoleChange({ member, role });
                        }
                      }}
                      value={member.role}
                    >
                      {MEMBER_ROLES.map((role) =>
                        <option key={role} value={role}>
                          {roleLabel(role)}
                        </option>)}
                    </select>
                  </label>
                  <div className={styles.memberActions}>
                    {!ownMembership && member.role !== "owner" &&
                      <button
                        onClick={() => {
                          setFeedback(null);
                          setPendingTransfer(member);
                        }}
                        type="button"
                      >
                        Transfer ownership
                      </button>}
                    {!ownMembership &&
                      <button
                        className={styles.danger}
                        disabled={finalOwner}
                        onClick={() => {
                          setFeedback(null);
                          setPendingRemoval(member);
                        }}
                        type="button"
                      >
                        Remove
                      </button>}
                  </div>
                  {ownMembership &&
                    <small className={styles.memberNote}>
                      Use the guarded ownership transfer or leave action to change your own access.
                    </small>}
                  {finalOwner &&
                    <small
                      className={styles.memberNote}
                      id={`final-owner-${member.userId}`}
                    >
                      The final owner cannot be demoted or removed.
                    </small>}
                </li>;
              })}
            </ul>
            {listsLoading && memberResult === null
              ? <p className={styles.empty} role="status">Loading members...</p>
              : visibleMembers.length === 0 &&
              <p className={styles.empty}>No members match this search.</p>}
            {memberResult?.page.hasMore && memberResult.page.nextCursor &&
              <button
                className={styles.loadMore}
                disabled={busyKey === "members-more"}
                onClick={() => void perform(
                  "members-more",
                  () => actions.loadMoreMembers(
                    memberResult.page.nextCursor!,
                  ),
                  "Could not load more workspace members",
                )}
                type="button"
              >
                {busyKey === "members-more" ? "Loading..." : "Load more members"}
              </button>}
            {memberResult?.page.hasMore &&
              !memberResult.page.nextCursor &&
              <p className={styles.alert} role="alert">
                More members exist, but the continuation cursor is unavailable. Refresh access before treating this list as complete.
              </p>}
          </section>
        </>
      : <section className={styles.readOnlyNotice}>
          <h2>Access management is owner-only</h2>
          <p>{access.role === "viewer"
            ? "Your viewer role remains read-only. You can still browse, search, inspect, and export authorized local data."
            : "Your editor role can change workspace content, but it cannot manage members, invite links, ownership, or server deletion."}</p>
        </section>)}

    {!terminalKind && <section className={styles.section} aria-labelledby="lifecycle-title">
      <header className={styles.sectionHeader}>
        <div>
          <p className="eyebrow">Workspace lifecycle</p>
          <h2 id="lifecycle-title">Server and device copies</h2>
          <p>Export, leaving, server deletion, and local removal are separate operations.</p>
        </div>
      </header>
      <div className={styles.lifecycleGrid}>
        <article>
          <h3>Export local recovery</h3>
          <p>Save an authorized recovery copy before changing server membership or deleting data.</p>
          <button
            disabled={busyKey === "export" || localRemoved}
            onClick={() => void exportLocalRecovery()}
            type="button"
          >
            Export recovery copy
          </button>
        </article>
        <article>
          <h3>Leave shared workspace</h3>
          <p>Leaving removes only your server membership. The local replica stays until you choose what to do with it.</p>
          {canLeave
            ? <button
                className={styles.danger}
                onClick={() => {
                  setFeedback(null);
                  setLeaveOpen(true);
                }}
                type="button"
              >
                Leave shared workspace
              </button>
            : <p className={styles.guard}>
                {access.role === "owner" && ownerCount <= 1
                  ? "The final owner must transfer ownership or delete the server workspace."
                  : "Leaving is unavailable for this access state."}
              </p>}
        </article>
        {canDelete &&
          <article className={styles.dangerZone}>
            <h3>Delete server workspace</h3>
            <p>Deletion is immediate and not recoverable. It removes the server snapshot, memberships, and invite records.</p>
            <button
              className={styles.danger}
              onClick={() => {
                setFeedback(null);
                setDeleteOpen(true);
              }}
              type="button"
            >
              Delete server workspace
            </button>
          </article>}
      </div>
    </section>}

    <ModalDialog
      busy={Boolean(pendingRoleChange &&
        busyKey === `member-role:${pendingRoleChange.member.userId}`)}
      description={pendingRoleChange
        ? `Change ${memberName(pendingRoleChange.member)} from ${pendingRoleChange.member.role} to ${pendingRoleChange.role}. The interface will update only after server confirmation.`
        : undefined}
      onClose={() => setPendingRoleChange(null)}
      open={Boolean(pendingRoleChange)}
      title="Confirm role change"
    >
      <DialogActionFeedback feedback={feedback} />
      <div className={styles.dialogActions}>
        <button
          data-dialog-initial-focus
          disabled={Boolean(busyKey)}
          onClick={() => setPendingRoleChange(null)}
          type="button"
        >
          Cancel
        </button>
        <button
          className="primary"
          disabled={Boolean(busyKey)}
          onClick={() => void confirmRoleChange()}
          type="button"
        >
          Confirm role
        </button>
      </div>
    </ModalDialog>

    <ModalDialog
      busy={Boolean(pendingRemoval &&
        busyKey === `member-remove:${pendingRemoval.userId}`)}
      description={pendingRemoval
        ? `Remove ${memberName(pendingRemoval)} from this workspace. Their other workspaces and account remain unchanged.`
        : undefined}
      destructive
      onClose={() => setPendingRemoval(null)}
      open={Boolean(pendingRemoval)}
      title="Remove workspace member?"
    >
      <DialogActionFeedback feedback={feedback} />
      <div className={styles.dialogActions}>
        <button
          data-dialog-initial-focus
          disabled={Boolean(busyKey)}
          onClick={() => setPendingRemoval(null)}
          type="button"
        >
          Cancel
        </button>
        <button
          className={styles.danger}
          disabled={Boolean(busyKey)}
          onClick={() => void confirmRemoval()}
          type="button"
        >
          Remove member
        </button>
      </div>
    </ModalDialog>

    <ModalDialog
      busy={Boolean(pendingTransfer &&
        busyKey === `ownership:${pendingTransfer.userId}`)}
      description={pendingTransfer
        ? `Transfer ownership to ${memberName(pendingTransfer)}. They become owner and your role becomes editor only after the server confirms both changes.`
        : undefined}
      onClose={() => setPendingTransfer(null)}
      open={Boolean(pendingTransfer)}
      title="Transfer workspace ownership?"
    >
      <DialogActionFeedback feedback={feedback} />
      <div className={styles.dialogActions}>
        <button
          data-dialog-initial-focus
          disabled={Boolean(busyKey)}
          onClick={() => setPendingTransfer(null)}
          type="button"
        >
          Cancel
        </button>
        <button
          className="primary"
          disabled={Boolean(busyKey)}
          onClick={() => void confirmTransfer()}
          type="button"
        >
          Transfer ownership
        </button>
      </div>
    </ModalDialog>

    <ModalDialog
      description={<>
        <p>This raw invite URL is available only in this dialog. Store or share it before closing.</p>
        <p>Opening the confirmation page does not consume the link. Confirmation enrolls one member, and that membership remains until the member leaves or is removed.</p>
      </>}
      onClose={closeOneTimeLink}
      open={Boolean(oneTimeLink)}
      returnFocusRef={createGuestLinkButtonRef}
      title="Invite link created"
    >
      {oneTimeLink &&
        <>
          <DialogActionFeedback feedback={feedback} />
          <label className={styles.oneTimeUrl}>
            <span>Single-use enrollment URL</span>
            <input
              data-dialog-initial-focus
              onFocus={(event) => event.currentTarget.select()}
              readOnly
              value={oneTimeLink.oneTimeUrl}
            />
          </label>
          {copyStatus &&
            <output className={styles.status} role="status">
              {copyStatus}
            </output>}
          <div className={styles.dialogActions}>
            <button onClick={() => void copyOneTimeUrl()} type="button">
              Copy URL
            </button>
            <button onClick={() => void shareOneTimeUrl()} type="button">
              Share
            </button>
            <button className="primary" onClick={closeOneTimeLink} type="button">
              Done
            </button>
          </div>
        </>}
    </ModalDialog>

    <ModalDialog
      busy={busyKey === "leave"}
      description={<>
        <p>This removes only your server membership. It does not delete the workspace for other members.</p>
        <p>The device replica will remain until you choose to keep, export, or remove it.</p>
      </>}
      destructive
      onClose={() => setLeaveOpen(false)}
      open={leaveOpen}
      title={`Leave ${data.workspace.name}?`}
    >
      <DialogActionFeedback feedback={feedback} />
      <div className={styles.dialogActions}>
        <button
          data-dialog-initial-focus
          disabled={busyKey === "leave"}
          onClick={() => setLeaveOpen(false)}
          type="button"
        >
          Cancel
        </button>
        <button
          className={styles.danger}
          disabled={busyKey === "leave"}
          onClick={() => void confirmLeave()}
          type="button"
        >
          Leave workspace
        </button>
      </div>
    </ModalDialog>

    <ModalDialog
      busy={busyKey === "delete"}
      description={<>
        <p>Deletion is immediate and not recoverable. It removes the server snapshot, all memberships, and all invite records.</p>
        <p>The local replica remains until you make a separate device-copy choice.</p>
      </>}
      destructive
      onClose={() => {
        setDeleteOpen(false);
        setDeleteConfirmation("");
      }}
      open={deleteOpen}
      title={`Delete ${data.workspace.name} from the server?`}
    >
      <DialogActionFeedback feedback={feedback} />
      <label className={styles.confirmation}>
        <span>Type the exact workspace name: <strong>{data.workspace.name}</strong></span>
        <input
          autoComplete="off"
          data-dialog-initial-focus
          onChange={(event) =>
            setDeleteConfirmation(event.currentTarget.value)}
          value={deleteConfirmation}
        />
      </label>
      <div className={styles.dialogActions}>
        <button
          disabled={busyKey === "delete"}
          onClick={() => {
            setDeleteOpen(false);
            setDeleteConfirmation("");
          }}
          type="button"
        >
          Cancel
        </button>
        <button
          className={styles.danger}
          disabled={busyKey === "delete" ||
            !matchesWorkspaceDeletionConfirmation(
              data.workspace.name,
              deleteConfirmation,
            )}
          onClick={() => void confirmDelete()}
          type="button"
        >
          Delete server workspace
        </button>
      </div>
    </ModalDialog>

    <ModalDialog
      busy={busyKey === "export" ||
        busyKey === "remove-local" ||
        busyKey === "terminal-persistence"}
      description={lifecycleOutcome
        ? <>
            <p>{lifecycleOutcome.kind === "left"
              ? "Your server membership has ended."
              : "The server workspace has been deleted and is not recoverable."}</p>
            <p>The local replica has not been removed. Keep it read-only, export recovery data, or remove it from this device.</p>
          </>
        : undefined}
      onClose={() => setDispositionOpen(false)}
      open={dispositionOpen && Boolean(lifecycleOutcome)}
      title="Choose what happens to the device copy"
    >
      {terminalPersistenceWarning &&
        <section className={styles.alert} role="alert">
          <p>{terminalPersistenceWarning}</p>
          {onRetryTerminalPersistence &&
            <button
              disabled={Boolean(busyKey)}
              onClick={() => void retryTerminalPersistence()}
              type="button"
            >
              {busyKey === "terminal-persistence"
                ? "Retrying..."
                : "Retry saving device status"}
            </button>}
        </section>}
      <DialogActionFeedback feedback={feedback} />
      <div className={styles.dispositionActions}>
        <button
          data-dialog-initial-focus
          disabled={Boolean(busyKey)}
          onClick={() => setDispositionOpen(false)}
          type="button"
        >
          Keep read-only copy
        </button>
        <button
          disabled={Boolean(busyKey)}
          onClick={() => void exportLocalRecovery()}
          type="button"
        >
          Export recovery copy
        </button>
        <button
          className={styles.danger}
          disabled={Boolean(busyKey)}
          onClick={() => void removeLocalReplica()}
          type="button"
        >
          Remove from this device
        </button>
      </div>
    </ModalDialog>
  </section>;
}
