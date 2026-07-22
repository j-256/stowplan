import "fake-indexeddb/auto";
import { beforeEach, describe, expect, it } from "vitest";
import { applyCommand } from "../src/domain/commands";
import { createEmptyState, createEnvelope } from "../src/domain/factories";
import { clearReplica, listWorkspaceReplicas, readReplica, readWorkspaceReplica, reconcileReplica, replaceReplica, writeReplica } from "../src/client/local-replica";

describe("local replica", () => {
  beforeEach(async () => clearReplica());
  it("atomically preserves the workspace and durable outbox", async () => {
    const state = createEmptyState("Offline home", "2026-07-22T00:00:00.000Z");
    await writeReplica({ state, outbox: [], updatedAt: state.workspace.updatedAt });
    expect((await readReplica())?.state.workspace.name).toBe("Offline home");
    expect((await readWorkspaceReplica(state.workspace.id))?.state.workspace.name).toBe("Offline home");
  });
  it("keeps inactive local workspaces available for switching",async()=>{const first=createEmptyState("First"),second=createEmptyState("Second");await writeReplica({state:first,outbox:[],updatedAt:"2026-07-22T00:00:00.000Z"});await writeReplica({state:second,outbox:[],updatedAt:"2026-07-22T01:00:00.000Z"});expect((await readReplica())?.state.workspace.id).toBe(second.workspace.id);expect((await readWorkspaceReplica(first.workspace.id))?.state.workspace.name).toBe("First");expect((await listWorkspaceReplicas()).map(workspace=>workspace.name)).toEqual(["Second","First"])});
  it("resets only the active workspace and preserves every other local workspace", async () => {
    const personal = createEmptyState("Personal");
    const demo = createEmptyState("Kitchen demo");
    await writeReplica({ state: personal, outbox: [], updatedAt: "2026-07-22T00:00:00.000Z" });
    await writeReplica({ state: demo, outbox: [], updatedAt: "2026-07-22T01:00:00.000Z" });
    const freshDemo = createEmptyState("Fresh kitchen demo");
    await replaceReplica({ state: freshDemo, outbox: [], updatedAt: "2026-07-22T02:00:00.000Z" }, demo.workspace.id);
    expect((await readReplica())?.state.workspace.id).toBe(freshDemo.workspace.id);
    expect(await readWorkspaceReplica(demo.workspace.id)).toBeNull();
    expect((await readWorkspaceReplica(personal.workspace.id))?.state.workspace.name).toBe("Personal");
  });
  it("does not erase a command queued while an earlier batch is in flight",()=>{const initial=createEmptyState("Initial"),first=createEnvelope(initial,{type:"workspace.rename",name:"Server accepted"}),afterFirst=applyCommand(initial,first).state,second=createEnvelope(afterFirst,{type:"workspace.rename",name:"Queued later"}),latest={state:applyCommand(afterFirst,second).state,outbox:[{envelope:first,status:"pending" as const},{envelope:second,status:"pending" as const}],updatedAt:"now"};const reconciled=reconcileReplica(latest,[latest.outbox[0]],afterFirst,[{commandId:first.id,revision:afterFirst.workspace.revision,status:"applied"}]);expect(reconciled.state.workspace.name).toBe("Queued later");expect(reconciled.outbox.map(entry=>entry.envelope.id)).toEqual([second.id])});
  it("keeps rejected local work visible and marks it blocked",()=>{const initial=createEmptyState("Initial"),command=createEnvelope(initial,{type:"workspace.rename",name:"Local edit"}),latest={state:applyCommand(initial,command).state,outbox:[{envelope:command,status:"pending" as const}],updatedAt:"now"};const reconciled=reconcileReplica(latest,latest.outbox,initial,[{commandId:command.id,revision:initial.workspace.revision,status:"rejected",message:"Same field changed remotely"}]);expect(reconciled.state.workspace.name).toBe("Local edit");expect(reconciled.outbox[0]).toMatchObject({status:"blocked",error:"Same field changed remotely"})});
});
