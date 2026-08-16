import { afterEach, describe, expect, it } from "vitest";
import { GET as getLiveCapability } from "../app/api/live/capability/route";
import { GET as getLiveEvents } from "../app/api/live/events/route";
import { DELETE as deleteWorkspaceMember } from "../app/api/workspaces/[workspaceId]/members/[userId]/route";
import { D1SnapshotStore } from "../src/adapters/d1-snapshot-store";
import { createEmptyState } from "../src/domain/factories";
import {
  claimWorkspace,
  createOrLinkUser,
  issueSession,
} from "../src/server/auth";
import {
  notifyWorkspaceChange,
} from "../src/server/live-notifications";
import type { RuntimeEnv } from "../src/server/runtime";
import {
  LIVE_AUTH_SUBPROTOCOL_PREFIX,
  LIVE_SUBPROTOCOL,
  verifyLiveCapability,
} from "../src/shared/live-collaboration";
import { ACCOUNT_CONTEXT_HEADER } from "../src/shared/account-context";
import { TEST_AUTH_ENV } from "./helpers/auth";
import { numberedMigrationDatabase } from "./helpers/sqlite-d1";

const RELAY_SECRET =
  "test-live-route-secret-containing-at-least-32-bytes";
const runtimeGlobal = globalThis as typeof globalThis & {
  __STOWPLAN_ENV?: RuntimeEnv;
  __STOWPLAN_LOCAL_LIVE_HUB?: unknown;
};

afterEach(() => {
  delete runtimeGlobal.__STOWPLAN_ENV;
  delete runtimeGlobal.__STOWPLAN_LOCAL_LIVE_HUB;
});

async function liveRouteFixture(environment: Partial<RuntimeEnv>) {
  const { database, sqlite } = numberedMigrationDatabase();
  runtimeGlobal.__STOWPLAN_ENV = {
    ...TEST_AUTH_ENV,
    AUTH_BASE_URL: "https://stowplan.test",
    DB: database,
    ...environment,
  };
  const owner = await createOrLinkUser(database, TEST_AUTH_ENV, {
    displayName: "Live route owner",
    email: "live-route-owner@example.test",
    provider: "test",
    subject: "live-route-owner",
  });
  const state = createEmptyState(
    "Live route workspace",
    "2026-08-16T00:00:00.000Z",
  );
  await new D1SnapshotStore(database).initialize(state);
  await claimWorkspace(database, owner.userId, state.workspace.id);
  const session = await issueSession(
    database,
    runtimeGlobal.__STOWPLAN_ENV,
    owner,
    new Request("https://stowplan.test/sign-in"),
  );
  return {
    accountId: owner.userId,
    cookie: `__Host-stowplan_session=${session.raw}`,
    database,
    sqlite,
    state,
  };
}

function liveRequest(
  path: string,
  fixture: Awaited<ReturnType<typeof liveRouteFixture>>,
  accountId = fixture.accountId,
): Request {
  return new Request(`https://stowplan.test${path}`, {
    headers: {
      [ACCOUNT_CONTEXT_HEADER]: accountId,
      cookie: fixture.cookie,
    },
  });
}

async function nextEvent(
  reader: ReadableStreamDefaultReader<Uint8Array>,
): Promise<string> {
  const result = await Promise.race([
    reader.read(),
    new Promise<never>((_, reject) => {
      setTimeout(() => reject(new Error("Timed out waiting for live event")), 500);
    }),
  ]);
  if (result.done) throw new Error("Live event stream ended unexpectedly");
  return new TextDecoder().decode(result.value);
}

