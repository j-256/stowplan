import {
    applyCommand,
    compactWorkspaceHistory,
    ConflictError,
    DomainError,
} from "../domain";
import type {
    CommandAuthorizationBasis,
    CommandEnvelope,
    SyncReceipt,
    SyncResponse,
    WorkspaceState,
} from "../domain";
import type {
    AuthorizedWorkspaceSnapshot,
    SnapshotAuthorizationExpectation,
    WorkspaceAuthorizationState,
} from "../adapters/d1-snapshot-store";
import {
    assertSnapshotWithinQuotas,
    QuotaExceededError,
    quotaDetails,
    snapshotQuotaUsage,
} from "./quotas";
import { API_QUOTAS } from "../shared/api-quotas";
import type { SnapshotStore } from "./storage";

const DEFAULT_SYNC_RETRIES = 8;

export class WorkspaceNotFoundError extends Error {
    constructor(workspaceId: string) {
        super(`Workspace ${workspaceId} was not found`);
        this.name = "WorkspaceNotFoundError";
    }
}

export type WorkspaceSyncAuthorizationFailure =
    | "deleted"
    | "inactive"
    | "revoked"
    | "stale"
    | "write";

export interface SyncAuthorizationContext {
    basis: CommandAuthorizationBasis;
    userId: string;
}

export interface SyncOptions {
    authorization?: SyncAuthorizationContext;
    maxRetries?: number;
}

interface AuthorizationAwareSnapshotStore extends SnapshotStore {
    compareAndSwapAuthorized(
        workspaceId: string,
        expectedRevision: number,
        state: WorkspaceState,
        authorization: SnapshotAuthorizationExpectation,
    ): Promise<boolean>;
    loadAuthorization(
        workspaceId: string,
        userId: string,
    ): Promise<WorkspaceAuthorizationState | null>;
    loadAuthorized(
        workspaceId: string,
        userId: string,
    ): Promise<AuthorizedWorkspaceSnapshot | null>;
}

export class WorkspaceSyncAuthorizationError extends Error {
    constructor(
        readonly failure: WorkspaceSyncAuthorizationFailure,
        message: string,
        readonly receipts: SyncReceipt[],
        readonly revision: number,
        readonly authorization: WorkspaceAuthorizationState | null,
    ) {
        super(message);
        this.name = "WorkspaceSyncAuthorizationError";
    }
}

function isAuthorizationAwareStore(
    store: SnapshotStore,
): store is AuthorizationAwareSnapshotStore {
    const candidate = store as Partial<AuthorizationAwareSnapshotStore>;
    return typeof candidate.compareAndSwapAuthorized === "function" &&
        typeof candidate.loadAuthorization === "function" &&
        typeof candidate.loadAuthorized === "function";
}

function authorizationFailure(
    authorization: WorkspaceAuthorizationState | null,
    expected: CommandAuthorizationBasis,
): {
    failure: WorkspaceSyncAuthorizationFailure;
    message: string;
} | null {
    if (!authorization || !authorization.active) {
        return {
            failure: "inactive",
            message: "The signed-in account is no longer active",
        };
    }
    if (authorization.deleted) {
        return {
            failure: "deleted",
            message: "The server workspace was deleted",
        };
    }
    if (!authorization.role) {
        return {
            failure: "revoked",
            message: "Workspace access was removed",
        };
    }
    if (authorization.role === "viewer") {
        return {
            failure: "write",
            message: "Viewer access does not allow workspace changes",
        };
    }
    if (
        authorization.membershipRevision !== expected.membershipRevision &&
        authorization.accessRevision !== expected.workspaceAccessRevision
    ) {
        return {
            failure: "stale",
            message:
                "Workspace access changed after these edits were created",
        };
    }
    return null;
}

function authorizationReceipts(
    commands: CommandEnvelope[],
    revision: number,
    message: string,
    existing: SyncReceipt[] = [],
): SyncReceipt[] {
    const existingById = new Map(
        existing.map((receipt) => [receipt.commandId, receipt]),
    );
    return commands.map((command, index) => {
        const commandId = typeof command.id === "string" && command.id
            ? command.id
            : `invalid-command-${index + 1}`;
        const receipt = existingById.get(commandId);
        if (receipt?.status === "duplicate") return receipt;
        return {
            commandId,
            message,
            revision,
            status: "rejected",
        };
    });
}

async function authorizedSnapshot(
    store: AuthorizationAwareSnapshotStore,
    workspaceId: string,
    commands: CommandEnvelope[],
    context: SyncAuthorizationContext,
): Promise<AuthorizedWorkspaceSnapshot> {
    const authorized = await store.loadAuthorized(
        workspaceId,
        context.userId,
    );
    if (authorized) {
        const current: WorkspaceAuthorizationState = {
            accessRevision: authorized.accessRevision,
            active: true,
            deleted: false,
            membershipRevision: authorized.membershipRevision,
            role: authorized.role,
        };
        const refusal = commands.length
            ? authorizationFailure(current, context.basis)
            : null;
        if (!refusal) return authorized;
        throw new WorkspaceSyncAuthorizationError(
            refusal.failure,
            refusal.message,
            authorizationReceipts(
                commands,
                authorized.state.workspace.revision,
                refusal.message,
            ),
            authorized.state.workspace.revision,
            current,
        );
    }
    const current = await store.loadAuthorization(
        workspaceId,
        context.userId,
    );
    const refusal = authorizationFailure(current, context.basis) ?? {
        failure: "revoked" as const,
        message: "Workspace access is unavailable",
    };
    throw new WorkspaceSyncAuthorizationError(
        refusal.failure,
        refusal.message,
        authorizationReceipts(commands, 0, refusal.message),
        0,
        current,
    );
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
    options: number | SyncOptions = DEFAULT_SYNC_RETRIES,
): Promise<SyncResponse> {
    const maxRetries = typeof options === "number"
        ? options
        : options.maxRetries ?? DEFAULT_SYNC_RETRIES;
    const authorization = typeof options === "number"
        ? undefined
        : options.authorization;
    if (authorization && !isAuthorizationAwareStore(store)) {
        throw new Error(
            "Authorization-aware synchronization requires an authorized store",
        );
    }
    const authorizedStore = authorization
        ? store as AuthorizationAwareSnapshotStore
        : null;
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
        const authorized = authorization
            ? await authorizedSnapshot(
                authorizedStore!,
                workspaceId,
                commands,
                authorization,
            )
            : null;
        const initial = authorized?.state ?? await store.load(workspaceId);
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
        const swapped = authorization
            ? await authorizedStore!.compareAndSwapAuthorized(
                workspaceId,
                initial.workspace.revision,
                state,
                {
                    accessRevision:
                        authorization.basis.workspaceAccessRevision,
                    membershipRevision:
                        authorization.basis.membershipRevision,
                    requiredRole: "writer",
                    userId: authorization.userId,
                },
            )
            : await store.compareAndSwap(
                workspaceId,
                initial.workspace.revision,
                state,
            );
        if (swapped) {
            return { receipts, snapshot: state };
        }
        if (authorization) {
            const current = await authorizedStore!.loadAuthorization(
                workspaceId,
                authorization.userId,
            );
            const refusal = authorizationFailure(
                current,
                authorization.basis,
            );
            if (refusal) {
                throw new WorkspaceSyncAuthorizationError(
                    refusal.failure,
                    refusal.message,
                    authorizationReceipts(
                        commands,
                        initial.workspace.revision,
                        refusal.message,
                        receipts,
                    ),
                    initial.workspace.revision,
                    current,
                );
            }
        }
    }
    throw new Error("Workspace remained busy after all synchronization retries");
}
