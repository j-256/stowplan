import type { WorkspaceState } from "../domain/types";

export interface SnapshotStore {
    compareAndSwap(
        workspaceId: string,
        expectedRevision: number,
        state: WorkspaceState,
    ): Promise<boolean>;
    initialize(state: WorkspaceState): Promise<"created" | "exists">;
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
            this.states.set(state.workspace.id, structuredClone(state));
        }
    }

    async compareAndSwap(
        workspaceId: string,
        expectedRevision: number,
        state: WorkspaceState,
    ): Promise<boolean> {
        const current = this.states.get(workspaceId);
        if (!current || current.workspace.revision !== expectedRevision) return false;
        this.states.set(workspaceId, structuredClone(state));
        return true;
    }

    async initialize(state: WorkspaceState): Promise<"created" | "exists"> {
        if (this.states.has(state.workspace.id)) return "exists";
        this.states.set(state.workspace.id, structuredClone(state));
        return "created";
    }

    async load(workspaceId: string): Promise<WorkspaceState | null> {
        const state = this.states.get(workspaceId);
        return state ? structuredClone(state) : null;
    }

    async replace(
        workspaceId: string,
        expectedRevision: number,
        state: WorkspaceState,
    ): Promise<boolean> {
        return this.compareAndSwap(workspaceId, expectedRevision, state);
    }
}
