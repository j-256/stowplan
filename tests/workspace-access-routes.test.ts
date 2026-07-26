import { afterEach, describe, expect, it } from "vitest";
import { GET as getWorkspaces } from "../app/api/workspaces/route";
import { DELETE as deleteWorkspace } from "../app/api/workspaces/[workspaceId]/route";
import {
  GET as getGuestLinks,
  POST as postGuestLink,
} from "../app/api/workspaces/[workspaceId]/guest-links/route";
import { PATCH as patchMember } from "../app/api/workspaces/[workspaceId]/members/[userId]/route";
import { D1SnapshotStore } from "../src/adapters/d1-snapshot-store";
import {
  GUEST_INVITATION_RETURN_TO_MAX_CHARACTERS,
} from "../src/domain/app-url";
import { createEmptyState } from "../src/domain/factories";
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
  runtimeGlobal.__STOWPLAN_ENV = {
    ...TEST_AUTH_ENV,
    AUTH_BASE_URL: "https://stowplan.test",
    DB: database,
  };
  const owner = await createOrLinkUser(database, TEST_AUTH_ENV, {
    displayName: "Route owner",
    email: "route-owner@example.test",
    provider: "test",
    subject: "route-owner",
  });
  const state = createEmptyState(
    "Route workspace",
    "2026-07-25T00:00:00.000Z",
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
    cookie: `__Host-stowplan_session=${session.raw}`,
    database,
    owner,
    sqlite,
    state,
  };
}

function jsonRequest(
  path: string,
  cookie: string,
  accountId: string,
  method: string,
  body: unknown,
  headers: HeadersInit = {},
) {
  return new Request(`https://stowplan.test${path}`, {
    body: JSON.stringify(body),
    headers: {
      "content-type": "application/json",
      [ACCOUNT_CONTEXT_HEADER]: accountId,
      cookie,
      ...headers,
    },
    method,
  });
}

