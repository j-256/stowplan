import { applyCommand, ConflictError, DomainError } from "../domain";
import type { CommandEnvelope, SyncReceipt, SyncResponse, WorkspaceState } from "../domain";
import type { SnapshotStore } from "./storage";

export class WorkspaceNotFoundError extends Error {
    constructor(workspaceId: string) {
        super(`Workspace ${workspaceId} was not found`);
        this.name = "WorkspaceNotFoundError";
    }
}

function wasApplied(state: WorkspaceState, commandId: string): boolean {
    return state.activities.some((activity) => activity.commandId === commandId) ||
        state.audit.some((event) => event.id === `audit_${commandId}`);
}

export async function synchronize(
    store: SnapshotStore,
    workspaceId: string,
    commands: CommandEnvelope[],
    maxRetries = 8,
): Promise<SyncResponse> {
    if (commands.some((envelope) => envelope.workspaceId !== workspaceId)) {
        throw new DomainError("WRONG_WORKSPACE", "Sync batch contains a command for another workspace");
    }

    for (let attempt = 0; attempt < maxRetries; attempt += 1) {
        const initial = await store.load(workspaceId);
        if (!initial) throw new WorkspaceNotFoundError(workspaceId);
        let state = initial;
        const receipts: SyncReceipt[] = [];
        let applied = false;

        for (const envelope of commands) {
            if (wasApplied(state, envelope.id)) {
                receipts.push({
                    commandId: envelope.id,
                    revision: state.workspace.revision,
                    status: "duplicate",
                });
                continue;
            }
            try {
                const result = applyCommand(state, envelope);
                state = result.state;
                applied = true;
                receipts.push({
                    commandId: envelope.id,
                    revision: state.workspace.revision,
                    status: "applied",
                });
            } catch (error) {
                if (error instanceof ConflictError) {
                    receipts.push({
                        commandId: envelope.id,
                        conflicts: error.conflicts,
                        message: error.message,
                        revision: state.workspace.revision,
                        status: "rejected",
                    });
                    continue;
                }
                if (error instanceof DomainError) {
                    receipts.push({
                        commandId: envelope.id,
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
