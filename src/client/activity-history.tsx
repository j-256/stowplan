"use client";

import { History as HistoryIcon, Undo2 } from "lucide-react";
import { useRef, useState } from "react";
import { meaningfulActivityPatches } from "../domain/activity";
import type {
  ActivityRecord,
  AuditEvent,
  Command,
  FieldPatch,
  WorkspaceState,
} from "../domain/types";

export const HISTORY_PAGE_SIZE = 50;
export const MAXIMUM_HISTORY_BATCH_COUNT = 100;
const DEFAULT_HISTORY_BATCH_COUNT = 5;
const FIELD_SUMMARY_LIMIT = 4;
const AUDIT_TARGET_SUMMARY_LIMIT = 2;

const FIELD_LABELS = Object.freeze<Record<string, string>>({
  archivedAt: "archive status",
  captureStatus: "capture status",
  locationId: "location",
  order: "position",
  parentId: "parent space",
  steps: "plan steps",
});

const RECORD_LABELS = Object.freeze<Record<FieldPatch["target"], string>>({
  item: "item record",
  location: "space record",
  plan: "plan record",
  workspace: "workspace record",
});

type HistoryCommand = Extract<Command, { type: `history.${string}` }>;

interface ActivityHistoryProps {
  onCommand?: (command: HistoryCommand) => Promise<boolean | void>;
  state: WorkspaceState;
}

export interface ActivityActionGate {
  run: (action: () => Promise<unknown>) => Promise<boolean>;
}

function countLabel(count: number, singular: string): string {
  return `${count} ${singular}${count === 1 ? "" : "s"}`;
}

function humanizeField(path: string): string {
  return FIELD_LABELS[path] ?? path
    .replaceAll("_", " ")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLocaleLowerCase();
}

function patchLabel(fieldPatch: FieldPatch): string {
  if (!fieldPatch.path) return RECORD_LABELS[fieldPatch.target];
  if (fieldPatch.target === "plan" && fieldPatch.path === "status") {
    return "plan status";
  }
  return humanizeField(fieldPatch.path);
}

function boundedSummary(values: readonly string[], limit: number): string {
  const visible = values.slice(0, limit);
  const remainder = values.length - visible.length;
  return remainder > 0
    ? `${visible.join(", ")}, +${remainder} more`
    : visible.join(", ");
}

export function activityChangeSummary(activity: ActivityRecord): string {
  const meaningful = meaningfulActivityPatches(activity.patches);
  const recordIds = new Set(
    activity.subjectIds.length
      ? activity.subjectIds
      : meaningful.map((fieldPatch) =>
          `${fieldPatch.target}:${fieldPatch.id}`
        ),
  );
  const recordSummary = countLabel(recordIds.size, "record");
  const fields = [...new Set(meaningful.map(patchLabel))];
  return fields.length
    ? `${recordSummary} · ${boundedSummary(fields, FIELD_SUMMARY_LIMIT)}`
    : `${recordSummary} · details no longer retained`;
}

export function auditTargetSummary(
  event: AuditEvent,
  activities: readonly ActivityRecord[],
): string {
  const byId = new Map(activities.map((activity) => [activity.id, activity]));
  const labels: string[] = [];
  let retainedOmitted = 0;
  let unavailable = 0;
  for (const activityId of event.targetActivityIds) {
    const label = byId.get(activityId)?.label;
    if (!label) {
      unavailable += 1;
    } else if (labels.length < AUDIT_TARGET_SUMMARY_LIMIT) {
      labels.push(label);
    } else {
      retainedOmitted += 1;
    }
  }
  if (!event.targetActivityIds.length) return "No target detail recorded";
  const parts = [...labels];
  if (retainedOmitted > 0) {
    parts.push(`${countLabel(retainedOmitted, "more retained change")}`);
  }
  if (unavailable > 0) {
    parts.push(`${countLabel(unavailable, "target")} no longer retained`);
  }
  return parts.join("; ");
}

export function normalizeHistoryBatchCount(value: number | string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return 1;
  return Math.max(
    1,
    Math.min(MAXIMUM_HISTORY_BATCH_COUNT, Math.trunc(parsed)),
  );
}

export function createActivityActionGate(): ActivityActionGate {
  let pending = false;
  return {
    async run(action) {
      if (pending) return false;
      pending = true;
      try {
        await action();
        return true;
      } finally {
        pending = false;
      }
    },
  };
}

function formatTimestamp(timestamp: string): string {
  const date = new Date(timestamp);
  return Number.isFinite(date.getTime()) ? date.toLocaleString() : timestamp;
}

