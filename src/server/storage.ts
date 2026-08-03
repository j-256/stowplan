import { normalizeWorkspaceState } from "../domain/import";
import type { WorkspaceState } from "../domain/types";

function normalizedClone(state: WorkspaceState): WorkspaceState {
    return normalizeWorkspaceState(structuredClone(state));
}

export interface SnapshotStore {
    compareAndSwap(
        workspaceId: string,
        expectedRevision: number,
        state: WorkspaceState,
    ): Promise<boolean>;
    initialize(
        state: WorkspaceState,
    ): Promise<"created" | "deleted" | "exists">;
    load(workspaceId: string): Promise<WorkspaceState | null>;
    replace(
        workspaceId: string,
        expectedRevision: number,
        state: WorkspaceState,
    ): Promise<boolean>;
}

export class MemorySnapshotStore implements SnapshotStore {
    private readonly states = new Map<string, WorkspaceState>();

    constructor(initialStates: WorkspaceState[] = []) {
        for (const state of initialStates) {
            this.states.set(state.workspace.id, normalizedClone(state));
        }
    }

    async compareAndSwap(
        workspaceId: string,
        expectedRevision: number,
        state: WorkspaceState,
    ): Promise<boolean> {
        const current = this.states.get(workspaceId);
        if (!current || current.workspace.revision !== expectedRevision) return false;
        this.states.set(workspaceId, normalizedClone(state));
        return true;
    }

    async initialize(
        state: WorkspaceState,
    ): Promise<"created" | "deleted" | "exists"> {
        if (this.states.has(state.workspace.id)) return "exists";
        this.states.set(state.workspace.id, normalizedClone(state));
        return "created";
    }

    async load(workspaceId: string): Promise<WorkspaceState | null> {
        const state = this.states.get(workspaceId);
        return state ? normalizedClone(state) : null;
    }

    async replace(
        workspaceId: string,
        expectedRevision: number,
        state: WorkspaceState,
    ): Promise<boolean> {
        return this.compareAndSwap(workspaceId, expectedRevision, state);
    }
}
