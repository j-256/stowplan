import { normalizeWorkspaceState, type WorkspaceState } from "../domain";
import type { WorkspaceRole } from "../domain/workspace-access";
import { snapshotGrowthRefusal } from "../server/account-governance";
import { serializedJsonBytes } from "../server/quotas";
import type { SnapshotStore } from "../server/storage";

export const MAX_SAFE_AUTHORIZATION_REVISION = Number.MAX_SAFE_INTEGER;

export interface D1ResultLike<T = unknown> {
    meta?: { changes?: number };
    results?: T[];
    success: boolean;
}

export interface D1QueryResultLike<T> extends D1ResultLike<T> {
    results: T[];
}

export interface D1StatementLike {
    bind(...values: unknown[]): D1StatementLike;
    all<T = Record<string, unknown>>(): Promise<D1QueryResultLike<T>>;
    first<T = Record<string, unknown>>(): Promise<T | null>;
    run(): Promise<D1ResultLike>;
}

export interface D1DatabaseLike {
    batch(statements: D1StatementLike[]): Promise<D1ResultLike[]>;
    prepare(query: string): D1StatementLike;
}

interface SnapshotRow {
    revision: number;
    state_json: string;
}

export interface AuthorizedWorkspaceSnapshot {
    accessRevision: number;
    membershipRevision: number;
    ownerCount: number;
    role: WorkspaceRole;
    state: WorkspaceState;
    updatedAt: string;
}

interface AuthorizedSnapshotRow {
    access_revision: number;
    membership_revision: number;
    owner_count: number;
    revision: number;
    role: WorkspaceRole;
    state_json: string;
    updated_at: string;
}

export interface SnapshotAuthorizationExpectation {
    accessRevision: number;
    membershipRevision: number;
    requiredRole: "owner" | "writer";
    userId: string;
}

export interface WorkspaceAuthorizationState {
    accessRevision: number | null;
    active: boolean;
    deleted: boolean;
    membershipRevision: number;
    role: WorkspaceRole | null;
}

interface WorkspaceAuthorizationRow {
    access_revision: number | null;
    deleted: number;
    membership_revision: number;
    role: WorkspaceRole | null;
    status: "active" | "disabled";
}

export function isAuthorizationRevision(value: unknown): value is number {
    return typeof value === "number" &&
        Number.isSafeInteger(value) &&
        value >= 0;
}

export class D1SnapshotStore implements SnapshotStore {
    constructor(private readonly database: D1DatabaseLike) {}

    async compareAndSwap(
        workspaceId: string,
        expectedRevision: number,
        state: WorkspaceState,
    ): Promise<boolean> {
        const persistedAt = new Date().toISOString();
        const stateJson = JSON.stringify(state);
        const preflight = await snapshotGrowthRefusal(
            this.database,
            workspaceId,
            serializedJsonBytes(state),
            new Date(persistedAt),
        );
        if (preflight) throw preflight;
        let result: D1ResultLike;
        try {
            result = await this.database
                .prepare(
                    `UPDATE workspace_snapshots
                     SET revision = ?, state_json = ?, updated_at = ?
                     WHERE workspace_id = ? AND revision = ?`,
                )
                .bind(
                    state.workspace.revision,
                    stateJson,
                    persistedAt,
                    workspaceId,
                    expectedRevision,
                )
                .run();
        } catch (error) {
            const refusal = await snapshotGrowthRefusal(
                this.database,
                workspaceId,
                serializedJsonBytes(state),
                new Date(persistedAt),
            );
            if (refusal) throw refusal;
            throw error;
        }
        return result.success && result.meta?.changes === 1;
    }

