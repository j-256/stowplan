import type {
  Command,
  WorkspaceState,
} from "../domain/types";
import { normalizeWorkspaceState } from "../domain/import";
import {
  normalizeServerWorkspaceSummary,
  normalizeWorkspaceAccessState,
  workspaceAccessForAccount,
  type ServerWorkspaceSummary,
  type WorkspaceAccessState,
  type WorkspaceCapabilities,
} from "../domain/workspace-access";
import type {
  LocalReplica,
  OutboxEntry,
} from "./local-replica";

export interface AuthorizedRecoverySnapshot {
  authorization: WorkspaceAccessState;
  state: WorkspaceState;
  workspace: ServerWorkspaceSummary;
}

const WORKSPACE_CAPABILITY_KEYS = Object.freeze([
  "delete",
  "leave",
  "manageAccess",
  "read",
  "write",
] as const);

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) &&
    typeof value === "object" &&
    !Array.isArray(value);
}

function hasCapabilities(
  value: unknown,
): value is WorkspaceCapabilities {
  return isRecord(value) &&
    typeof value.delete === "boolean" &&
    typeof value.leave === "boolean" &&
    typeof value.manageAccess === "boolean" &&
    typeof value.read === "boolean" &&
    typeof value.write === "boolean";
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= 0;
}

function accountScopeMatches(
  value: Record<string, unknown>,
  accountId: string,
): boolean {
  if (!("accountId" in value) || value.accountId === null) return true;
  return typeof value.accountId === "string" &&
    value.accountId.trim() === accountId;
}

function capabilitiesMatch(
  left: WorkspaceCapabilities,
  right: WorkspaceCapabilities,
): boolean {
  return WORKSPACE_CAPABILITY_KEYS.every(
    capability => left[capability] === right[capability],
  );
}

export function parseAuthorizedRecoverySnapshot(
  value: unknown,
  expectedWorkspaceId: string,
  accountId: string | null,
): AuthorizedRecoverySnapshot {
  if (!accountId?.trim()) {
    throw new Error("Sign in before loading a server workspace");
  }
  if (
    !isRecord(value) ||
    !isRecord(value.state) ||
    !isRecord(value.state.workspace) ||
    !isRecord(value.authorization) ||
    value.authorization.kind !== "server" ||
    value.authorization.status !== "active" ||
    !hasCapabilities(value.authorization.capabilities) ||
    !isRecord(value.workspace) ||
    !hasCapabilities(value.workspace.capabilities) ||
    !isNonNegativeSafeInteger(value.authorization.accessRevision) ||
    !isNonNegativeSafeInteger(
      value.authorization.membershipRevision,
    ) ||
    !isNonNegativeSafeInteger(value.workspace.accessRevision) ||
    !isNonNegativeSafeInteger(value.workspace.membershipRevision) ||
    !isNonNegativeSafeInteger(value.workspace.revision)
  ) {
    throw new Error("The server returned incomplete workspace access");
  }

  if (
    !accountScopeMatches(value.authorization, accountId) ||
    !accountScopeMatches(value.workspace, accountId)
  ) {
    throw new Error("The server returned workspace access for another account");
  }

  const state = value.state as unknown as WorkspaceState;
  const authorization = normalizeWorkspaceAccessState({
    ...value.authorization,
    accountId,
  });
  const workspace = normalizeServerWorkspaceSummary({
    ...value.workspace,
    accountId,
  });
  if (
    authorization.kind !== "server" ||
    authorization.status !== "active" ||
    !authorization.role ||
    !authorization.capabilities.read ||
    !workspace ||
    state.workspace.id !== expectedWorkspaceId ||
    workspace.id !== expectedWorkspaceId ||
    workspace.name !== state.workspace.name ||
    workspace.revision !== state.workspace.revision ||
    workspace.role !== authorization.role ||
    workspace.membershipRevision !==
      authorization.membershipRevision ||
    workspace.accessRevision !== authorization.accessRevision ||
    !capabilitiesMatch(
      value.authorization.capabilities,
      authorization.capabilities,
    ) ||
    !capabilitiesMatch(
      value.workspace.capabilities,
      workspace.capabilities,
    ) ||
    !WORKSPACE_CAPABILITY_KEYS.every(
      capability =>
        workspace.capabilities[capability] ===
          authorization.capabilities[capability],
    )
  ) {
    throw new Error("The server returned inconsistent workspace access");
  }
  return {
    authorization,
    state: normalizeWorkspaceState(structuredClone(state)),
    workspace,
  };
}

export function canUseRecoveryCapability(
  snapshot: AuthorizedRecoverySnapshot | null,
  accountId: string | null,
  accountReady: boolean,
  capability: keyof WorkspaceCapabilities,
): boolean {
  if (!snapshot || !accountReady || !accountId?.trim()) return false;
  const access = workspaceAccessForAccount(
    snapshot.authorization,
    accountId,
  );
  return access.status === "active" &&
    access.capabilities.read &&
    access.capabilities[capability];
}

export function canUseLocalRecoveryWrite(
  replica: LocalReplica | null,
  accountId: string | null,
  accountReady: boolean,
): boolean {
  if (!replica) return false;
  const access = normalizeWorkspaceAccessState(
    replica.authorization,
  );
  if (
    access.kind === "server" &&
    (!accountReady || !accountId?.trim())
  ) {
    return false;
  }
  return workspaceAccessForAccount(
    access,
    accountId,
  ).capabilities.write;
}

function findName(
  state: WorkspaceState,
  command: Command,
): string | null {
  if ("id" in command && typeof command.id === "string") {
    if (command.type.startsWith("location.") ||
      command.type.startsWith("capture.")) {
      return state.locations.find(
        location => location.id === command.id,
      )?.name ?? null;
    }
    if (command.type.startsWith("item.")) {
      return state.items.find(
        item => item.id === command.id,
      )?.name ?? null;
    }
  }
  if ("planId" in command) {
    return state.plans.find(
      plan => plan.id === command.planId,
    )?.name ?? null;
  }
  return null;
}

export function recoveryCommandLabel(
  replica: LocalReplica,
  entry: OutboxEntry,
): string {
  const activity = replica.state.activities.find(
    candidate => candidate.commandId === entry.envelope.id,
  );
  if (activity?.label.trim()) return activity.label;

  const command = entry.envelope.command;
  if (command.type === "workspace.rename") {
    return `Rename workspace to "${command.name}"`;
  }
  if (command.type === "location.create") {
    return `Create space "${command.location.name}"`;
  }
  if (command.type === "item.create") {
    return `Record ${command.item.quantity} ${command.item.unit} ${command.item.name}`;
  }
  if (command.type === "plan.create") {
    return `Create plan "${command.plan.name}"`;
  }

  const name = findName(replica.state, command);
  const action = command.type.replaceAll(".", " ");
  return name ? `${action}: ${name}` : action;
}
