import { afterEach, describe, expect, it } from "vitest";
import {
  DELETE as deleteAdminWorkspace,
  POST as postAdminWorkspace,
} from "../app/api/admin/workspaces/[workspaceId]/route";
import { D1SnapshotStore } from "../src/adapters/d1-snapshot-store";
import {
  createEmptyState,
  createItem,
  createLocation,
} from "../src/domain/factories";
import {
  claimWorkspace,
  createOrLinkUser,
  issueSession,
} from "../src/server/auth";
import type { RuntimeEnv } from "../src/server/runtime";
import { WORKSPACE_ACCESS_REQUEST_MAX_BYTES } from "../src/server/request-body";
import { ACCOUNT_CONTEXT_HEADER } from "../src/shared/account-context";
import { TEST_AUTH_ENV } from "./helpers/auth";
import { numberedMigrationDatabase } from "./helpers/sqlite-d1";

const runtimeGlobal = globalThis as typeof globalThis & {
  __STOWPLAN_ENV?: RuntimeEnv;
};

afterEach(() => {
  delete runtimeGlobal.__STOWPLAN_ENV;
});

async function routeFixture() {
  const { database, sqlite } = numberedMigrationDatabase();
  const env: RuntimeEnv = {
    ...TEST_AUTH_ENV,
    AUTH_BASE_URL: "https://stowplan.test",
    DB: database,
  };
  runtimeGlobal.__STOWPLAN_ENV = env;
  const admin = await createOrLinkUser(
    database,
    env,
    {
      displayName: "Route administrator",
      email: "route-admin@example.test",
      provider: "test",
      subject: "route-admin",
    },
  );
  await database.prepare(
    `UPDATE users
     SET global_role='admin'
     WHERE user_id=?`,
  ).bind(admin.userId).run();
  const owner = await createOrLinkUser(database, env, {
    displayName: "Route workspace owner",
    email: "route-workspace-owner@example.test",
    provider: "test",
    subject: "route-workspace-owner",
  });
  const regular = await createOrLinkUser(database, env, {
    displayName: "Route regular user",
    email: "route-regular@example.test",
    provider: "test",
    subject: "route-regular",
  });
  const state = createEmptyState(
    "Route inspected workspace",
    "2026-07-25T00:00:00.000Z",
  );
  const location = createLocation({
    code: "ROUTE",
    name: "Route private location",
  });
  const item = createItem({
    locationId: location.id,
    name: "Route private item",
  });
  item.description = "Visible to the audited global control plane";
  state.locations.push(location);
  state.items.push(item);
  await new D1SnapshotStore(database).initialize(state);
  await claimWorkspace(database, owner.userId, state.workspace.id);
  const adminSession = await issueSession(
    database,
    env,
    admin,
    new Request("https://stowplan.test/sign-in"),
  );
  const regularSession = await issueSession(
    database,
    env,
    regular,
    new Request("https://stowplan.test/sign-in"),
  );
  return {
    admin,
    adminCookie: `__Host-stowplan_session=${adminSession.raw}`,
    database,
    item,
    regular,
    regularCookie: `__Host-stowplan_session=${regularSession.raw}`,
    sqlite,
    state,
  };
}

function routeParams(workspaceId: string) {
  return { params: Promise.resolve({ workspaceId }) };
}

function jsonRequest(
  path: string,
  cookie: string,
  accountId: string,
  method: "DELETE" | "POST",
  body: unknown,
  headers: HeadersInit = {},
) {
  return new Request(`https://stowplan.test${path}`, {
    body: JSON.stringify(body),
    headers: {
      "content-type": "application/json",
      [ACCOUNT_CONTEXT_HEADER]: accountId,
      cookie,
      origin: "https://stowplan.test",
      ...headers,
    },
    method,
  });
}