    async compareAndSwapAuthorized(
        workspaceId: string,
        expectedRevision: number,
        state: WorkspaceState,
        authorization: SnapshotAuthorizationExpectation,
    ): Promise<boolean> {
        if (
            !isAuthorizationRevision(authorization.accessRevision) ||
            !isAuthorizationRevision(authorization.membershipRevision)
        ) {
            throw new RangeError(
                "Authorization revisions must be JavaScript-safe nonnegative integers",
            );
        }
        const rolePredicate = authorization.requiredRole === "owner"
            ? "members.role = 'owner'"
            : authorization.requiredRole === "writer"
                ? "members.role IN ('owner', 'editor')"
                : null;
        if (!rolePredicate) throw new Error("Invalid required workspace role");
        const persistedAt = new Date().toISOString();
        const stateJson = JSON.stringify(state);
        const preflight = await snapshotGrowthRefusal(
            this.database,
            workspaceId,
            serializedJsonBytes(state),
            new Date(persistedAt),
        );
        if (preflight) throw preflight;
        let result: D1ResultLike;
        try {
            result = await this.database
                .prepare(
                    `UPDATE workspace_snapshots
                     SET revision = ?, state_json = ?, updated_at = ?
                     WHERE workspace_id = ?
                       AND revision = ?
                       AND NOT EXISTS (
                         SELECT 1
                         FROM workspace_deletions
                         WHERE workspace_id =
                           workspace_snapshots.workspace_id
                       )
                       AND EXISTS (
                         SELECT 1
                         FROM workspace_members members
                         JOIN users
                           ON users.user_id = members.user_id
                         WHERE members.workspace_id =
                             workspace_snapshots.workspace_id
                           AND members.user_id = ?
                           AND users.status = 'active'
                           AND ${rolePredicate}
                           AND (
                             users.membership_revision = ?
                             OR workspace_snapshots.access_revision = ?
                           )
                       )`,
                )
                .bind(
                    state.workspace.revision,
                    stateJson,
                    persistedAt,
                    workspaceId,
                    expectedRevision,
                    authorization.userId,
                    authorization.membershipRevision,
                    authorization.accessRevision,
                )
                .run();
        } catch (error) {
            const refusal = await snapshotGrowthRefusal(
                this.database,
                workspaceId,
                serializedJsonBytes(state),
                new Date(persistedAt),
            );
            if (refusal) throw refusal;
            throw error;
        }
        return result.success && result.meta?.changes === 1;
    }

    async initialize(
        state: WorkspaceState,
    ): Promise<"created" | "deleted" | "exists"> {
        const persistedAt = new Date().toISOString();
        const result = await this.database
            .prepare(
                `INSERT OR IGNORE INTO workspace_snapshots
                    (workspace_id, revision, state_json, created_at, updated_at)
                 SELECT ?, ?, ?, ?, ?
                 WHERE NOT EXISTS (
                   SELECT 1
                   FROM workspace_deletions
                   WHERE workspace_id = ?
                 )`,
            )
            .bind(
                state.workspace.id,
                state.workspace.revision,
                JSON.stringify(state),
                persistedAt,
                persistedAt,
                state.workspace.id,
            )
            .run();
        if (result.meta?.changes === 1) return "created";
        const deletion = await this.database
            .prepare(
                `SELECT workspace_id
                 FROM workspace_deletions
                 WHERE workspace_id = ?`,
            )
            .bind(state.workspace.id)
            .first();
        return deletion ? "deleted" : "exists";
    }

    async load(workspaceId: string): Promise<WorkspaceState | null> {
        const row = await this.database
            .prepare(
                `SELECT revision, state_json
                 FROM workspace_snapshots
                 WHERE workspace_id = ?`,
            )
            .bind(workspaceId)
            .first<SnapshotRow>();
        if (!row) return null;
        const state = normalizeWorkspaceState(JSON.parse(row.state_json) as WorkspaceState);
        if (state.workspace.revision !== row.revision) {
            throw new Error("Stored workspace revision does not match its snapshot");
        }
        return state;
    }

