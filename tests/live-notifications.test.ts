import { afterEach, describe, expect, it } from "vitest";
import { D1SnapshotStore } from "../src/adapters/d1-snapshot-store";
import { createEmptyState } from "../src/domain/factories";
import {
  LIVE_RELAY_SIGNATURE_HEADER,
  LIVE_RELAY_TIMESTAMP_HEADER,
  loadLiveNotificationState,
  notifyWorkspaceChange,
  subscribeLocalLiveWorkspace,
} from "../src/server/live-notifications";
import {
  parseLiveNotification,
  verifyLiveRelayRequest,
  type LiveWireMessage,
} from "../src/shared/live-collaboration";
import {
  claimWorkspace,
  createOrLinkUser,
} from "../src/server/auth";
import { TEST_AUTH_ENV } from "./helpers/auth";
import { numberedMigrationDatabase } from "./helpers/sqlite-d1";

const SECRET = "test-live-relay-secret-with-at-least-32-bytes";

async function collaborationDatabase() {
  const { database, sqlite } = numberedMigrationDatabase();
  const state = createEmptyState("Live test workspace");
  const store = new D1SnapshotStore(database);
  await store.initialize(state);
  const owner = await createOrLinkUser(database, TEST_AUTH_ENV, {
    displayName: "Live owner",
    email: "live-owner@example.test",
    provider: "test",
    subject: "live-owner",
  });
  const editor = await createOrLinkUser(database, TEST_AUTH_ENV, {
    displayName: "Live editor",
    email: "live-editor@example.test",
    provider: "test",
    subject: "live-editor",
  });
  await claimWorkspace(database, owner.userId, state.workspace.id);
  sqlite.prepare(
    `INSERT INTO workspace_members(
       workspace_id, user_id, role, created_at
     ) VALUES(?, ?, 'editor', ?)`,
  ).run(state.workspace.id, editor.userId, new Date().toISOString());
  return { database, editor, owner, sqlite, state };
}

afterEach(() => {
  delete (globalThis as typeof globalThis & {
    __STOWPLAN_LOCAL_LIVE_HUB?: unknown;
  }).__STOWPLAN_LOCAL_LIVE_HUB;
});

describe("live notification boundary", () => {
  it("loads only active workspace members with authoritative revisions", async () => {
    const { database, editor, owner, sqlite, state } =
      await collaborationDatabase();
    const notification = await loadLiveNotificationState(
      database,
      state.workspace.id,
    );

    expect(notification).toEqual({
      accessRevision: 2,
      allowedUserIds: [editor.userId, owner.userId].sort(),
      revision: 0,
      workspaceId: state.workspace.id,
    });

    sqlite.prepare(
      "UPDATE users SET status = 'disabled' WHERE user_id = ?",
    ).run(editor.userId);
    expect((await loadLiveNotificationState(
      database,
      state.workspace.id,
    ))?.allowedUserIds).toEqual([owner.userId]);
  });

  it("does not publish when a sync leaves the revision unchanged", async () => {
    const { database, state } = await collaborationDatabase();
    let requests = 0;
    const result = await notifyWorkspaceChange(
      database,
      state.workspace.id,
      {
        environment: {
          LIVE_RELAY_SECRET: SECRET,
          LIVE_RELAY_URL: "https://relay.example",
        },
        fetcher: (async () => {
          requests += 1;
          return new Response(null, { status: 204 });
        }) as typeof fetch,
        previousRevision: state.workspace.revision,
      },
    );

    expect(result).toEqual({ status: "unchanged" });
    expect(requests).toBe(0);
  });

  it("signs a bounded authoritative publish for the relay", async () => {
    const { database, editor, owner, state } =
      await collaborationDatabase();
    let captured: Request | null = null;
    const result = await notifyWorkspaceChange(
      database,
      state.workspace.id,
      {
        environment: {
          LIVE_RELAY_SECRET: SECRET,
          LIVE_RELAY_URL: "https://relay.example",
        },
        fetcher: (async (input, init) => {
          captured = new Request(input, init);
          return new Response(null, { status: 204 });
        }) as typeof fetch,
        force: true,
        sourceConnectionId: "connection_owner",
      },
    );

    expect(result).toEqual({ status: "delivered" });
    expect(captured).not.toBeNull();
    const request = captured!;
    const body = await request.text();
    const timestamp = request.headers.get(LIVE_RELAY_TIMESTAMP_HEADER)!;
    await expect(verifyLiveRelayRequest(
      body,
      timestamp,
      request.headers.get(LIVE_RELAY_SIGNATURE_HEADER)!,
      SECRET,
      Number(timestamp),
    )).resolves.toBeUndefined();
    expect(parseLiveNotification(JSON.parse(body))).toMatchObject({
      allowedUserIds: [editor.userId, owner.userId].sort(),
      sourceConnectionId: "connection_owner",
      workspaceId: state.workspace.id,
    });
  });

  it("suppresses the source connection and disconnects removed members", async () => {
    const { database, editor, owner, sqlite, state } =
      await collaborationDatabase();
    const initial = await loadLiveNotificationState(
      database,
      state.workspace.id,
    );
    if (!initial) throw new Error("Expected live notification state");
    const ownerMessages: LiveWireMessage[] = [];
    const editorMessages: LiveWireMessage[] = [];
    let editorClosed = 0;
    const unsubscribeOwner = subscribeLocalLiveWorkspace({
      accessRevision: initial.accessRevision,
      connectionId: "connection_owner",
      userId: owner.userId,
      workspaceId: state.workspace.id,
    }, {
      close() {},
      send(message) {
        ownerMessages.push(message);
      },
    });
    const unsubscribeEditor = subscribeLocalLiveWorkspace({
      accessRevision: initial.accessRevision,
      connectionId: "connection_editor",
      userId: editor.userId,
      workspaceId: state.workspace.id,
    }, {
      close() {
        editorClosed += 1;
      },
      send(message) {
        editorMessages.push(message);
      },
    });

    await expect(notifyWorkspaceChange(database, state.workspace.id, {
      environment: { STOWPLAN_LIVE_LOCAL_ENABLED: "true" },
      force: true,
      sourceConnectionId: "connection_owner",
    })).resolves.toEqual({ status: "delivered" });
    expect(ownerMessages).toEqual([]);
    expect(editorMessages.map(message => message.type)).toEqual(["change"]);

    sqlite.prepare(
      "DELETE FROM workspace_members WHERE workspace_id = ? AND user_id = ?",
    ).run(state.workspace.id, editor.userId);
    await expect(notifyWorkspaceChange(database, state.workspace.id, {
      environment: { STOWPLAN_LIVE_LOCAL_ENABLED: "true" },
      force: true,
    })).resolves.toEqual({ status: "delivered" });

    expect(ownerMessages.map(message => message.type)).toEqual(["access"]);
    expect(editorMessages.map(message => message.type)).toEqual([
      "change",
      "access",
    ]);
    expect(editorClosed).toBe(1);
    unsubscribeOwner();
    unsubscribeEditor();
  });

  it("contains relay and database failures after the primary mutation", async () => {
    const { database, state } = await collaborationDatabase();
    await expect(notifyWorkspaceChange(database, state.workspace.id, {
      environment: {
        LIVE_RELAY_SECRET: SECRET,
        LIVE_RELAY_URL: "https://relay.example",
      },
      fetcher: (async () => {
        throw new Error("relay unavailable");
      }) as typeof fetch,
      force: true,
    })).resolves.toEqual({ status: "failed" });
  });
});
