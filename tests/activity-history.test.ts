import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  ActivityHistory,
  HISTORY_PAGE_SIZE,
  activityChangeSummary,
  auditTargetSummary,
  createActivityActionGate,
  normalizeHistoryBatchCount,
} from "../src/client/activity-history";
import {
  applyCommand,
  createDemoState,
  createEnvelope,
  type ActivityRecord,
  type AuditEvent,
} from "../src/domain";

function activity(
  index: number,
  overrides: Partial<ActivityRecord> = {},
): ActivityRecord {
  return {
    actorId: "user_test",
    commandId: `command_${index}`,
    id: `activity_${index}`,
    label: `Change ${index}`,
    patches: [{
      after: `after_${index}`,
      before: `before_${index}`,
      id: "item_pasta",
      path: "notes",
      target: "item",
    }],
    status: "applied",
    subjectIds: ["item_pasta"],
    timestamp: `2026-07-22T12:${String(index).padStart(2, "0")}:00.000Z`,
    undoneAt: null,
    ...overrides,
  };
}

function audit(
  targetActivityIds: string[],
  overrides: Partial<AuditEvent> = {},
): AuditEvent {
  return {
    actorId: "user_test",
    id: "audit_test",
    label: "Undid 1 change",
    targetActivityIds,
    timestamp: "2026-07-22T13:00:00.000Z",
    type: "undo",
    ...overrides,
  };
}

describe("Activity history presentation", () => {
  it("summarizes meaningful fields without legacy bookkeeping", () => {
    const entry = activity(1, {
      patches: [
        {
          after: 7,
          before: 6,
          id: "item_pasta",
          path: "quantity",
          target: "item",
        },
        {
          after: "2026-07-22T12:01:00.000Z",
          before: "2026-07-22T12:00:00.000Z",
          id: "item_pasta",
          path: "updatedAt",
          target: "item",
        },
        {
          after: 2,
          before: 1,
          id: "item_pasta",
          path: "version",
          target: "item",
        },
        {
          after: "discarded",
          before: "active",
          id: "plan_test",
          path: "status",
          target: "plan",
        },
      ],
      subjectIds: ["item_pasta", "plan_test"],
    });

    expect(activityChangeSummary(entry)).toBe(
      "2 records · quantity, plan status",
    );
  });

  it("describes whole-record and retained-detail changes", () => {
    expect(activityChangeSummary(activity(1, {
      patches: [{
        after: undefined,
        before: { id: "item_pasta" },
        id: "item_pasta",
        path: "",
        target: "item",
      }],
    }))).toBe("1 record · item record");
    expect(activityChangeSummary(activity(2, { patches: [] })))
      .toBe("1 record · details no longer retained");
  });

  it("names retained audit targets and summarizes missing ones", () => {
    const activities = [activity(1), activity(2)];
    expect(auditTargetSummary(audit(["activity_2"]), activities))
      .toBe("Change 2");
    expect(auditTargetSummary(
      audit(["activity_1", "activity_missing", "activity_2"]),
      activities,
    )).toBe("Change 1; Change 2; 1 target no longer retained");
    expect(auditTargetSummary(audit([]), activities))
      .toBe("No target detail recorded");
    expect(auditTargetSummary(
      audit(["activity_1", "activity_2", "activity_3"]),
      [...activities, activity(3)],
    )).toBe("Change 1; Change 2; 1 more retained change");
  });

  it("renders changes and history actions newest first in both modes", () => {
    const state = createDemoState();
    state.activities = [activity(1), activity(2)];
    state.audit = [
      audit(["activity_1"], { id: "audit_first", label: "Undid first" }),
      audit(["activity_2"], { id: "audit_second", label: "Reapplied second" }),
    ];
    const readOnlyMarkup = renderToStaticMarkup(
      createElement(ActivityHistory, { state }),
    );
    const editableMarkup = renderToStaticMarkup(
      createElement(ActivityHistory, {
        onCommand: async () => true,
        state,
      }),
    );

    for (const markup of [readOnlyMarkup, editableMarkup]) {
      expect(markup.indexOf("Change 2")).toBeLessThan(markup.indexOf("Change 1"));
      expect(markup.indexOf("Reapplied second"))
        .toBeLessThan(markup.indexOf("Undid first"));
      expect(markup).toContain("Undo and reapply log");
    }
    expect(readOnlyMarkup).not.toContain("Undo this");
    expect(readOnlyMarkup).not.toContain("Batch history count");
    expect(editableMarkup).toContain("Undo this");
    expect(editableMarkup).toContain("Batch history count");
  });

  it("renders domain audit output with target labels", () => {
    let state = createDemoState();
    state.locations.find((location) => location.id === "loc_warm")!.captureStatus =
      "in_progress";
    const changed = applyCommand(
      state,
      createEnvelope(
        state,
        {
          type: "item.update",
          id: "item_pasta",
          changes: { quantity: 7 },
        },
        { id: "cmd_render_quantity" },
      ),
    );
    state = applyCommand(
      changed.state,
      createEnvelope(changed.state, {
        type: "history.undo",
        activityId: changed.activity!.id,
      }),
    ).state;

    const markup = renderToStaticMarkup(
      createElement(ActivityHistory, { state }),
    );
    expect(markup).toContain("Undid 1 change");
    expect(markup).toContain("Updated Pasta");
    expect(markup).toContain("quantity");
    expect(markup).toContain("undone");
  });

  it("bounds the initial activity page and offers older entries", () => {
    const state = createDemoState();
    state.activities = Array.from(
      { length: HISTORY_PAGE_SIZE + 1 },
      (_, index) => activity(index),
    );
    state.audit = Array.from(
      { length: HISTORY_PAGE_SIZE + 1 },
      (_, index) => audit([`activity_${index}`], {
        id: `audit_${index}`,
        label: `History action ${index}`,
      }),
    );

    const markup = renderToStaticMarkup(
      createElement(ActivityHistory, { state }),
    );
    expect(markup).toContain(`<strong>Change ${HISTORY_PAGE_SIZE}</strong>`);
    expect(markup).not.toContain("<strong>Change 0</strong>");
    expect(markup).toContain("Show 1 older change");
    expect(markup).toContain(`<strong>History action ${HISTORY_PAGE_SIZE}</strong>`);
    expect(markup).not.toContain("<strong>History action 0</strong>");
    expect(markup).toContain("Show 1 older action");
  });

  it("normalizes batch counts to supported positive integers", () => {
    expect(normalizeHistoryBatchCount(4.9)).toBe(4);
    expect(normalizeHistoryBatchCount("0")).toBe(1);
    expect(normalizeHistoryBatchCount("not a number")).toBe(1);
    expect(normalizeHistoryBatchCount("1000")).toBe(100);
  });

  it("drops duplicate actions while a history command is pending", async () => {
    const gate = createActivityActionGate();
    let release!: () => void;
    let calls = 0;
    const first = gate.run(async () => {
      calls += 1;
      await new Promise<void>((resolve) => {
        release = resolve;
      });
    });
    const duplicate = await gate.run(async () => {
      calls += 1;
    });

    expect(duplicate).toBe(false);
    expect(calls).toBe(1);
    release();
    await expect(first).resolves.toBe(true);
    await expect(gate.run(async () => {
      calls += 1;
    })).resolves.toBe(true);
    expect(calls).toBe(2);
    await expect(gate.run(async () => {
      throw new Error("History action failed");
    })).rejects.toThrow("History action failed");
    await expect(gate.run(async () => {
      calls += 1;
    })).resolves.toBe(true);
    expect(calls).toBe(3);
  });
});
