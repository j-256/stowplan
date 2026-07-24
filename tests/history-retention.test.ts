import { describe, expect, it } from "vitest";
import {
    compactWorkspaceHistory,
    createEmptyState,
    parseSnapshot,
    type ActivityRecord,
    type AuditEvent,
    type FieldPatch,
    validateSnapshot,
} from "../src/domain";

function patches(
    workspaceId: string,
    activityId: string,
    count: number,
): FieldPatch[] {
    return Array.from({ length: count }, (_, index) => ({
        after: `${activityId}-after-${index}`,
        before: `${activityId}-before-${index}`,
        id: workspaceId,
        path: "name",
        target: "workspace",
    }));
}

function activity(
    workspaceId: string,
    id: string,
    patchCount: number,
): ActivityRecord {
    return {
        actorId: "user_history",
        commandId: `command_${id}`,
        id,
        label: id,
        patches: patches(workspaceId, id, patchCount),
        status: "applied",
        subjectIds: [workspaceId],
        timestamp: "2026-07-24T12:00:00.000Z",
        undoneAt: null,
    };
}

function audit(targetActivityIds: string[]): AuditEvent {
    return {
        actorId: "user_history",
        id: "audit_history",
        label: `Undid ${targetActivityIds.length} changes`,
        targetActivityIds,
        timestamp: "2026-07-24T12:01:00.000Z",
        type: "batch_undo",
    };
}

describe("history retention", () => {
    it("drops the oldest unprotected history and repairs audit references", () => {
        const state = createEmptyState(
            "Retention",
            "2026-07-24T12:00:00.000Z",
        );
        state.activities = [
            activity(state.workspace.id, "activity_first", 3),
            activity(state.workspace.id, "activity_second", 2),
            activity(state.workspace.id, "activity_current", 1),
        ];
        state.audit = [audit(state.activities.map((entry) => entry.id))];

        const compacted = compactWorkspaceHistory(
            state,
            {
                activities: 2,
                activityPatches: 3,
                auditEvents: 10,
                commandReceipts: 10,
                serializedBytes: Number.MAX_SAFE_INTEGER,
            },
            {
                activityIds: ["activity_current"],
            },
        );

        expect(compacted.activities.map((entry) => entry.id)).toEqual([
            "activity_second",
            "activity_current",
        ]);
        expect(compacted.audit).toEqual([
            expect.objectContaining({
                label: "Undid 2 changes",
                targetActivityIds: [
                    "activity_second",
                    "activity_current",
                ],
            }),
        ]);
        expect(compacted.commandReceipts).toEqual([
            "command_activity_first",
        ]);
        expect(validateSnapshot(compacted)).not.toEqual(
            expect.arrayContaining([
                expect.objectContaining({ severity: "error" }),
            ]),
        );
        expect(state.activities).toHaveLength(3);
        expect(state.audit[0]?.targetActivityIds).toHaveLength(3);
    });

    it("removes audit detail before undoable activities to meet a byte limit", () => {
        const state = createEmptyState(
            "Retention",
            "2026-07-24T12:00:00.000Z",
        );
        state.activities = [
            activity(state.workspace.id, "activity_first", 1),
            activity(state.workspace.id, "activity_current", 1),
        ];
        state.audit = [{
            ...audit(["activity_first"]),
            label: "x".repeat(10_000),
        }];
        const withoutAudit = {
            ...state,
            audit: [],
            commandReceipts: ["history"],
        };
        const byteLimit = new TextEncoder().encode(
            JSON.stringify(withoutAudit),
        ).byteLength;

        const compacted = compactWorkspaceHistory(
            state,
            {
                activities: 10,
                activityPatches: 10,
                auditEvents: 10,
                commandReceipts: 10,
                serializedBytes: byteLimit,
            },
            {
                activityIds: ["activity_current"],
            },
        );

        expect(compacted.audit).toEqual([]);
        expect(compacted.activities).toEqual(state.activities);
        expect(compacted.commandReceipts).toEqual(["history"]);
    });

    it("bounds compact receipts oldest first and reads snapshots without a ledger", () => {
        const state = createEmptyState(
            "Receipts",
            "2026-07-24T12:00:00.000Z",
        );
        state.commandReceipts = ["command_first", "command_second", "command_current"];

        const compacted = compactWorkspaceHistory(state, {
            activities: 10,
            activityPatches: 10,
            auditEvents: 10,
            commandReceipts: 2,
            serializedBytes: Number.MAX_SAFE_INTEGER,
        });
        expect(compacted.commandReceipts).toEqual([
            "command_second",
            "command_current",
        ]);

        const legacy = structuredClone(state) as unknown as Record<string, unknown>;
        delete legacy.commandReceipts;
        expect(parseSnapshot(JSON.stringify(legacy)).commandReceipts).toEqual([]);
    });

    it("expires compact receipts oldest first under byte pressure", () => {
        const state = createEmptyState(
            "Receipt bytes",
            "2026-07-24T12:00:00.000Z",
        );
        state.commandReceipts = [
            `command_first_${"x".repeat(1_000)}`,
            `command_second_${"x".repeat(1_000)}`,
            "command_current",
        ];
        const onlyNewest = {
            ...state,
            commandReceipts: ["command_current"],
        };
        const byteLimit = new TextEncoder().encode(
            JSON.stringify(onlyNewest),
        ).byteLength;

        const compacted = compactWorkspaceHistory(state, {
            activities: 10,
            activityPatches: 10,
            auditEvents: 10,
            commandReceipts: 10,
            serializedBytes: byteLimit,
        });

        expect(compacted.commandReceipts).toEqual(["command_current"]);
    });
});