export function ActivityHistory({ onCommand, state }: ActivityHistoryProps) {
  const [batchCount, setBatchCount] = useState(DEFAULT_HISTORY_BATCH_COUNT);
  const [pendingKey, setPendingKey] = useState<string | null>(null);
  const [visibleActivities, setVisibleActivities] = useState(HISTORY_PAGE_SIZE);
  const [visibleAudit, setVisibleAudit] = useState(HISTORY_PAGE_SIZE);
  const gate = useRef(createActivityActionGate()).current;
  const editable = Boolean(onCommand);
  const busy = pendingKey !== null;
  const appliedCount = state.activities.filter(
    (activity) => activity.status === "applied",
  ).length;
  const undoneCount = state.activities.length - appliedCount;
  const undoCount = Math.min(batchCount, appliedCount);
  const redoCount = Math.min(batchCount, undoneCount);
  const activities = [...state.activities]
    .reverse()
    .slice(0, visibleActivities);
  const audit = [...state.audit].reverse().slice(0, visibleAudit);

  const run = async (key: string, command: HistoryCommand) => {
    if (!onCommand) return;
    await gate.run(async () => {
      setPendingKey(key);
      try {
        await onCommand(command);
      } finally {
        setPendingKey(null);
      }
    });
  };

  return <div className="content activity-view">
    <div className="toolbar activity-toolbar">
      <span>
        <strong>{countLabel(state.activities.length, "recorded change")}</strong>
        <small>{countLabel(state.audit.length, "undo or reapply action")}</small>
      </span>
      {editable && <div className="history-batch" aria-busy={busy || undefined}>
        <label>
          Changes
          <input
            aria-label="Batch history count"
            disabled={busy}
            max={MAXIMUM_HISTORY_BATCH_COUNT}
            min="1"
            onChange={(event) =>
              setBatchCount(normalizeHistoryBatchCount(event.currentTarget.value))
            }
            step="1"
            type="number"
            value={batchCount}
          />
        </label>
        <button
          disabled={busy || undoCount === 0}
          onClick={() => void run(
            "batch-undo",
            { type: "history.batchUndo", count: undoCount },
          )}
          type="button"
        >
          {pendingKey === "batch-undo" ? "Undoing..." : `Undo ${undoCount}`}
        </button>
        <button
          disabled={busy || redoCount === 0}
          onClick={() => void run(
            "batch-redo",
            { type: "history.batchRedo", count: redoCount },
          )}
          type="button"
        >
          {pendingKey === "batch-redo" ? "Redoing..." : `Redo ${redoCount}`}
        </button>
      </div>}
    </div>
    <div className="activity-columns">
      <section
        aria-labelledby="activity-changes-heading"
        className="panel history activity-list"
      >
        <header className="activity-section-heading">
          <span>
            <p className="eyebrow">Workspace timeline</p>
            <h2 id="activity-changes-heading">Meaningful changes</h2>
          </span>
          <b>{countLabel(appliedCount, "applied")}</b>
        </header>
        {activities.map((entry, index) => {
          const action = entry.status === "applied" ? "Undo" : "Reapply";
          const key = `activity-${entry.id}`;
          const timestamp = formatTimestamp(entry.timestamp);
          return <div className="activity-row" data-status={entry.status} key={entry.id}>
            <Undo2 aria-hidden="true" />
            <span>
              <strong>{entry.label}</strong>
              <small id={`activity-detail-${index}`}>
                <time dateTime={entry.timestamp}>{timestamp}</time>
                {` · ${activityChangeSummary(entry)}`}
              </small>
            </span>
            <b>{entry.status}</b>
            {editable && <button
              aria-describedby={`activity-detail-${index}`}
              aria-label={`${action} ${entry.label} from ${timestamp}`}
              disabled={busy}
              onClick={() => void run(
                key,
                entry.status === "applied"
                  ? { type: "history.undo", activityId: entry.id }
                  : { type: "history.reapply", activityId: entry.id },
              )}
              type="button"
            >
              {pendingKey === key
                ? `${action === "Undo" ? "Undoing" : "Reapplying"}...`
                : action === "Undo" ? "Undo this" : "Reapply"}
            </button>}
          </div>;
        })}
        {!state.activities.length && <div className="empty activity-empty">
          <b>□</b>
          <h3>No changes yet</h3>
          <p>Meaningful workspace changes will appear here.</p>
        </div>}
        {visibleActivities < state.activities.length && <footer className="activity-more">
          <button
            onClick={() => setVisibleActivities((count) => count + HISTORY_PAGE_SIZE)}
            type="button"
          >
            Show {countLabel(
              Math.min(
                HISTORY_PAGE_SIZE,
                state.activities.length - visibleActivities,
              ),
              "older change",
            )}
          </button>
        </footer>}
      </section>
      <section
        aria-labelledby="activity-audit-heading"
        className="panel activity-audit-list"
      >
        <header className="activity-section-heading">
          <span>
            <p className="eyebrow">History actions</p>
            <h2 id="activity-audit-heading">Undo and reapply log</h2>
          </span>
          <b>{state.audit.length}</b>
        </header>
        {audit.map((event) => <div className="activity-audit-row" key={event.id}>
          <HistoryIcon aria-hidden="true" />
          <span>
            <strong>{event.label}</strong>
            <small>
              <time dateTime={event.timestamp}>{formatTimestamp(event.timestamp)}</time>
              {` · ${auditTargetSummary(event, state.activities)}`}
            </small>
          </span>
        </div>)}
        {!state.audit.length && <div className="empty activity-empty">
          <b>↶</b>
          <h3>No history actions yet</h3>
          <p>Undo and reapply actions will be recorded here.</p>
        </div>}
        {visibleAudit < state.audit.length && <footer className="activity-more">
          <button
            onClick={() => setVisibleAudit((count) => count + HISTORY_PAGE_SIZE)}
            type="button"
          >
            Show {countLabel(
              Math.min(HISTORY_PAGE_SIZE, state.audit.length - visibleAudit),
              "older action",
            )}
          </button>
        </footer>}
      </section>
    </div>
  </div>;
}
