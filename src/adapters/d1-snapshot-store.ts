import { normalizeWorkspaceState, type WorkspaceState } from "../domain";
import type { SnapshotStore } from "../server/storage";

export interface D1ResultLike {
    meta?: { changes?: number };
    success: boolean;
}

export interface D1StatementLike {
    bind(...values: unknown[]): D1StatementLike;
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

export class D1SnapshotStore implements SnapshotStore {
    constructor(private readonly database: D1DatabaseLike) {}

    async compareAndSwap(
        workspaceId: string,
        expectedRevision: number,
        state: WorkspaceState,
    ): Promise<boolean> {
        const result = await this.database
            .prepare(
                `UPDATE workspace_snapshots
                 SET revision = ?, state_json = ?, updated_at = ?
                 WHERE workspace_id = ? AND revision = ?`,
            )
            .bind(
                state.workspace.revision,
                JSON.stringify(state),
                state.workspace.updatedAt,
                workspaceId,
                expectedRevision,
            )
            .run();
        return result.success && result.meta?.changes === 1;
    }

    async initialize(state: WorkspaceState): Promise<"created" | "exists"> {
        const result = await this.database
            .prepare(
                `INSERT OR IGNORE INTO workspace_snapshots
                    (workspace_id, revision, state_json, created_at, updated_at)
                 VALUES (?, ?, ?, ?, ?)`,
            )
            .bind(
                state.workspace.id,
                state.workspace.revision,
                JSON.stringify(state),
                state.workspace.createdAt,
                state.workspace.updatedAt,
            )
            .run();
        return result.meta?.changes === 1 ? "created" : "exists";
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
