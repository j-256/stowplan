import type {
  SyncReceipt,
  WorkspaceState,
} from "../domain/types";
import {
  compareServerWorkspaceSummaries,
  normalizeServerWorkspaceSummary,
  normalizeWorkspaceAccessState,
  shouldApplyWorkspaceAccess,
  workspaceAccountIdsMatch,
  type ServerWorkspaceSummary,
  type WorkspaceAccessState,
} from "../domain/workspace-access";
import {
  reconcileReplica,
  scopeOutboxForWorkspaceAccess,
  type LocalReplica,
  type OutboxEntry,
} from "./local-replica";

interface SyncServerContext {
  authorization: WorkspaceAccessState | null;
  summary: ServerWorkspaceSummary | null;
}

export function inaccessibleWorkspaceAccess(
  value: unknown,
  accountId: string,
  checkedAt: string,
): WorkspaceAccessState {
  const current = normalizeWorkspaceAccessState(value);
  return {
    accountId,
    accessRevision: current.accessRevision,
    capabilities: {
      delete: false,
      leave: false,
      manageAccess: false,
      read: true,
      write: false,
    },
    checkedAt,
    kind: "server",
    membershipRevision: current.membershipRevision,
    role: null,
    status: "unknown",
  };
}

function commandContext(
  replica: LocalReplica,
  commandId: string,
): string {
  const queued = replica.outbox.find(
    entry => entry.envelope.id === commandId,
  );
  return replica.state.activities.find(
    activity => activity.commandId === commandId,
  )?.label ??
    queued?.envelope.command.type.replaceAll(".", " ") ??
    "Queued workspace change";
}

function applyServerContext(
  replica: LocalReplica,
  context: SyncServerContext,
): Pick<LocalReplica, "authorization" | "outbox" | "serverSummary"> {
  const currentAccess = normalizeWorkspaceAccessState(
    replica.authorization,
  );
  const currentSummary = replica.serverSummary
    ? normalizeServerWorkspaceSummary(replica.serverSummary)
    : null;
  const nextAuthorization =
    context.authorization &&
        shouldApplyWorkspaceAccess(
          currentAccess,
          context.authorization,
        )
      ? context.authorization
      : currentAccess;
  const nextSummary =
      context.summary &&
        (
          !currentSummary ||
          !workspaceAccountIdsMatch(
            context.summary.accountId,
            currentSummary.accountId,
          ) ||
          compareServerWorkspaceSummaries(
            context.summary,
            currentSummary,
          ) >= 0
        )
      ? context.summary
      : currentSummary;
  return {
    authorization: nextAuthorization,
    outbox: scopeOutboxForWorkspaceAccess(
      replica.outbox,
      currentAccess,
      nextAuthorization,
    ),
    serverSummary: nextSummary,
  };
}

export function applyRefusedSyncResponse(
  replica: LocalReplica,
  sent: readonly OutboxEntry[],
  receipts: readonly SyncReceipt[],
  message: string,
  attemptedAt: string,
  definitive: boolean,
  context: SyncServerContext,
): LocalReplica {
  const receiptById = new Map(
    receipts.map(receipt => [receipt.commandId, receipt]),
  );
  const sentIds = new Set(sent.map(entry => entry.envelope.id));
  const serverContext = applyServerContext(replica, context);
  return {
    ...replica,
    ...serverContext,
    lastSyncAttemptAt: attemptedAt,
    lastSyncError: message,
    outbox: definitive
      ? serverContext.outbox.map((entry) => {
          if (
            entry.status !== "pending" ||
            !sentIds.has(entry.envelope.id)
          ) {
            return entry;
          }
          const receipt = receiptById.get(entry.envelope.id);
          const refusal = receipt?.message ??
            receipt?.conflicts?.map(
              conflict => conflict.message,
            ).join("; ") ??
            message;
          return {
            ...entry,
            error:
              `${commandContext(replica, entry.envelope.id)}: ${refusal}`,
            status: "blocked" as const,
          };
        })
      : serverContext.outbox,
  };
}

export function applySuccessfulSyncResponse(
  replica: LocalReplica,
  sent: readonly OutboxEntry[],
  serverState: WorkspaceState,
  receipts: readonly SyncReceipt[],
  syncedAt: string,
  context: SyncServerContext,
): LocalReplica {
  const reconciled = reconcileReplica(
    replica,
    [...sent],
    serverState,
    [...receipts],
  );
  return {
    ...reconciled,
    ...applyServerContext(reconciled, context),
    lastSyncAttemptAt: syncedAt,
    lastSyncError: null,
    lastSyncedAt: syncedAt,
  };
}
