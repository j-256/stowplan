import {
    applyCommand,
    compactWorkspaceHistory,
    ConflictError,
    DomainError,
} from "../domain";
import type { CommandEnvelope, SyncReceipt, SyncResponse, WorkspaceState } from "../domain";
import {
    assertSnapshotWithinQuotas,
    QuotaExceededError,
    quotaDetails,
    snapshotQuotaUsage,
} from "./quotas";
import { API_QUOTAS } from "../shared/api-quotas";
import type { SnapshotStore } from "./storage";

export class WorkspaceNotFoundError extends Error {
    constructor(workspaceId: string) {
        super(`Workspace ${workspaceId} was not found`);
        this.name = "WorkspaceNotFoundError";
    }
}

function wasApplied(state: WorkspaceState, commandId: string): boolean {
    return state.commandReceipts?.includes(commandId) ||
        state.activities.some((activity) => activity.commandId === commandId) ||
        state.audit.some((event) => event.id === `audit_${commandId}`);
}

export async function synchronize(
    store: SnapshotStore,
    workspaceId: string,
    commands: CommandEnvelope[],
    maxRetries = 8,
): Promise<SyncResponse> {
    if (
        commands.some(
            (envelope) =>
                !envelope ||
                typeof envelope !== "object" ||
                envelope.workspaceId !== workspaceId,
        )
    ) {
        throw new DomainError("WRONG_WORKSPACE", "Sync batch contains a command for another workspace");
    }

    for (let attempt = 0; attempt < maxRetries; attempt += 1) {
        const initial = await store.load(workspaceId);
        if (!initial) throw new WorkspaceNotFoundError(workspaceId);
        let state = initial;
        let quotaUsage = snapshotQuotaUsage(initial);
        const receipts: SyncReceipt[] = [];
        let applied = false;

        for (const envelope of commands) {
            const commandId = typeof envelope.id === "string" && envelope.id
                ? envelope.id
                : `invalid-command-${receipts.length + 1}`;
            if (wasApplied(state, commandId)) {
                receipts.push({
                    commandId,
                    revision: state.workspace.revision,
                    status: "duplicate",
                });
                continue;
            }
            try {
                const optimisticUpperBound =
                    initial.workspace.revision + receipts.length;
                const command =
                    envelope.baseRevision > state.workspace.revision &&
                    envelope.baseRevision <= optimisticUpperBound
                        ? { ...envelope, baseRevision: state.workspace.revision }
                        : envelope;
                const result = applyCommand(state, command);
                const compactedState = compactWorkspaceHistory(
                    result.state,
                    {
                        activities: API_QUOTAS.activitiesPerSnapshot,
                        activityPatches: API_QUOTAS.activityPatchesPerSnapshot,
                        auditEvents: API_QUOTAS.auditEventsPerSnapshot,
                        commandReceipts: API_QUOTAS.commandReceiptsPerSnapshot,
                        serializedBytes: API_QUOTAS.storedSnapshotBytes,
                    },
                    {
                        activityIds: [
                            ...(result.activity ? [result.activity.id] : []),
                            ...(result.audit?.targetActivityIds ?? []),
                        ],
                        auditIds: result.audit ? [result.audit.id] : [],
                    },
                );
                const nextQuotaUsage = assertSnapshotWithinQuotas(compactedState, {
                    previousUsage: quotaUsage,
                });
                state = compactedState;
                quotaUsage = nextQuotaUsage;
                applied = true;
                receipts.push({
                    commandId,
                    revision: state.workspace.revision,
                    status: "applied",
                });
            } catch (error) {
                if (error instanceof QuotaExceededError) {
                    receipts.push({
                        commandId,
                        message: error.message,
                        revision: state.workspace.revision,
                        status: "rejected",
                        ...quotaDetails(error),
                    });
                    continue;
                }
                if (error instanceof ConflictError) {
                    receipts.push({
                        commandId,
                        conflicts: error.conflicts,
                        message: error.message,
                        revision: state.workspace.revision,
                        status: "rejected",
                    });
                    continue;
                }
                if (error instanceof DomainError) {
                    receipts.push({
                        commandId,
                        message: `${error.code}: ${error.message}`,
                        revision: state.workspace.revision,
                        status: "rejected",
                    });
                    continue;
                }
                throw error;
            }
        }

        if (!applied) return { receipts, snapshot: state };
        if (
            await store.compareAndSwap(
                workspaceId,
                initial.workspace.revision,
                state,
            )
        ) {
            return { receipts, snapshot: state };
        }
    }
    throw new Error("Workspace remained busy after all synchronization retries");
}
