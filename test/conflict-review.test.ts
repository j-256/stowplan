import { describe, expect, it } from "vitest";
import { applyCommand, createEmptyState, createEnvelope, createItem, createLocation, validateSnapshot } from "../src/domain";
import type { Command, WorkspaceState } from "../src/domain/types";
import type { LocalReplica } from "../src/client/local-replica";
import { projectRecoveryReview, recoveryFieldKey } from "../src/client/conflict-review";

const ITEM_ID = "item_review";
const LOCATION_ID = "loc_review";
const TIMESTAMP = "2026-09-13T00:00:00.000Z";

function fixture() {
  const state = createEmptyState("Home", TIMESTAMP);
  const location = createLocation({ name: "Pantry", code: "P" }, TIMESTAMP);
  location.id = LOCATION_ID;
  location.captureStatus = "in_progress";
  state.locations = [location];
  state.items = [{ ...createItem({ name: "Rice", locationId: LOCATION_ID, category: "Food" }, TIMESTAMP), id: ITEM_ID }];
  return state;
}

function queued(initial: WorkspaceState, commands: Command[]): LocalReplica {
  let state = initial;
  const outbox = commands.map((command, index) => {
    const envelope = createEnvelope(state, command, { id: `cmd_device_${index}`, timestamp: TIMESTAMP });
    state = applyCommand(state, envelope).state;
    return { envelope, status: "blocked" as const, error: "A newer edit conflicts" };
  });
  return { state, outbox, updatedAt: TIMESTAMP };
}

function online(state: WorkspaceState, command: Command) {
  return applyCommand(state, createEnvelope(state, command, { id: `cmd_online_${state.workspace.revision}`, timestamp: TIMESTAMP })).state;
}