    async loadAuthorized(
        workspaceId: string,
        userId: string,
    ): Promise<AuthorizedWorkspaceSnapshot | null> {
        const row = await this.database
            .prepare(
                `SELECT
                   snapshots.access_revision,
                   users.membership_revision,
                   (
                     SELECT COUNT(*)
                     FROM workspace_members owners
                     JOIN users owner_users
                       ON owner_users.user_id = owners.user_id
                     WHERE owners.workspace_id = snapshots.workspace_id
                       AND owners.role = 'owner'
                       AND owner_users.status = 'active'
                   ) AS owner_count,
                   snapshots.revision,
                   members.role,
                   snapshots.state_json,
                   snapshots.updated_at
                 FROM workspace_snapshots snapshots
                 JOIN workspace_members members
                   ON members.workspace_id = snapshots.workspace_id
                 JOIN users
                   ON users.user_id = members.user_id
                  AND users.status = 'active'
                 WHERE snapshots.workspace_id = ?
                   AND members.user_id = ?
                   AND NOT EXISTS (
                     SELECT 1
                     FROM workspace_deletions deletions
                     WHERE deletions.workspace_id =
                         snapshots.workspace_id
                   )`,
            )
            .bind(workspaceId, userId)
            .first<AuthorizedSnapshotRow>();
        if (!row) return null;
        if (
            !isAuthorizationRevision(row.access_revision) ||
            !isAuthorizationRevision(row.membership_revision)
        ) {
            throw new Error("Stored authorization revision is invalid");
        }
        const state = normalizeWorkspaceState(
            JSON.parse(row.state_json) as WorkspaceState,
        );
        if (state.workspace.revision !== row.revision) {
            throw new Error("Stored workspace revision does not match its snapshot");
        }
        return {
            accessRevision: row.access_revision,
            membershipRevision: row.membership_revision,
            ownerCount: row.owner_count,
            role: row.role,
            state,
            updatedAt: row.updated_at,
        };
    }

    async loadAuthorization(
        workspaceId: string,
        userId: string,
    ): Promise<WorkspaceAuthorizationState | null> {
        const row = await this.database
            .prepare(
                `SELECT
                   snapshots.access_revision,
                   EXISTS(
                     SELECT 1
                     FROM workspace_deletions deletions
                     WHERE deletions.workspace_id = ?
                   ) AS deleted,
                   users.membership_revision,
                   members.role,
                   users.status
                 FROM users
                 LEFT JOIN workspace_snapshots snapshots
                   ON snapshots.workspace_id = ?
                 LEFT JOIN workspace_members members
                   ON members.workspace_id = snapshots.workspace_id
                  AND members.user_id = users.user_id
                 WHERE users.user_id = ?`,
            )
            .bind(workspaceId, workspaceId, userId)
            .first<WorkspaceAuthorizationRow>();
        if (!row) return null;
        if (
            !isAuthorizationRevision(row.membership_revision) ||
            (
                row.access_revision !== null &&
                !isAuthorizationRevision(row.access_revision)
            )
        ) {
            throw new Error("Stored authorization revision is invalid");
        }
        return {
            accessRevision: row.access_revision,
            active: row.status === "active",
            deleted: row.deleted === 1,
            membershipRevision: row.membership_revision,
            role: row.role,
        };
    }

    async replace(
        workspaceId: string,
        expectedRevision: number,
        state: WorkspaceState,
    ): Promise<boolean> {
        return this.compareAndSwap(workspaceId, expectedRevision, state);
    }

    async deleteIfUnclaimed(
        workspaceId: string,
        expectedRevision: number,
    ): Promise<boolean> {
        const result = await this.database
            .prepare(
                `DELETE FROM workspace_snapshots
                 WHERE workspace_id = ? AND revision = ?
                   AND NOT EXISTS (
                     SELECT 1 FROM workspace_members
                     WHERE workspace_id = ?
                   )`,
            )
            .bind(workspaceId, expectedRevision, workspaceId)
            .run();
        return result.success && result.meta?.changes === 1;
    }
}
