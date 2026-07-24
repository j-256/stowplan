import type { AuditEvent, WorkspaceState } from "./types";

export interface HistoryRetentionLimits {
    activities: number;
    activityPatches: number;
    auditEvents: number;
    commandReceipts: number;
    serializedBytes: number;
}

export interface HistoryRetentionProtection {
    activityIds?: readonly string[];
    auditIds?: readonly string[];
}

function serializedBytes(value: unknown): number {
    const json = JSON.stringify(value);
    return json === undefined ? 0 : new TextEncoder().encode(json).byteLength;
}

function commandIdForAudit(event: AuditEvent): string | null {
    const prefix = "audit_";
    if (!event.id.startsWith(prefix)) return null;
    const commandId = event.id.slice(prefix.length);
    return commandId || null;
}

function withCommandReceipts(
    state: WorkspaceState,
    commandIds: readonly (string | null)[],
    limit: number,
): WorkspaceState {
    const receipts = Array.isArray(state.commandReceipts)
        ? [...state.commandReceipts]
        : [];
    const seen = new Set(receipts);
    for (const commandId of commandIds) {
        if (!commandId || seen.has(commandId)) continue;
        seen.add(commandId);
        receipts.push(commandId);
    }
    const retained = receipts.slice(Math.max(0, receipts.length - limit));
    if (
        retained.length === state.commandReceipts?.length &&
        retained.every((commandId, index) =>
            commandId === state.commandReceipts[index]
        )
    ) {
        return state;
    }
    return {
        ...state,
        commandReceipts: retained,
    };
}

function auditLabel(event: AuditEvent, count: number): string {
    const direction =
        event.type === "undo" || event.type === "batch_undo"
            ? "Undid"
            : "Reapplied";
    return `${direction} ${count} change${count === 1 ? "" : "s"}`;
}

function normalizeAudit(
    audit: readonly AuditEvent[],
    retainedActivityIds: ReadonlySet<string>,
): AuditEvent[] {
    return audit.flatMap((event) => {
        const targetActivityIds = event.targetActivityIds.filter((id) =>
            retainedActivityIds.has(id)
        );
        if (!targetActivityIds.length) return [];
        if (targetActivityIds.length === event.targetActivityIds.length) {
            return [event];
        }
        return [{
            ...event,
            label: auditLabel(event, targetActivityIds.length),
            targetActivityIds,
        }];
    });
}

function withoutActivities(
    state: WorkspaceState,
    removedIds: ReadonlySet<string>,
    receiptLimit: number,
): WorkspaceState {
    if (!removedIds.size) return state;
    const removedActivities = state.activities.filter((activity) =>
        removedIds.has(activity.id)
    );
    const activities = state.activities.filter(
        (activity) => !removedIds.has(activity.id),
    );
    const retainedIds = new Set(activities.map((activity) => activity.id));
    const audit = normalizeAudit(state.audit, retainedIds);
    const retainedAuditIds = new Set(audit.map((event) => event.id));
    return withCommandReceipts({
        ...state,
        activities,
        audit,
    }, [
        ...removedActivities.map((activity) => activity.commandId),
        ...state.audit
            .filter((event) => !retainedAuditIds.has(event.id))
            .map(commandIdForAudit),
    ], receiptLimit);
}

function withoutAudits(
    state: WorkspaceState,
    removedIds: ReadonlySet<string>,
    receiptLimit: number,
): WorkspaceState {
    if (!removedIds.size) return state;
    const removedCommandIds = state.audit
        .filter((event) => removedIds.has(event.id))
        .map(commandIdForAudit);
    return withCommandReceipts({
        ...state,
        audit: state.audit.filter((event) => !removedIds.has(event.id)),
    }, removedCommandIds, receiptLimit);
}

function withoutReceipts(
    state: WorkspaceState,
    removedIds: ReadonlySet<string>,
): WorkspaceState {
    if (!removedIds.size) return state;
    return {
        ...state,
        commandReceipts: state.commandReceipts.filter(
            (commandId) => !removedIds.has(commandId),
        ),
    };
}

function minimalRemovalCount(
    candidateIds: readonly string[],
    stateWithout: (removedIds: ReadonlySet<string>) => WorkspaceState,
    limit: number,
): number {
    let low = 1;
    let high = candidateIds.length;
    while (low < high) {
        const middle = Math.floor((low + high) / 2);
        const candidate = stateWithout(new Set(candidateIds.slice(0, middle)));
        if (serializedBytes(candidate) <= limit) {
            high = middle;
        } else {
            low = middle + 1;
        }
    }
    return low;
}