describe("workspace access routes", () => {
  it("returns a private member-scoped catalog and structured authentication error", async () => {
    const fixture = await routeFixture();
    const authenticated = await getWorkspaces(new Request(
      "https://stowplan.test/api/workspaces",
      {
        headers: {
          [ACCOUNT_CONTEXT_HEADER]: fixture.owner.userId,
          cookie: fixture.cookie,
        },
      },
    ));

    expect(authenticated.status).toBe(200);
    expect(authenticated.headers.get("cache-control")).toBe("no-store");
    expect(authenticated.headers.get(ACCOUNT_CONTEXT_HEADER)).toBe(
      fixture.owner.userId,
    );
    await expect(authenticated.json()).resolves.toMatchObject({
      workspaces: [{
        id: fixture.state.workspace.id,
        name: "Route workspace",
        role: "owner",
      }],
    });

    const anonymous = await getWorkspaces(new Request(
      "https://stowplan.test/api/workspaces",
    ));
    expect(anonymous.status).toBe(401);
    expect(anonymous.headers.get("cache-control")).toBe("no-store");
    await expect(anonymous.json()).resolves.toEqual({
      code: "AUTHENTICATION_REQUIRED",
      error: "Authentication required",
    });
  });

  it("origin-protects mutations before changing membership", async () => {
    const fixture = await routeFixture();
    const target = await createOrLinkUser(
      fixture.database,
      TEST_AUTH_ENV,
      {
      displayName: "Target",
      email: "route-target@example.test",
      provider: "test",
      subject: "route-target",
      },
    );
    await fixture.database.prepare(
      `INSERT INTO workspace_members(workspace_id,user_id,role,created_at)
       VALUES(?,?,'viewer',?)`,
    ).bind(
      fixture.state.workspace.id,
      target.userId,
      "2026-07-25T01:00:00.000Z",
    ).run();
    const before = fixture.sqlite.prepare(
      `SELECT snapshot.access_revision,user.membership_revision
       FROM workspace_snapshots snapshot
       JOIN users user ON user.user_id=?
       WHERE snapshot.workspace_id=?`,
    ).get(target.userId, fixture.state.workspace.id) as {
      access_revision: number;
      membership_revision: number;
    };

    const response = await patchMember(
      jsonRequest(
        `/api/workspaces/${fixture.state.workspace.id}/members/${target.userId}`,
        fixture.cookie,
        fixture.owner.userId,
        "PATCH",
        {
          expectedAccessRevision: before.access_revision,
          expectedMembershipRevision: before.membership_revision,
          role: "editor",
        },
        { origin: "https://evil.test" },
      ),
      {
        params: Promise.resolve({
          userId: target.userId,
          workspaceId: fixture.state.workspace.id,
        }),
      },
    );

    expect(response.status).toBe(403);
    expect(response.headers.get("cache-control")).toBe("no-store");
    await expect(response.json()).resolves.toEqual({
      code: "CROSS_ORIGIN_DENIED",
      error: "Cross-origin mutation denied",
    });
    expect(fixture.sqlite.prepare(
      `SELECT role FROM workspace_members
       WHERE workspace_id=? AND user_id=?`,
    ).get(fixture.state.workspace.id, target.userId)).toEqual({
      role: "viewer",
    });
  });

  it("bounds control bodies before creating a guest link", async () => {
    const fixture = await routeFixture();
    const response = await postGuestLink(
      new Request(
        `https://stowplan.test/api/workspaces/${fixture.state.workspace.id}/guest-links`,
        {
          body: "{}",
          headers: {
            "content-length": String(
              WORKSPACE_ACCESS_REQUEST_MAX_BYTES + 1,
            ),
            "content-type": "application/json",
            [ACCOUNT_CONTEXT_HEADER]: fixture.owner.userId,
            cookie: fixture.cookie,
          },
          method: "POST",
        },
      ),
      {
        params: Promise.resolve({
          workspaceId: fixture.state.workspace.id,
        }),
      },
    );

    expect(response.status).toBe(413);
    expect(response.headers.get("cache-control")).toBe("no-store");
    await expect(response.json()).resolves.toMatchObject({
      code: "BODY_TOO_LARGE",
    });
    expect(fixture.sqlite.prepare(
      "SELECT COUNT(*) AS count FROM guest_links",
    ).get()).toEqual({ count: 0 });
  });

  it("rejects an overlong canonical return path without durable writes", async () => {
    const fixture = await routeFixture();
    const revision = fixture.sqlite.prepare(
      `SELECT access_revision FROM workspace_snapshots
       WHERE workspace_id=?`,
    ).get(fixture.state.workspace.id) as { access_revision: number };
    const returnTo =
      `/workspaces/${fixture.state.workspace.id}/inventory/items/${
        "i".repeat(GUEST_INVITATION_RETURN_TO_MAX_CHARACTERS + 1)
      }`;
    const response = await postGuestLink(
      jsonRequest(
        `/api/workspaces/${fixture.state.workspace.id}/guest-links`,
        fixture.cookie,
        fixture.owner.userId,
        "POST",
        {
          expectedAccessRevision: revision.access_revision,
          expiresInHours: 24,
          returnTo,
          role: "viewer",
        },
      ),
      {
        params: Promise.resolve({
          workspaceId: fixture.state.workspace.id,
        }),
      },
    );

    expect(response.status).toBe(400);
    expect(response.headers.get("cache-control")).toBe("no-store");
    await expect(response.json()).resolves.toEqual({
      code: "INVALID_REQUEST",
      error:
        `returnTo must resolve to a valid workspace path no longer than ${GUEST_INVITATION_RETURN_TO_MAX_CHARACTERS} characters`,
    });
    expect(fixture.sqlite.prepare(
      `SELECT
         (SELECT COUNT(*) FROM guest_links) AS guest_links,
         (SELECT COUNT(*) FROM auth_audit_events
          WHERE action='guest.create') AS audit_events,
         (SELECT COUNT(*) FROM creation_ledger
          WHERE resource='guest_link') AS ledger_events`,
    ).get()).toEqual({
      audit_events: 0,
      guest_links: 0,
      ledger_events: 0,
    });
  });

  it("origin-protects server deletion without changing durable data", async () => {
    const fixture = await routeFixture();
    const response = await deleteWorkspace(
      jsonRequest(
        `/api/workspaces/${fixture.state.workspace.id}`,
        fixture.cookie,
        fixture.owner.userId,
        "DELETE",
        {},
        { origin: "https://evil.test" },
      ),
      {
        params: Promise.resolve({
          workspaceId: fixture.state.workspace.id,
        }),
      },
    );

    expect(response.status).toBe(403);
    expect(response.headers.get("cache-control")).toBe("no-store");
    await expect(response.json()).resolves.toEqual({
      code: "CROSS_ORIGIN_DENIED",
      error: "Cross-origin mutation denied",
    });
    expect(fixture.sqlite.prepare(
      `SELECT COUNT(*) AS count FROM workspace_snapshots
       WHERE workspace_id=?`,
    ).get(fixture.state.workspace.id)).toEqual({ count: 1 });
    expect(fixture.sqlite.prepare(
      `SELECT COUNT(*) AS count FROM workspace_deletions
       WHERE workspace_id=?`,
    ).get(fixture.state.workspace.id)).toEqual({ count: 0 });
  });

  it("bounds server deletion bodies without changing durable data", async () => {
    const fixture = await routeFixture();
    const response = await deleteWorkspace(
      new Request(
        `https://stowplan.test/api/workspaces/${fixture.state.workspace.id}`,
        {
          body: "{}",
          headers: {
            "content-length": String(
              WORKSPACE_ACCESS_REQUEST_MAX_BYTES + 1,
            ),
            "content-type": "application/json",
            [ACCOUNT_CONTEXT_HEADER]: fixture.owner.userId,
            cookie: fixture.cookie,
          },
          method: "DELETE",
        },
      ),
      {
        params: Promise.resolve({
          workspaceId: fixture.state.workspace.id,
        }),
      },
    );

    expect(response.status).toBe(413);
    expect(response.headers.get("cache-control")).toBe("no-store");
    await expect(response.json()).resolves.toMatchObject({
      code: "BODY_TOO_LARGE",
    });
    expect(fixture.sqlite.prepare(
      `SELECT COUNT(*) AS count FROM workspace_snapshots
       WHERE workspace_id=?`,
    ).get(fixture.state.workspace.id)).toEqual({ count: 1 });
    expect(fixture.sqlite.prepare(
      `SELECT COUNT(*) AS count FROM workspace_deletions
       WHERE workspace_id=?`,
    ).get(fixture.state.workspace.id)).toEqual({ count: 0 });
  });

  it.each([
    {
      body: "{",
      contentType: "application/json",
      expectedCode: "INVALID_REQUEST",
      expectedStatus: 400,
      label: "malformed JSON",
    },
    {
      body: "{}",
      contentType: "text/plain",
      expectedCode: "INVALID_REQUEST",
      expectedStatus: 415,
      label: "the wrong media type",
    },
  ])(
    "refuses deletion with $label without changing durable data",
    async ({ body, contentType, expectedCode, expectedStatus }) => {
      const fixture = await routeFixture();
      const response = await deleteWorkspace(
        new Request(
          `https://stowplan.test/api/workspaces/${fixture.state.workspace.id}`,
          {
            body,
            headers: {
              "content-type": contentType,
              [ACCOUNT_CONTEXT_HEADER]: fixture.owner.userId,
              cookie: fixture.cookie,
              origin: "https://stowplan.test",
            },
            method: "DELETE",
          },
        ),
        {
          params: Promise.resolve({
            workspaceId: fixture.state.workspace.id,
          }),
        },
      );

      expect(response.status).toBe(expectedStatus);
      expect(response.headers.get("cache-control")).toBe("no-store");
      await expect(response.json()).resolves.toMatchObject({
        code: expectedCode,
      });
      expect(fixture.sqlite.prepare(
        `SELECT COUNT(*) AS count FROM workspace_snapshots
         WHERE workspace_id=?`,
      ).get(fixture.state.workspace.id)).toEqual({ count: 1 });
      expect(fixture.sqlite.prepare(
        `SELECT COUNT(*) AS count FROM workspace_deletions
         WHERE workspace_id=?`,
      ).get(fixture.state.workspace.id)).toEqual({ count: 0 });
    },
  );

  it("bounds streamed server deletion bodies without changing durable data", async () => {
    const fixture = await routeFixture();
    const response = await deleteWorkspace(
      new Request(
        `https://stowplan.test/api/workspaces/${fixture.state.workspace.id}`,
        {
          body: " ".repeat(WORKSPACE_ACCESS_REQUEST_MAX_BYTES + 1),
          headers: {
            "content-type": "application/json",
            [ACCOUNT_CONTEXT_HEADER]: fixture.owner.userId,
            cookie: fixture.cookie,
            origin: "https://stowplan.test",
          },
          method: "DELETE",
        },
      ),
      {
        params: Promise.resolve({
          workspaceId: fixture.state.workspace.id,
        }),
      },
    );

    expect(response.status).toBe(413);
    expect(response.headers.get("cache-control")).toBe("no-store");
    await expect(response.json()).resolves.toMatchObject({
      code: "BODY_TOO_LARGE",
    });
    expect(fixture.sqlite.prepare(
      `SELECT COUNT(*) AS count FROM workspace_snapshots
       WHERE workspace_id=?`,
    ).get(fixture.state.workspace.id)).toEqual({ count: 1 });
    expect(fixture.sqlite.prepare(
      `SELECT COUNT(*) AS count FROM workspace_deletions
       WHERE workspace_id=?`,
    ).get(fixture.state.workspace.id)).toEqual({ count: 0 });
  });

  it("returns an uncached account-scoped deletion success exactly once", async () => {
    const fixture = await routeFixture();
    const revision = fixture.sqlite.prepare(
      `SELECT snapshot.revision,snapshot.access_revision,
              user.membership_revision
       FROM workspace_snapshots snapshot
       JOIN users user ON user.user_id=?
       WHERE snapshot.workspace_id=?`,
    ).get(
      fixture.owner.userId,
      fixture.state.workspace.id,
    ) as {
      access_revision: number;
      membership_revision: number;
      revision: number;
    };
    const body = {
      confirmationName: fixture.state.workspace.name,
      expectedAccessRevision: revision.access_revision,
      expectedMembershipRevision: revision.membership_revision,
      expectedRevision: revision.revision,
    };
    const remove = () => deleteWorkspace(
      jsonRequest(
        `/api/workspaces/${fixture.state.workspace.id}`,
        fixture.cookie,
        fixture.owner.userId,
        "DELETE",
        body,
        { origin: "https://stowplan.test" },
      ),
      {
        params: Promise.resolve({
          workspaceId: fixture.state.workspace.id,
        }),
      },
    );

    const response = await remove();
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get(ACCOUNT_CONTEXT_HEADER)).toBe(
      fixture.owner.userId,
    );
    await expect(response.json()).resolves.toMatchObject({
      deleted: true,
      recovery: "not_available",
      workspaceId: fixture.state.workspace.id,
    });

    const repeated = await remove();
    expect(repeated.status).toBe(410);
    expect(repeated.headers.get("cache-control")).toBe("no-store");
    await expect(repeated.json()).resolves.toMatchObject({
      code: "WORKSPACE_DELETED",
    });
    expect(fixture.sqlite.prepare(
      `SELECT COUNT(*) AS count FROM workspace_snapshots
       WHERE workspace_id=?`,
    ).get(fixture.state.workspace.id)).toEqual({ count: 0 });
    expect(fixture.sqlite.prepare(
      `SELECT COUNT(*) AS count FROM workspace_deletions
       WHERE workspace_id=?`,
    ).get(fixture.state.workspace.id)).toEqual({ count: 1 });
    expect(fixture.sqlite.prepare(
      `SELECT COUNT(*) AS count FROM auth_audit_events
       WHERE action='workspace.delete' AND target_id=?`,
    ).get(fixture.state.workspace.id)).toEqual({ count: 1 });
  });

  it("returns a raw guest URL only from creation and never from listing", async () => {
    const fixture = await routeFixture();
    const returnTo =
      `/workspaces/${fixture.state.workspace.id}/settings`;
    const revision = fixture.sqlite.prepare(
      `SELECT access_revision FROM workspace_snapshots
       WHERE workspace_id=?`,
    ).get(fixture.state.workspace.id) as { access_revision: number };
    const created = await postGuestLink(
      jsonRequest(
        `/api/workspaces/${fixture.state.workspace.id}/guest-links`,
        fixture.cookie,
        fixture.owner.userId,
        "POST",
        {
          expectedAccessRevision: revision.access_revision,
          expiresInHours: 36,
          returnTo,
          role: "viewer",
        },
      ),
      {
        params: Promise.resolve({
          workspaceId: fixture.state.workspace.id,
        }),
      },
    );

    expect(created.status).toBe(201);
    expect(created.headers.get("cache-control")).toBe("no-store");
    expect(created.headers.get(ACCOUNT_CONTEXT_HEADER)).toBe(
      fixture.owner.userId,
    );
    const creationBody = await created.json() as {
      oneTimeUrl: string;
    };
    const invitation = new URL(creationBody.oneTimeUrl);
    expect(invitation.pathname).toBe("/guest");
    expect(invitation.search).toBe("");
    const rawToken = new URLSearchParams(
      invitation.hash.slice(1),
    ).get("token");
    expect(new URLSearchParams(invitation.hash.slice(1)).get("returnTo"))
      .toBe(returnTo);
    expect(rawToken).toBeTruthy();
    expect(invitation.href.slice(0, invitation.href.indexOf("#")))
      .not.toContain(rawToken);

    const listed = await getGuestLinks(
      new Request(
        `https://stowplan.test/api/workspaces/${fixture.state.workspace.id}/guest-links`,
        {
          headers: {
            [ACCOUNT_CONTEXT_HEADER]: fixture.owner.userId,
            cookie: fixture.cookie,
          },
        },
      ),
      {
        params: Promise.resolve({
          workspaceId: fixture.state.workspace.id,
        }),
      },
    );
    expect(listed.status).toBe(200);
    expect(listed.headers.get(ACCOUNT_CONTEXT_HEADER)).toBe(
      fixture.owner.userId,
    );
    const listingText = await listed.text();
    expect(listingText).not.toContain(rawToken);
  });
});