describe("live collaboration routes", () => {
  it("issues a short-lived origin-bound WebSocket capability", async () => {
    const fixture = await liveRouteFixture({
      LIVE_RELAY_SECRET: RELAY_SECRET,
      LIVE_RELAY_URL: "https://relay.example.test",
    });
    const response = await getLiveCapability(liveRequest(
      `/api/live/capability?workspaceId=${fixture.state.workspace.id}` +
        "&connectionId=connection_owner",
      fixture,
    ));

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get(ACCOUNT_CONTEXT_HEADER)).toBe(
      fixture.accountId,
    );
    const capability = await response.json() as {
      accessRevision: number;
      endpoint: string;
      protocols: string[];
      revision: number;
      transport: string;
    };
    expect(capability).toMatchObject({
      accessRevision: 1,
      endpoint: "wss://relay.example.test/v1/connect",
      revision: 0,
      transport: "websocket",
    });
    expect(capability.protocols[0]).toBe(LIVE_SUBPROTOCOL);
    expect(capability.protocols[1]).toMatch(
      new RegExp(`^${LIVE_AUTH_SUBPROTOCOL_PREFIX}`),
    );
    await expect(verifyLiveCapability(
      capability.protocols[1]!.slice(LIVE_AUTH_SUBPROTOCOL_PREFIX.length),
      RELAY_SECRET,
      { origin: "https://stowplan.test" },
    )).resolves.toMatchObject({
      connectionId: "connection_owner",
      userId: fixture.accountId,
      workspaceId: fixture.state.workspace.id,
    });
  });

  it("streams local live events without recurring requests", async () => {
    const fixture = await liveRouteFixture({
      STOWPLAN_LIVE_LOCAL_ENABLED: "true",
    });
    const query = `workspaceId=${fixture.state.workspace.id}` +
      "&connectionId=connection_owner";
    const capability = await getLiveCapability(liveRequest(
      `/api/live/capability?${query}`,
      fixture,
    ));
    const capabilityBody = await capability.json() as {
      endpoint: string;
      transport: string;
    };
    expect(capabilityBody).toMatchObject({
      transport: "sse",
    });
    const endpoint = new URL(
      capabilityBody.endpoint,
      "https://stowplan.test",
    );
    expect(Object.fromEntries(endpoint.searchParams)).toEqual({
      connectionId: "connection_owner",
      workspaceId: fixture.state.workspace.id,
    });

    const response = await getLiveEvents(liveRequest(
      `/api/live/events?${query}`,
      fixture,
    ));
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain(
      "text/event-stream",
    );
    const reader = response.body!.getReader();
    expect(await nextEvent(reader)).toContain('"type":"ready"');

    await notifyWorkspaceChange(
      fixture.database,
      fixture.state.workspace.id,
      {
        environment: { STOWPLAN_LIVE_LOCAL_ENABLED: "true" },
        force: true,
        sourceConnectionId: "connection_other",
      },
    );
    expect(await nextEvent(reader)).toContain('"type":"change"');
    await reader.cancel();
  });

  it("rejects stale account context before revealing membership", async () => {
    const fixture = await liveRouteFixture({
      STOWPLAN_LIVE_LOCAL_ENABLED: "true",
    });
    const response = await getLiveCapability(liveRequest(
      `/api/live/capability?workspaceId=${fixture.state.workspace.id}` +
        "&connectionId=connection_owner",
      fixture,
      "usr_other",
    ));

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      code: "ACCOUNT_CONTEXT_CHANGED",
    });
  });

  it("disconnects a member immediately after access is revoked", async () => {
    const fixture = await liveRouteFixture({
      STOWPLAN_LIVE_LOCAL_ENABLED: "true",
    });
    const editor = await createOrLinkUser(
      fixture.database,
      TEST_AUTH_ENV,
      {
        displayName: "Live route editor",
        email: "live-route-editor@example.test",
        provider: "test",
        subject: "live-route-editor",
      },
    );
    await fixture.database.prepare(
      `INSERT INTO workspace_members(workspace_id,user_id,role,created_at)
       VALUES(?,?,'editor',?)`,
    ).bind(
      fixture.state.workspace.id,
      editor.userId,
      "2026-08-16T01:00:00.000Z",
    ).run();
    const editorSession = await issueSession(
      fixture.database,
      runtimeGlobal.__STOWPLAN_ENV!,
      editor,
      new Request("https://stowplan.test/sign-in"),
    );
    const query = `workspaceId=${fixture.state.workspace.id}` +
      "&connectionId=connection_editor";
    const response = await getLiveEvents(new Request(
      `https://stowplan.test/api/live/events?${query}`,
      {
        headers: {
          [ACCOUNT_CONTEXT_HEADER]: editor.userId,
          cookie: `__Host-stowplan_session=${editorSession.raw}`,
        },
      },
    ));
    const reader = response.body!.getReader();
    expect(await nextEvent(reader)).toContain('"type":"ready"');
    const revisions = fixture.sqlite.prepare(
      `SELECT snapshot.access_revision, account.membership_revision
       FROM workspace_snapshots snapshot
       JOIN users account ON account.user_id=?
       WHERE snapshot.workspace_id=?`,
    ).get(editor.userId, fixture.state.workspace.id) as {
      access_revision: number;
      membership_revision: number;
    };
    const revoked = await deleteWorkspaceMember(new Request(
      `https://stowplan.test/api/workspaces/${fixture.state.workspace.id}` +
        `/members/${editor.userId}`,
      {
        body: JSON.stringify({
          expectedAccessRevision: revisions.access_revision,
          expectedMembershipRevision: revisions.membership_revision,
        }),
        headers: {
          "content-type": "application/json",
          [ACCOUNT_CONTEXT_HEADER]: fixture.accountId,
          cookie: fixture.cookie,
        },
        method: "DELETE",
      },
    ), {
      params: Promise.resolve({
        userId: editor.userId,
        workspaceId: fixture.state.workspace.id,
      }),
    });

    expect(revoked.status).toBe(200);
    expect(await nextEvent(reader)).toContain('"type":"access"');
    await reader.cancel();
  });
});
