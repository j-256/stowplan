import { DatabaseSync } from "node:sqlite";
import { normalizeWorkspaceState, type WorkspaceState } from "../domain";
import type { SnapshotStore } from "../server/storage";

interface SnapshotRow {
    revision: number;
    state_json: string;
}

export class NodeSqliteSnapshotStore implements SnapshotStore {
    readonly database: DatabaseSync;

    constructor(filename: string) {
        this.database = new DatabaseSync(filename);
        this.database.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;");
        this.database.exec(`
            CREATE TABLE IF NOT EXISTS workspace_snapshots (
                workspace_id TEXT PRIMARY KEY,
                revision INTEGER NOT NULL,
                state_json TEXT NOT NULL,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            ) STRICT;
        `);
    }

    close(): void {
        this.database.close();
    }

    async compareAndSwap(
        workspaceId: string,
        expectedRevision: number,
        state: WorkspaceState,
    ): Promise<boolean> {
        const result = this.database
            .prepare(
                `UPDATE workspace_snapshots
                 SET revision = ?, state_json = ?, updated_at = ?
                 WHERE workspace_id = ? AND revision = ?`,
            )
            .run(
                state.workspace.revision,
                JSON.stringify(state),
                state.workspace.updatedAt,
                workspaceId,
                expectedRevision,
            );
        return result.changes === 1;
    }

    async initialize(state: WorkspaceState): Promise<"created" | "exists"> {
        const result = this.database
            .prepare(
                `INSERT OR IGNORE INTO workspace_snapshots
                    (workspace_id, revision, state_json, created_at, updated_at)
                 VALUES (?, ?, ?, ?, ?)`,
            )
            .run(
                state.workspace.id,
                state.workspace.revision,
                JSON.stringify(state),
                state.workspace.createdAt,
                state.workspace.updatedAt,
            );
        return result.changes === 1 ? "created" : "exists";
    }

    async load(workspaceId: string): Promise<WorkspaceState | null> {
        const row = this.database
            .prepare(
                `SELECT revision, state_json
                 FROM workspace_snapshots
                 WHERE workspace_id = ?`,
            )
            .get(workspaceId) as unknown as SnapshotRow | undefined;
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
}