describe("guided conflict review", () => {
  it("chooses individual fields while preserving unrelated online edits", () => {
    const initial = fixture();
    const replica = queued(initial, [{ type: "item.update", id: ITEM_ID, changes: { category: "Grains", frequency: "daily" } }]);
    const server = online(initial, { type: "item.update", id: ITEM_ID, changes: { category: "Staples", description: "Shared note" } });
    const review = projectRecoveryReview(replica, server, []);
    expect(review.next?.fields.find((field) => field.path === "category")).toMatchObject({ before: "Food", device: "Grains", server: "Staples", conflict: true });
    const result = projectRecoveryReview(replica, server, [{ commandId: "cmd_device_0", action: "apply", choices: { [recoveryFieldKey("item", ITEM_ID, "category")]: "server" } }]);
    expect(result.next).toBeNull();
    expect(result.state.items[0]).toMatchObject({ category: "Staples", frequency: "daily", description: "Shared note" });
    expect(result.outbox[0].envelope.command).toEqual({ type: "item.update", id: ITEM_ID, changes: { frequency: "daily" } });
    expect(replica.state.items[0].category).toBe("Grains");
  });

  it("requires an explicit choice and keeps fresh field expectations", () => {
    const initial = fixture();
    const replica = queued(initial, [{ type: "item.update", id: ITEM_ID, changes: { category: "Grains" } }]);
    const server = online(initial, { type: "item.update", id: ITEM_ID, changes: { category: "Staples" } });
    expect(() => projectRecoveryReview(replica, server, [{ commandId: "cmd_device_0", action: "apply" }])).toThrow(/Choose/);
    const result = projectRecoveryReview(replica, server, [{ commandId: "cmd_device_0", action: "apply", choices: { [recoveryFieldKey("item", ITEM_ID, "category")]: "device" } }]);
    expect(result.outbox[0].envelope.expectations).toContainEqual({ target: "item", id: ITEM_ID, path: "category", value: "Staples" });
    const newer = online(server, { type: "item.update", id: ITEM_ID, changes: { category: "Another edit" } });
    expect(() => applyCommand(newer, result.outbox[0].envelope)).toThrow(/conflicts/);
  });

  it("recognizes receipt-only accepted work and reviews dependencies in queue order", () => {
    const initial = fixture();
    const replica = queued(initial, [{ type: "workspace.rename", name: "First name" }, { type: "workspace.rename", name: "Final name" }]);
    const server = { ...initial, commandReceipts: ["cmd_device_0"], workspace: { ...initial.workspace, name: "First name", revision: 1 } };
    const review = projectRecoveryReview(replica, server, []);
    expect(review.acceptedCommandIds).toEqual(["cmd_device_0"]);
    expect(review.next?.entry.envelope.id).toBe("cmd_device_1");
    const result = projectRecoveryReview(replica, server, [{ commandId: "cmd_device_1", action: "apply" }]);
    expect(result.outbox).toHaveLength(1);
    expect(result.state.workspace.name).toBe("Final name");
    expect(() => projectRecoveryReview(replica, initial, [{ commandId: "cmd_device_1", action: "apply" }])).toThrow(/order/);
  });

  it("merges nested metadata by leaf and does not reapply unchanged device fields", () => {
    const initial = fixture();
    const replica = queued(initial, [{ type: "item.update", id: ITEM_ID, changes: { constraints: { ...initial.items[0].constraints, avoidWarmth: true, keepTogether: "Baking" } } }]);
    const server = online(initial, { type: "item.update", id: ITEM_ID, changes: { constraints: { ...initial.items[0].constraints, foodOnly: true, keepTogether: "Dinner" } } });
    const review = projectRecoveryReview(replica, server, []);
    expect(review.next?.fields.map((field) => field.path)).toEqual(["constraints.avoidWarmth", "constraints.keepTogether"]);
    const result = projectRecoveryReview(replica, server, [{ commandId: "cmd_device_0", action: "apply", choices: { [recoveryFieldKey("item", ITEM_ID, "constraints.keepTogether")]: "server" } }]);
    expect(result.state.items[0].constraints).toMatchObject({ avoidWarmth: true, foodOnly: true, keepTogether: "Dinner" });
    const undone = applyCommand(result.state, createEnvelope(result.state, { type: "history.undo", activityId: `activity_${result.outbox[0].envelope.id}` })).state;
    expect(undone.items[0].constraints).toEqual(server.items[0].constraints);
    expect(validateSnapshot(result.state).filter((issue) => issue.severity === "error")).toEqual([]);
  });

  it("lets each item in a bulk edit keep different fields", () => {
    const initial = fixture();
    initial.items.push({ ...createItem({ name: "Beans", locationId: LOCATION_ID, category: "Food" }, TIMESTAMP), id: "item_second" });
    const replica = queued(initial, [{ type: "item.bulkUpdate", updates: initial.items.map(({ id }) => ({ id, changes: { category: "Grains", constraints: { avoidWarmth: true, keepTogether: "Shelf" } } })) }]);
    const server = online(initial, { type: "item.bulkUpdate", updates: initial.items.map(({ id }) => ({ id, changes: { category: "Staples", constraints: { keepTogether: "Pantry", foodOnly: true } } })) });
    const result = projectRecoveryReview(replica, server, [{ commandId: "cmd_device_0", action: "apply", choices: {
      [recoveryFieldKey("item", ITEM_ID, "category")]: "device",
      [recoveryFieldKey("item", ITEM_ID, "constraints.keepTogether")]: "server",
      [recoveryFieldKey("item", "item_second", "category")]: "server",
      [recoveryFieldKey("item", "item_second", "constraints.keepTogether")]: "device",
    } }]);
    expect(result.state.items[0]).toMatchObject({ category: "Grains", constraints: { avoidWarmth: true, keepTogether: "Pantry", foodOnly: true } });
    expect(result.state.items[1]).toMatchObject({ category: "Staples", constraints: { avoidWarmth: true, keepTogether: "Shelf", foodOnly: true } });
    expect(result.outbox[0].envelope.expectations.filter((expectation) => expectation.path.startsWith("constraints."))).toHaveLength(3);
  });

  it("preserves independent online condition changes on a space", () => {
    const initial = fixture();
    const replica = queued(initial, [{ type: "location.update", id: LOCATION_ID, changes: { description: "Near the door", conditions: { ...initial.locations[0].conditions, dark: true } } }]);
    const server = online(initial, { type: "location.update", id: LOCATION_ID, changes: { conditions: { ...initial.locations[0].conditions, foodSafe: true } } });
    const result = projectRecoveryReview(replica, server, [{ commandId: "cmd_device_0", action: "apply" }]);
    expect(result.state.locations[0]).toMatchObject({ description: "Near the door", conditions: { dark: true, foodSafe: true } });
  });

  it("rechecks later edits after an earlier field is kept online", () => {
    const initial = fixture();
    const replica = queued(initial, [{ type: "workspace.rename", name: "Device first" }, { type: "workspace.rename", name: "Device final" }]);
    const server = online(initial, { type: "workspace.rename", name: "Online name" });
    const review = projectRecoveryReview(replica, server, [{ commandId: "cmd_device_0", action: "skip" }]);
    expect(review.next?.fields[0]).toMatchObject({ before: "Device first", device: "Device final", server: "Online name", conflict: true });
    expect(() => projectRecoveryReview(replica, server, [{ commandId: "cmd_device_0", action: "skip" }, { commandId: "cmd_device_1", action: "apply" }])).toThrow(/Choose/);
    const result = projectRecoveryReview(replica, server, [{ commandId: "cmd_device_0", action: "skip" }, { commandId: "cmd_device_1", action: "apply", choices: { [recoveryFieldKey("workspace", initial.workspace.id, "name")]: "device" } }]);
    expect(result.skippedCommandIds).toEqual(["cmd_device_0"]);
    expect(result.state.workspace.name).toBe("Device final");
  });

  it("requires explicit skips for missing records and broken dependencies", () => {
    const initial = fixture();
    const item = { ...initial.items[0], id: "item_created", name: "New item" };
    const replica = queued(initial, [{ type: "item.create", item }, { type: "item.update", id: item.id, changes: { name: "New name" } }]);
    const review = projectRecoveryReview(replica, initial, [{ commandId: "cmd_device_0", action: "skip" }]);
    expect(review.next?.fields[0].server).toBeUndefined();
    expect(() => projectRecoveryReview(replica, initial, [{ commandId: "cmd_device_0", action: "skip" }, { commandId: "cmd_device_1", action: "apply", choices: { [recoveryFieldKey("item", item.id, "name")]: "device" } }])).toThrow(/does not exist|not found/i);
    const result = projectRecoveryReview(replica, initial, [{ commandId: "cmd_device_0", action: "skip" }, { commandId: "cmd_device_1", action: "skip" }]);
    expect(result.outbox).toEqual([]);
    expect(result.skippedCommandIds).toEqual(["cmd_device_0", "cmd_device_1"]);
    expect(replica.outbox).toHaveLength(2);
  });

  it("keeps structural operations atomic and requires changed context confirmation", () => {
    const initial = fixture();
    const destination = createLocation({ name: "Other shelf", code: "O" }, TIMESTAMP);
    destination.captureStatus = "in_progress";
    initial.locations.push(destination);
    const replica = queued(initial, [{ type: "item.move", id: ITEM_ID, quantity: 1, destinationId: destination.id }]);
    const server = online(initial, { type: "item.update", id: ITEM_ID, changes: { description: "Collaborator note" } });
    expect(projectRecoveryReview(replica, server, []).next?.kind).toBe("command");
    expect(() => projectRecoveryReview(replica, server, [{ commandId: "cmd_device_0", action: "apply" }])).toThrow(/Confirm/);
    const result = projectRecoveryReview(replica, server, [{ commandId: "cmd_device_0", action: "apply", acceptContext: true }]);
    expect(result.state.items[0]).toMatchObject({ locationId: destination.id, description: "Collaborator note" });
  });

  it("does not retarget history commands to another person's newer activity", () => {
    const initial = fixture();
    const replica = queued(initial, [{ type: "workspace.rename", name: "Device name" }, { type: "history.batchUndo", count: 1 }]);
    const server = online(initial, { type: "item.update", id: ITEM_ID, changes: { category: "Staples" } });
    expect(() => projectRecoveryReview(replica, server, [{ commandId: "cmd_device_0", action: "apply" }, { commandId: "cmd_device_1", action: "apply" }])).toThrow(/Activity/);
    expect(server.items[0].category).toBe("Staples");
  });

  it("reports all-online choices without producing an empty change", () => {
    const initial = fixture();
    const replica = queued(initial, [{ type: "workspace.rename", name: "Device name" }]);
    const server = online(initial, { type: "workspace.rename", name: "Online name" });
    const result = projectRecoveryReview(replica, server, [{ commandId: "cmd_device_0", action: "apply", choices: { [recoveryFieldKey("workspace", initial.workspace.id, "name")]: "server" } }]);
    expect(result.state).toEqual(server);
    expect(result.outbox).toEqual([]);
    expect(result.skippedCommandIds).toEqual(["cmd_device_0"]);
  });

  it("rejects stale choice keys, duplicate entries, and another workspace", () => {
    const initial = fixture();
    const replica = queued(initial, [{ type: "workspace.rename", name: "Device name" }]);
    expect(() => projectRecoveryReview(replica, initial, [{ commandId: "cmd_device_0", action: "apply", choices: { stale: "device" } }])).toThrow(/no longer match/);
    expect(() => projectRecoveryReview(replica, createEmptyState(), [])).toThrow(/different workspaces/);
    expect(() => projectRecoveryReview({ ...replica, outbox: [...replica.outbox, ...replica.outbox] }, initial, [{ commandId: "cmd_device_0", action: "apply" }])).toThrow(/inconsistent identifiers/);
  });
});
