import { DatabaseSync } from "node:sqlite";
import { normalizeWorkspaceState, type WorkspaceState } from "../domain";
import type { SnapshotStore } from "../server/storage";

const MAX_SAFE_AUTHORIZATION_REVISION = Number.MAX_SAFE_INTEGER;

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
                access_revision INTEGER NOT NULL DEFAULT 0,
                state_json TEXT NOT NULL,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            ) STRICT;
        `);
        const snapshotColumns = this.database
            .prepare("PRAGMA table_info(workspace_snapshots)")
            .all() as { name: string }[];
        if (!snapshotColumns.some((column) => column.name === "access_revision")) {
            this.database.exec(
                `ALTER TABLE workspace_snapshots
                 ADD COLUMN access_revision INTEGER NOT NULL DEFAULT 0`,
            );
        }
        this.database.exec(`
            CREATE TABLE IF NOT EXISTS workspace_deletions (
                workspace_id TEXT PRIMARY KEY,
                deletion_id TEXT NOT NULL,
                deleted_at TEXT NOT NULL,
                deleted_by_user_id TEXT,
                final_snapshot_revision INTEGER NOT NULL
                    CHECK (
                        final_snapshot_revision >= 0
                        AND final_snapshot_revision <=
                            ${MAX_SAFE_AUTHORIZATION_REVISION}
                    ),
                final_access_revision INTEGER NOT NULL
                    CHECK (
                        final_access_revision >= 0
                        AND final_access_revision <=
                            ${MAX_SAFE_AUTHORIZATION_REVISION}
                    )
            ) STRICT;

            CREATE UNIQUE INDEX IF NOT EXISTS
                workspace_deletions_deletion_id_idx
            ON workspace_deletions(deletion_id);

            CREATE TRIGGER IF NOT EXISTS
                workspace_snapshots_access_revision_insert_guard
            BEFORE INSERT ON workspace_snapshots
            WHEN typeof(NEW.access_revision) <> 'integer'
                OR NEW.access_revision < 0
                OR NEW.access_revision > ${MAX_SAFE_AUTHORIZATION_REVISION}
            BEGIN
                SELECT RAISE(
                    ABORT,
                    'workspace access revision must remain JavaScript-safe and monotonic'
                );
            END;

            CREATE TRIGGER IF NOT EXISTS
                workspace_snapshots_access_revision_update_guard
            BEFORE UPDATE OF access_revision ON workspace_snapshots
            WHEN typeof(NEW.access_revision) <> 'integer'
                OR NEW.access_revision < 0
                OR NEW.access_revision < OLD.access_revision
                OR NEW.access_revision > ${MAX_SAFE_AUTHORIZATION_REVISION}
            BEGIN
                SELECT RAISE(
                    ABORT,
                    'workspace access revision must remain JavaScript-safe and monotonic'
                );
            END;
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
        const persistedAt = new Date().toISOString();
        const result = this.database
            .prepare(
                `UPDATE workspace_snapshots
                 SET revision = ?, state_json = ?, updated_at = ?
                 WHERE workspace_id = ? AND revision = ?`,
            )
            .run(
                state.workspace.revision,
                JSON.stringify(state),
                persistedAt,
                workspaceId,
                expectedRevision,
            );
        return result.changes === 1;
    }

    async initialize(
        state: WorkspaceState,
    ): Promise<"created" | "deleted" | "exists"> {
        const persistedAt = new Date().toISOString();
        const result = this.database
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
            .run(
                state.workspace.id,
                state.workspace.revision,
                JSON.stringify(state),
                persistedAt,
                persistedAt,
                state.workspace.id,
            );
        if (result.changes === 1) return "created";
        const deletion = this.database.prepare(
            `SELECT workspace_id
             FROM workspace_deletions
             WHERE workspace_id = ?`,
        ).get(state.workspace.id);
        return deletion ? "deleted" : "exists";
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