function compactReceiptBytes(
    state: WorkspaceState,
    byteLimit: number,
): WorkspaceState {
    const removableReceiptIds = state.commandReceipts.slice(0, -1);
    if (!removableReceiptIds.length) return state;
    const removeReceipts = (removedIds: ReadonlySet<string>) =>
        withoutReceipts(state, removedIds);
    const withoutEveryRemovableReceipt = removeReceipts(
        new Set(removableReceiptIds),
    );
    if (serializedBytes(withoutEveryRemovableReceipt) > byteLimit) {
        return withoutEveryRemovableReceipt;
    }
    const count = minimalRemovalCount(
        removableReceiptIds,
        removeReceipts,
        byteLimit,
    );
    return removeReceipts(new Set(removableReceiptIds.slice(0, count)));
}

function compactBytes(
    state: WorkspaceState,
    limits: HistoryRetentionLimits,
    protectedActivityIds: ReadonlySet<string>,
    protectedAuditIds: ReadonlySet<string>,
): WorkspaceState {
    if (serializedBytes(state) <= limits.serializedBytes) return state;

    const removableAuditIds = state.audit
        .filter((event) => !protectedAuditIds.has(event.id))
        .map((event) => event.id);
    if (removableAuditIds.length) {
        const removeAudits = (removedIds: ReadonlySet<string>) =>
            withoutAudits(state, removedIds, limits.commandReceipts);
        const withoutEveryRemovableAudit = removeAudits(
            new Set(removableAuditIds),
        );
        if (serializedBytes(withoutEveryRemovableAudit) <= limits.serializedBytes) {
            const count = minimalRemovalCount(
                removableAuditIds,
                removeAudits,
                limits.serializedBytes,
            );
            return removeAudits(new Set(removableAuditIds.slice(0, count)));
        }
        state = withoutEveryRemovableAudit;
    }

    const removableActivityIds = state.activities
        .filter((activity) => !protectedActivityIds.has(activity.id))
        .map((activity) => activity.id);
    if (!removableActivityIds.length) {
        return compactReceiptBytes(state, limits.serializedBytes);
    }
    const removeActivities = (removedIds: ReadonlySet<string>) =>
        withoutActivities(state, removedIds, limits.commandReceipts);
    const withoutEveryRemovableActivity = removeActivities(
        new Set(removableActivityIds),
    );
    if (serializedBytes(withoutEveryRemovableActivity) <= limits.serializedBytes) {
        const count = minimalRemovalCount(
            removableActivityIds,
            removeActivities,
            limits.serializedBytes,
        );
        return removeActivities(new Set(removableActivityIds.slice(0, count)));
    }
    state = withoutEveryRemovableActivity;
    return compactReceiptBytes(state, limits.serializedBytes);
}

export function compactWorkspaceHistory(
    state: WorkspaceState,
    limits: HistoryRetentionLimits,
    protection: HistoryRetentionProtection = {},
): WorkspaceState {
    const protectedActivityIds = new Set(protection.activityIds ?? []);
    const protectedAuditIds = new Set(protection.auditIds ?? []);
    const removedActivityIds = new Set<string>();
    let compacted = withCommandReceipts(
        state,
        [],
        limits.commandReceipts,
    );
    let remainingActivities = compacted.activities.length;
    let remainingPatches = compacted.activities.reduce(
        (total, activity) => total + activity.patches.length,
        0,
    );
    for (const activity of compacted.activities) {
        if (
            remainingActivities <= limits.activities &&
            remainingPatches <= limits.activityPatches
        ) {
            break;
        }
        if (protectedActivityIds.has(activity.id)) continue;
        removedActivityIds.add(activity.id);
        remainingActivities -= 1;
        remainingPatches -= activity.patches.length;
    }

    compacted = withoutActivities(
        compacted,
        removedActivityIds,
        limits.commandReceipts,
    );
    const removableAuditIds = compacted.audit
        .filter((event) => !protectedAuditIds.has(event.id))
        .slice(0, Math.max(0, compacted.audit.length - limits.auditEvents))
        .map((event) => event.id);
    compacted = withoutAudits(
        compacted,
        new Set(removableAuditIds),
        limits.commandReceipts,
    );
    return compactBytes(
        compacted,
        limits,
        protectedActivityIds,
        protectedAuditIds,
    );
}
