import { describe, expect, it } from "vitest";
import {
  applyCommand,
  createEmptyState,
  createEnvelope,
} from "../src/domain";
import {
  capabilitiesForWorkspaceRole,
  serverWorkspaceAccess,
  type ServerWorkspaceSummary,
  type WorkspaceRole,
} from "../src/domain/workspace-access";
import {
  applyRefusedSyncResponse,
  applySuccessfulSyncResponse,
  inaccessibleWorkspaceAccess,
} from "../src/client/sync-reconciliation";
import type {
  LocalReplica,
  OutboxEntry,
} from "../src/client/local-replica";

function summary(
  state: ReturnType<typeof createEmptyState>,
  role: WorkspaceRole,
  accessRevision: number,
  membershipRevision: number,
): ServerWorkspaceSummary {
  return {
    accessRevision,
    capabilities: capabilitiesForWorkspaceRole(role, true),
    id: state.workspace.id,
    membershipRevision,
    name: state.workspace.name,
    revision: state.workspace.revision,
    role,
    updatedAt: "2026-07-25T00:00:00.000Z",
  };
}

function editedReplica(): {
  first: OutboxEntry;
  initial: ReturnType<typeof createEmptyState>;
  replica: LocalReplica;
  second: OutboxEntry;
} {
  const initial = createEmptyState(
    "Initial",
    "2026-07-25T00:00:00.000Z",
  );
  const firstEnvelope = createEnvelope(
    initial,
    { type: "workspace.rename", name: "First local name" },
    {
      authorization: {
        membershipRevision: 4,
        workspaceAccessRevision: 2,
      },
      id: "cmd_first",
    },
  );
  const afterFirst = applyCommand(initial, firstEnvelope).state;
  const secondEnvelope = createEnvelope(
    afterFirst,
    { type: "workspace.rename", name: "Second local name" },
    {
      authorization: {
        membershipRevision: 5,
        workspaceAccessRevision: 3,
      },
      id: "cmd_second",
    },
  );
  const afterSecond = applyCommand(afterFirst, secondEnvelope).state;
  const first = {
    envelope: firstEnvelope,
    status: "pending" as const,
  };
  const second = {
    envelope: secondEnvelope,
    status: "pending" as const,
  };
  return {
    first,
    initial,
    replica: {
      authorization: serverWorkspaceAccess("editor", {
        accessRevision: 2,
        membershipRevision: 4,
      }),
      lastSyncAttemptAt: null,
      lastSyncError: null,
      lastSyncedAt: null,
      outbox: [first, second],
      serverSummary: summary(initial, "editor", 2, 4),
      state: afterSecond,
      updatedAt: "2026-07-25T00:02:00.000Z",
    },
    second,
  };
}

describe("client sync reconciliation", () => {
  it("keeps rejected edits with action and refusal context after downgrade", () => {
    const { first, replica, second } = editedReplica();
    const authorization = serverWorkspaceAccess("viewer", {
      accessRevision: 3,
      membershipRevision: 5,
    });

    const next = applyRefusedSyncResponse(
      replica,
      [first],
      [{
        commandId: first.envelope.id,
        message: "Viewer access does not allow workspace changes",
        revision: 0,
        status: "rejected",
      }],
      "Viewer access does not allow workspace changes",
      "2026-07-25T00:03:00.000Z",
      true,
      {
        authorization,
        summary: summary(replica.state, "viewer", 3, 5),
      },
    );

    expect(next.authorization).toMatchObject({
      role: "viewer",
      status: "active",
    });
    expect(next.state.workspace.name).toBe("Second local name");
    expect(next.outbox).toEqual([
      expect.objectContaining({
        error: expect.stringMatching(
          /Renamed workspace to First local name: Viewer access/,
        ),
        status: "blocked",
      }),
      second,
    ]);
  });

  it("does not regress newer cross-tab authorization or server metadata", () => {
    const { first, replica } = editedReplica();
    replica.authorization = serverWorkspaceAccess("viewer", {
      accessRevision: 8,
      membershipRevision: 10,
    });
    replica.serverSummary = summary(replica.state, "viewer", 8, 10);

    const next = applyRefusedSyncResponse(
      replica,
      [first],
      [],
      "Temporary refusal",
      "2026-07-25T00:03:00.000Z",
      false,
      {
        authorization: serverWorkspaceAccess("editor", {
          accessRevision: 7,
          membershipRevision: 9,
        }),
        summary: summary(replica.state, "editor", 7, 9),
      },
    );

    expect(next.authorization).toMatchObject({
      accessRevision: 8,
      membershipRevision: 10,
      role: "viewer",
    });
    expect(next.serverSummary).toMatchObject({
      accessRevision: 8,
      role: "viewer",
    });
    expect(next.outbox[0]?.status).toBe("pending");
  });

  it("fails closed without lowering revision floors after an inaccessible response", () => {
    const { first, replica } = editedReplica();
    const scopedFirst = { ...first, accountId: "usr_editor" };
    const scopedReplica = {
      ...replica,
      authorization: serverWorkspaceAccess("editor", {
        accessRevision: 2,
        accountId: "usr_editor",
        membershipRevision: 4,
      }),
      outbox: [
        scopedFirst,
        { ...replica.outbox[1]!, accountId: "usr_editor" },
      ],
    };
    const authorization = inaccessibleWorkspaceAccess(
      scopedReplica.authorization,
      "usr_editor",
      "2026-07-25T00:03:00.000Z",
    );

    const next = applyRefusedSyncResponse(
      scopedReplica,
      [scopedFirst],
      [],
      "Workspace was not found or is inaccessible",
      "2026-07-25T00:03:00.000Z",
      true,
      { authorization, summary: null },
    );

    expect(next.authorization).toMatchObject({
      accessRevision: 2,
      accountId: "usr_editor",
      membershipRevision: 4,
      role: null,
      status: "unknown",
    });
    expect(next.authorization?.capabilities.write).toBe(false);
    expect(next.state.workspace.name).toBe("Second local name");
    expect(next.outbox[0]).toMatchObject({
      error: expect.stringContaining(
        "Workspace was not found or is inaccessible",
      ),
      status: "blocked",
    });
  });

  it("commits canonical server state and authorization after success", () => {
    const { first, initial, replica } = editedReplica();
    const serverState = applyCommand(initial, first.envelope).state;
    const authorization = serverWorkspaceAccess("editor", {
      accessRevision: 2,
      checkedAt: "2026-07-25T00:04:00.000Z",
      membershipRevision: 4,
    });

    const next = applySuccessfulSyncResponse(
      {
        ...replica,
        outbox: [first],
        state: serverState,
      },
      [first],
      serverState,
      [{
        commandId: first.envelope.id,
        revision: serverState.workspace.revision,
        status: "applied",
      }],
      "2026-07-25T00:04:00.000Z",
      {
        authorization,
        summary: summary(serverState, "editor", 2, 4),
      },
    );

    expect(next.outbox).toEqual([]);
    expect(next.state.workspace.name).toBe("First local name");
    expect(next.lastSyncedAt).toBe("2026-07-25T00:04:00.000Z");
    expect(next.authorization).toEqual(authorization);
  });
});