describe("global admin workspace routes", () => {
  it("returns full content to an unjoined admin and audits the inspection", async () => {
    const fixture = await routeFixture();
    const response = await postAdminWorkspace(
      jsonRequest(
        `/api/admin/workspaces/${fixture.state.workspace.id}`,
        fixture.adminCookie,
        fixture.admin.userId,
        "POST",
        { action: "inspect" },
      ),
      routeParams(fixture.state.workspace.id),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get(ACCOUNT_CONTEXT_HEADER)).toBe(
      fixture.admin.userId,
    );
    await expect(response.json()).resolves.toMatchObject({
      operatorRole: null,
      state: {
        items: [{
          name: fixture.item.name,
          description: fixture.item.description,
        }],
      },
      workspaceId: fixture.state.workspace.id,
    });
    expect(fixture.sqlite.prepare(
      `SELECT COUNT(*) AS count
       FROM auth_audit_events
       WHERE action='workspace.inspect' AND target_id=?`,
    ).get(fixture.state.workspace.id)).toEqual({ count: 1 });
  });

  it("does not expose content to a forged non-admin request", async () => {
    const fixture = await routeFixture();
    const response = await postAdminWorkspace(
      jsonRequest(
        `/api/admin/workspaces/${fixture.state.workspace.id}`,
        fixture.regularCookie,
        fixture.regular.userId,
        "POST",
        { action: "inspect" },
      ),
      routeParams(fixture.state.workspace.id),
    );

    expect(response.status).toBe(403);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const body = await response.json();
    expect(body).toMatchObject({
      code: "ADMIN_REQUIRED",
    });
    expect(JSON.stringify(body)).not.toContain(fixture.item.name);
  });

  it("takes custody and then performs guarded server deletion", async () => {
    const fixture = await routeFixture();
    const before = fixture.sqlite.prepare(
      `SELECT revision,access_revision
       FROM workspace_snapshots
       WHERE workspace_id=?`,
    ).get(fixture.state.workspace.id) as {
      access_revision: number;
      revision: number;
    };
    const path =
      `/api/admin/workspaces/${fixture.state.workspace.id}`;
    const custody = await postAdminWorkspace(
      jsonRequest(
        path,
        fixture.adminCookie,
        fixture.admin.userId,
        "POST",
        {
          action: "takeOwnership",
          expectedAccessRevision: before.access_revision,
        },
      ),
      routeParams(fixture.state.workspace.id),
    );
    expect(custody.status).toBe(200);
    const custodyBody = await custody.json() as {
      accessRevision: number;
    };
    expect(custodyBody.accessRevision).toBe(
      before.access_revision + 1,
    );

    const deletion = await deleteAdminWorkspace(
      jsonRequest(
        path,
        fixture.adminCookie,
        fixture.admin.userId,
        "DELETE",
        {
          confirmationName: fixture.state.workspace.name,
          expectedAccessRevision: custodyBody.accessRevision,
          expectedRevision: before.revision,
        },
      ),
      routeParams(fixture.state.workspace.id),
    );
    expect(deletion.status).toBe(200);
    expect(deletion.headers.get("cache-control")).toBe("no-store");
    await expect(deletion.json()).resolves.toMatchObject({
      deleted: true,
      recovery: "not_available",
      workspaceId: fixture.state.workspace.id,
    });
    expect(fixture.sqlite.prepare(
      `SELECT COUNT(*) AS count
       FROM workspace_deletions
       WHERE workspace_id=?`,
    ).get(fixture.state.workspace.id)).toEqual({ count: 1 });
  });

  it("origin-protects and bounds global workspace mutations", async () => {
    const fixture = await routeFixture();
    const path =
      `/api/admin/workspaces/${fixture.state.workspace.id}`;
    const crossOriginInspection = await postAdminWorkspace(
      jsonRequest(
        path,
        fixture.adminCookie,
        fixture.admin.userId,
        "POST",
        { action: "inspect" },
        { origin: "https://evil.test" },
      ),
      routeParams(fixture.state.workspace.id),
    );
    expect(crossOriginInspection.status).toBe(403);
    expect(fixture.sqlite.prepare(
      `SELECT COUNT(*) AS count
       FROM auth_audit_events
       WHERE action='workspace.inspect'`,
    ).get()).toEqual({ count: 0 });
    const crossOrigin = await deleteAdminWorkspace(
      jsonRequest(
        path,
        fixture.adminCookie,
        fixture.admin.userId,
        "DELETE",
        {},
        { origin: "https://evil.test" },
      ),
      routeParams(fixture.state.workspace.id),
    );
    expect(crossOrigin.status).toBe(403);
    await expect(crossOrigin.json()).resolves.toMatchObject({
      code: "CROSS_ORIGIN_DENIED",
    });

    const oversized = await deleteAdminWorkspace(
      new Request(`https://stowplan.test${path}`, {
        body: "{}",
        headers: {
          "content-length": String(
            WORKSPACE_ACCESS_REQUEST_MAX_BYTES + 1,
          ),
          "content-type": "application/json",
          [ACCOUNT_CONTEXT_HEADER]: fixture.admin.userId,
          cookie: fixture.adminCookie,
          origin: "https://stowplan.test",
        },
        method: "DELETE",
      }),
      routeParams(fixture.state.workspace.id),
    );
    expect(oversized.status).toBe(413);
    await expect(oversized.json()).resolves.toMatchObject({
      code: "BODY_TOO_LARGE",
    });
    expect(fixture.sqlite.prepare(
      `SELECT COUNT(*) AS count
       FROM workspace_snapshots
       WHERE workspace_id=?`,
    ).get(fixture.state.workspace.id)).toEqual({ count: 1 });
  });
});
