import { describe, expect, it, vi } from "vitest";
import { createEmptyState } from "../src/domain/factories";
import { D1SnapshotStore } from "../src/adapters/d1-snapshot-store";
import {
  AUTH_CLEANUP_BATCH_SIZE,
  AuthorizationError,
  authenticate,
  authorizeAdmin,
  beginOAuth,
  claimWorkspace,
  cleanupAuthRecords,
  consumeGuestLink,
  createGuestLink,
  createOrLinkUser,
  finishOAuth,
  InvitationError,
  isTrustedMutation,
  issueSession,
  revokeCurrentSession,
} from "../src/server/auth";
import { QuotaExceededError } from "../src/server/quotas";
import {
  API_QUOTAS,
  GUEST_LINK_EXPIRY_HOURS,
} from "../src/shared/api-quotas";
import { numberedMigrationDatabase } from "./helpers/sqlite-d1";

function database() {
  return numberedMigrationDatabase().database;
}

describe("authentication",()=>{
  it("links identities, issues opaque sessions, and revokes them",async()=>{const db=database(),env={AUTH_ADMIN_EMAILS:"owner@example.com"};const user=await createOrLinkUser(db,env,{provider:"test",subject:"one",email:"OWNER@example.com",displayName:"Owner"});expect(user.globalRole).toBe("admin");const request=new Request("https://example.test",{headers:{"user-agent":"test"}}),session=await issueSession(db,env,user,request);expect(session.raw).toHaveLength(64);const authenticated=await authenticate(db,new Request("https://example.test",{headers:{cookie:`stowplan_session=${session.raw}`}}));expect(authenticated?.email).toBe("owner@example.com");await revokeCurrentSession(db,new Request("https://example.test",{headers:{cookie:`stowplan_session=${session.raw}`}}));expect(await authenticate(db,new Request("https://example.test",{headers:{cookie:`stowplan_session=${session.raw}`}}))).toBeNull()});
  it("scrubs OAuth credentials as soon as a state is claimed", async () => {
    const { database: db, sqlite } = numberedMigrationDatabase();
    const oauthProvider = {
      authorizationUrl: "https://provider.example/authorize",
      clientId: "client-id",
      clientSecret: "client-secret",
      id: "github" as const,
      scopes: "read:user user:email",
      tokenUrl: "https://provider.example/token",
    };
    const authorizationUrl = await beginOAuth(
      db,
      oauthProvider,
      "https://stowplan.example",
      "/spaces",
    );
    const state = new URL(authorizationUrl).searchParams.get("state");
    expect(state).toBeTruthy();
    const before = sqlite.prepare(
      `SELECT verifier_ciphertext, return_to
       FROM oauth_states`,
    ).get() as {
      return_to: string;
      verifier_ciphertext: string;
    };
    expect(before.return_to).toBe("/spaces");
    expect(before.verifier_ciphertext).not.toBe("");

    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(null, { status: 503 }),
    );
    try {
      await expect(finishOAuth(
        db,
        oauthProvider,
        "https://stowplan.example",
        state!,
        "authorization-code",
      )).rejects.toThrow("OAuth token exchange failed");
      expect(fetchSpy).toHaveBeenCalledOnce();
      const requestBody = new URLSearchParams(
        String(fetchSpy.mock.calls[0]?.[1]?.body),
      );
      expect(requestBody.get("code_verifier")).toBe(
        before.verifier_ciphertext,
      );
    } finally {
      fetchSpy.mockRestore();
    }

    expect(sqlite.prepare(
      `SELECT verifier_ciphertext, return_to, consumed_at
       FROM oauth_states`,
    ).get()).toMatchObject({
      consumed_at: expect.any(String),
      return_to: "/",
      verifier_ciphertext: "",
    });
  });
  it("does not grant first-user admin scope around a configured allowlist", async () => {
    const db = database();
    const env = { AUTH_ADMIN_EMAILS: "configured-admin@example.com" };
    const unlisted = await createOrLinkUser(db, env, {
      displayName: "Unlisted",
      email: "unlisted@example.com",
      provider: "test",
      subject: "unlisted-first",
    });
    const configured = await createOrLinkUser(db, env, {
      displayName: "Configured",
      email: "configured-admin@example.com",
      provider: "test",
      subject: "configured-second",
    });

    expect(unlisted.globalRole).toBe("user");
    expect(configured.globalRole).toBe("admin");
  });
  it("promotes an existing allowlisted account when it signs in again", async () => {
    const { database: db, sqlite } = numberedMigrationDatabase();
    await createOrLinkUser(db, {}, {
      displayName: "Initial owner",
      email: "initial-owner@example.com",
      provider: "test",
      subject: "initial-owner",
    });
    const existing = await createOrLinkUser(db, {}, {
      displayName: "Configured admin",
      email: "configured-admin@example.com",
      provider: "test",
      subject: "configured-admin",
    });
    expect(existing.globalRole).toBe("user");

    const promoted = await createOrLinkUser(
      db,
      { AUTH_ADMIN_EMAILS: "configured-admin@example.com" },
      {
        displayName: "Configured admin",
        email: "configured-admin@example.com",
        provider: "test",
        subject: "configured-admin",
      },
    );

    expect(promoted.globalRole).toBe("admin");
    expect(sqlite.prepare(
      "SELECT global_role FROM users WHERE user_id = ?",
    ).get(existing.userId)).toEqual({ global_role: "admin" });
  });
  it("stores only validated anonymous IP prefixes for normal sessions", async () => {
    const { database: db, sqlite } = numberedMigrationDatabase();
    const user = await createOrLinkUser(db, {}, {
      provider: "test",
      subject: "prefix-owner",
      email: "prefix-owner@example.com",
      displayName: "Owner",
    });
    await issueSession(
      db,
      {},
      user,
      new Request("https://example.test", {
        headers: { "cf-connecting-ip": "2001:db8:1234:5678::1" },
      }),
    );
    await issueSession(
      db,
      {},
      user,
      new Request("https://example.test", {
        headers: { "cf-connecting-ip": "not-an-ip-address" },
      }),
    );
    await issueSession(
      db,
      {},
      user,
      new Request("https://example.test", {
        headers: { "cf-connecting-ip": "::ffff:192.0.2.33" },
      }),
    );

    expect(sqlite.prepare(
      `SELECT ip_prefix
       FROM sessions
       WHERE user_id = ?
       ORDER BY rowid`,
    ).all(user.userId)).toEqual([
      { ip_prefix: "2001:db8:1234::/48" },
      { ip_prefix: null },
      { ip_prefix: "192.0.2.0/24" },
    ]);
  });
  it("accepts an invite with D1 trigger-inclusive change metadata", async () => {
    const { database: db, sqlite } = numberedMigrationDatabase({
      triggerInclusiveChanges: true,
    });
    const state = createEmptyState("Guest prefix");
    await new D1SnapshotStore(db).initialize(state);
    const owner = await createOrLinkUser(db, {}, {
      provider: "test",
      subject: "guest-prefix-owner",
      email: "guest-prefix-owner@example.com",
      displayName: "Owner",
    });
    const recipient = await createOrLinkUser(db, {}, {
      provider: "test",
      subject: "guest-prefix-recipient",
      email: "guest-prefix-recipient@example.com",
      displayName: "Recipient",
    });
    await claimWorkspace(db, owner.userId, state.workspace.id);
    const link = await createGuestLink(
      db,
      state.workspace.id,
      owner.userId,
      "viewer",
      1,
    );
    await consumeGuestLink(
      db,
      link.raw,
      recipient.userId,
    );

    expect(sqlite.prepare(
      `SELECT role
       FROM workspace_members
       WHERE workspace_id=? AND user_id=?`,
    ).get(state.workspace.id, recipient.userId)).toEqual({
      role: "viewer",
    });
    expect(sqlite.prepare(
      `SELECT actor_user_id,target_id
       FROM auth_audit_events
       WHERE action='member.invite.accept'`,
    ).get()).toEqual({
      actor_user_id: recipient.userId,
      target_id: recipient.userId,
    });
  });
  it("rolls back a guest link when its audit insert fails", async () => {
    const { database: db, sqlite } = numberedMigrationDatabase();
    const state = createEmptyState("Guest audit rollback");
    await new D1SnapshotStore(db).initialize(state);
    const owner = await createOrLinkUser(db, {}, {
      displayName: "Guest audit owner",
      email: "guest-audit-owner@example.com",
      provider: "test",
      subject: "guest-audit-owner",
    });
    await claimWorkspace(db, owner.userId, state.workspace.id);
    sqlite.exec(
      `CREATE TRIGGER reject_guest_audit
       BEFORE INSERT ON auth_audit_events
       WHEN NEW.action = 'guest.create'
       BEGIN
         SELECT RAISE(ABORT, 'injected guest audit failure');
       END`,
    );

    await expect(createGuestLink(
      db,
      state.workspace.id,
      owner.userId,
      "viewer",
    )).rejects.toThrow(/injected guest audit failure/);
    expect(sqlite.prepare(
      "SELECT COUNT(*) AS count FROM guest_links",
    ).get()).toEqual({ count: 0 });
    expect(sqlite.prepare(
      "SELECT COUNT(*) AS count FROM auth_audit_events",
    ).get()).toEqual({ count: 0 });
  });
  it("requires an active workspace owner and strictly validates link expiry", async () => {
    const { database: db, sqlite } = numberedMigrationDatabase();
    const state = createEmptyState("Owner-only guest links");
    await new D1SnapshotStore(db).initialize(state);
    const owner = await createOrLinkUser(db, {}, {
      displayName: "Owner",
      email: "owner-only@example.com",
      provider: "test",
      subject: "owner-only",
    });
    const editor = await createOrLinkUser(db, {}, {
      displayName: "Editor",
      email: "editor-only@example.com",
      provider: "test",
      subject: "editor-only",
    });
    const viewer = await createOrLinkUser(db, {}, {
      displayName: "Viewer",
      email: "viewer-only@example.com",
      provider: "test",
      subject: "viewer-only",
    });
    const admin = await createOrLinkUser(
      db,
      { AUTH_ADMIN_EMAILS: "global-admin@example.com" },
      {
        displayName: "Global admin",
        email: "global-admin@example.com",
        provider: "test",
        subject: "global-admin-only",
      },
    );
    await claimWorkspace(db, owner.userId, state.workspace.id);
    const createdAt = "2026-07-24T00:00:00.000Z";
    sqlite.prepare(
      `INSERT INTO workspace_members(
         workspace_id,user_id,role,created_at
       ) VALUES(?,?,?,?)`,
    ).run(state.workspace.id, editor.userId, "editor", createdAt);
    sqlite.prepare(
      `INSERT INTO workspace_members(
         workspace_id,user_id,role,created_at
       ) VALUES(?,?,?,?)`,
    ).run(state.workspace.id, viewer.userId, "viewer", createdAt);

    for (const unauthorized of [editor, viewer, admin]) {
      await expect(createGuestLink(
        db,
        state.workspace.id,
        unauthorized.userId,
        "viewer",
      )).rejects.toMatchObject({
        status: 403,
      } satisfies Partial<AuthorizationError>);
    }
    for (const hours of [
      GUEST_LINK_EXPIRY_HOURS.minimum - 1,
      GUEST_LINK_EXPIRY_HOURS.maximum + 1,
      GUEST_LINK_EXPIRY_HOURS.minimum + 0.5,
    ]) {
      await expect(createGuestLink(
        db,
        state.workspace.id,
        owner.userId,
        "viewer",
        hours,
      )).rejects.toThrow(
        `integer from ${GUEST_LINK_EXPIRY_HOURS.minimum} through ${GUEST_LINK_EXPIRY_HOURS.maximum} hours`,
      );
    }
    expect(sqlite.prepare(
      "SELECT COUNT(*) AS count FROM guest_links",
    ).get()).toEqual({ count: 0 });
    expect(sqlite.prepare(
      "SELECT COUNT(*) AS count FROM auth_audit_events",
    ).get()).toEqual({ count: 0 });
  });
  it("advances access and membership revisions during guest redemption", async () => {
    const { database: db, sqlite } = numberedMigrationDatabase();
    const state = createEmptyState("Guest redemption revisions");
    await new D1SnapshotStore(db).initialize(state);
    const owner = await createOrLinkUser(db, {}, {
      displayName: "Owner",
      email: "guest-revision-owner@example.com",
      provider: "test",
      subject: "guest-revision-owner",
    });
    const recipient = await createOrLinkUser(db, {}, {
      displayName: "Recipient",
      email: "guest-revision-recipient@example.com",
      provider: "test",
      subject: "guest-revision-recipient",
    });
    await claimWorkspace(db, owner.userId, state.workspace.id);
    expect(sqlite.prepare(
      `SELECT access_revision
       FROM workspace_snapshots
       WHERE workspace_id=?`,
    ).get(state.workspace.id)).toEqual({ access_revision: 1 });

    const link = await createGuestLink(
      db,
      state.workspace.id,
      owner.userId,
      "viewer",
      1,
    );
    expect(sqlite.prepare(
      `SELECT access_revision
       FROM workspace_snapshots
       WHERE workspace_id=?`,
    ).get(state.workspace.id)).toEqual({ access_revision: 2 });

    await consumeGuestLink(
      db,
      link.raw,
      recipient.userId,
    );
    expect(sqlite.prepare(
      `SELECT access_revision
       FROM workspace_snapshots
       WHERE workspace_id=?`,
    ).get(state.workspace.id)).toEqual({ access_revision: 4 });
    expect(sqlite.prepare(
      `SELECT membership_revision
       FROM users
       WHERE user_id=?`,
    ).get(recipient.userId)).toEqual({ membership_revision: 1 });
    expect(sqlite.prepare(
      `SELECT detail_json
       FROM auth_audit_events
       WHERE action='guest.create'`,
    ).get()).toEqual({
      detail_json: JSON.stringify({
        expiresAt: link.expiresAt,
        role: "viewer",
        workspaceId: state.workspace.id,
      }),
    });
    expect(sqlite.prepare(
      `SELECT actor_user_id,target_id,detail_json
       FROM auth_audit_events
       WHERE action='member.invite.accept'`,
    ).get()).toEqual({
      actor_user_id: recipient.userId,
      target_id: recipient.userId,
      detail_json: JSON.stringify({
        guestLinkId: link.id,
        role: "viewer",
        workspaceId: state.workspace.id,
      }),
    });
  });
  it("does not redeem or recreate access through a deletion tombstone", async () => {
    const { database: db, sqlite } = numberedMigrationDatabase();
    const state = createEmptyState("Deleted guest workspace");
    await new D1SnapshotStore(db).initialize(state);
    const owner = await createOrLinkUser(db, {}, {
      displayName: "Owner",
      email: "deleted-guest-owner@example.com",
      provider: "test",
      subject: "deleted-guest-owner",
    });
    const recipient = await createOrLinkUser(db, {}, {
      displayName: "Recipient",
      email: "deleted-guest-recipient@example.com",
      provider: "test",
      subject: "deleted-guest-recipient",
    });
    await claimWorkspace(db, owner.userId, state.workspace.id);
    const link = await createGuestLink(
      db,
      state.workspace.id,
      owner.userId,
      "viewer",
      1,
    );
    const snapshot = sqlite.prepare(
      `SELECT access_revision,revision
       FROM workspace_snapshots
       WHERE workspace_id=?`,
    ).get(state.workspace.id) as {
      access_revision: number;
      revision: number;
    };
    sqlite.prepare(
      `INSERT INTO workspace_deletions(
         workspace_id,deletion_id,deleted_at,deleted_by_user_id,
         final_snapshot_revision,final_access_revision
       ) VALUES(?,?,?,?,?,?)`,
    ).run(
      state.workspace.id,
      "deletion_guest_test",
      "2026-07-24T00:00:00.000Z",
      owner.userId,
      snapshot.revision,
      snapshot.access_revision,
    );

    await expect(consumeGuestLink(
      db,
      link.raw,
      recipient.userId,
    )).rejects.toThrow(/invalid, expired, used, or revoked/);
    await expect(createGuestLink(
      db,
      state.workspace.id,
      owner.userId,
      "viewer",
    )).rejects.toMatchObject({
      status: 403,
    } satisfies Partial<AuthorizationError>);
    expect(sqlite.prepare(
      `SELECT consumed_at,redemption_id
       FROM guest_links
       WHERE guest_link_id=?`,
    ).get(link.id)).toEqual({
      consumed_at: null,
      redemption_id: null,
    });
    expect(sqlite.prepare(
      "SELECT COUNT(*) AS count FROM identities WHERE provider='guest'",
    ).get()).toEqual({ count: 0 });
  });
  it("reports an invitation refusal when deletion removes a link during enrollment", async () => {
    const { database: db, sqlite } = numberedMigrationDatabase();
    const state = createEmptyState("Invite deletion race");
    await new D1SnapshotStore(db).initialize(state);
    const owner = await createOrLinkUser(db, {}, {
      displayName: "Owner",
      email: "invite-race-owner@example.com",
      provider: "test",
      subject: "invite-race-owner",
    });
    const recipient = await createOrLinkUser(db, {}, {
      displayName: "Recipient",
      email: "invite-race-recipient@example.com",
      provider: "test",
      subject: "invite-race-recipient",
    });
    await claimWorkspace(db, owner.userId, state.workspace.id);
    const link = await createGuestLink(
      db,
      state.workspace.id,
      owner.userId,
      "viewer",
      1,
    );
    let raced = false;
    const racingDatabase = {
      prepare: db.prepare.bind(db),
      async batch(statements: Parameters<typeof db.batch>[0]) {
        if (!raced && statements.length === 4) {
          raced = true;
          sqlite.prepare(
            "DELETE FROM guest_links WHERE guest_link_id=?",
          ).run(link.id);
        }
        return db.batch(statements);
      },
    };

    const error = await consumeGuestLink(
      racingDatabase,
      link.raw,
      recipient.userId,
    ).then(() => null, (failure: unknown) => failure);

    expect(error).toBeInstanceOf(InvitationError);
    expect(error).toMatchObject({
      message: "Invite link is invalid, expired, used, or revoked",
      status: 409,
    });
    expect(error).not.toBeInstanceOf(AuthorizationError);
    expect(sqlite.prepare(
      `SELECT COUNT(*) AS count
       FROM workspace_members
       WHERE workspace_id=? AND user_id=?`,
    ).get(state.workspace.id, recipient.userId)).toEqual({ count: 0 });
  });
  it("atomically enrolls one signed-in account with an invite", async () => {
    const { database: db, sqlite } = numberedMigrationDatabase();
    const state = createEmptyState("Invite concurrency");
    await new D1SnapshotStore(db).initialize(state);
    const owner = await createOrLinkUser(db, {}, {
      displayName: "Owner",
      email: "invite-owner@example.com",
      provider: "test",
      subject: "invite-owner",
    });
    const first = await createOrLinkUser(db, {}, {
      displayName: "First recipient",
      email: "invite-first@example.com",
      provider: "test",
      subject: "invite-first",
    });
    const second = await createOrLinkUser(db, {}, {
      displayName: "Second recipient",
      email: "invite-second@example.com",
      provider: "test",
      subject: "invite-second",
    });
    await claimWorkspace(db, owner.userId, state.workspace.id);
    const link = await createGuestLink(
      db,
      state.workspace.id,
      owner.userId,
      "editor",
      1,
    );

    const results = await Promise.allSettled([
      consumeGuestLink(db, link.raw, first.userId),
      consumeGuestLink(db, link.raw, second.userId),
    ]);

    expect(results.filter((result) => result.status === "fulfilled"))
      .toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected"))
      .toHaveLength(1);
    expect(sqlite.prepare(
      `SELECT COUNT(*) AS count
       FROM workspace_members
       WHERE workspace_id=? AND role='editor'`,
    ).get(state.workspace.id)).toEqual({ count: 1 });
    expect(sqlite.prepare(
      `SELECT COUNT(*) AS count
       FROM auth_audit_events
       WHERE action='member.invite.accept'`,
    ).get()).toEqual({ count: 1 });
  });
  it("rolls back invite enrollment when its audit insert fails", async () => {
    const { database: db, sqlite } = numberedMigrationDatabase();
    const state = createEmptyState("Guest rollback");
    await new D1SnapshotStore(db).initialize(state);
    const owner = await createOrLinkUser(db, {}, {
      provider: "test",
      subject: "rollback-owner",
      email: "rollback-owner@example.com",
      displayName: "Owner",
    });
    const recipient = await createOrLinkUser(db, {}, {
      provider: "test",
      subject: "rollback-recipient",
      email: "rollback-recipient@example.com",
      displayName: "Recipient",
    });
    await claimWorkspace(db, owner.userId, state.workspace.id);
    const link = await createGuestLink(
      db,
      state.workspace.id,
      owner.userId,
      "viewer",
      1,
    );
    sqlite.exec(`
      CREATE TRIGGER fail_invite_accept_audit
      BEFORE INSERT ON auth_audit_events
      WHEN NEW.action = 'member.invite.accept'
      BEGIN
        SELECT RAISE(ABORT, 'injected invite audit failure');
      END
    `);

    await expect(consumeGuestLink(
      db,
      link.raw,
      recipient.userId,
    )).rejects.toThrow(/injected invite audit failure/);
    expect(sqlite.prepare(
      `SELECT consumed_at, redemption_id
       FROM guest_links
       WHERE guest_link_id = ?`,
    ).get(link.id)).toEqual({
      consumed_at: null,
      redemption_id: null,
    });
    expect(sqlite.prepare(
      `SELECT COUNT(*) AS count
       FROM workspace_members
       WHERE workspace_id=? AND user_id=?`,
    ).get(state.workspace.id, recipient.userId)).toEqual({ count: 0 });
    expect(sqlite.prepare(
      `SELECT COUNT(*) AS count
       FROM auth_audit_events
       WHERE action='member.invite.accept'`,
    ).get()).toEqual({ count: 0 });

    sqlite.exec("DROP TRIGGER fail_invite_accept_audit");
    await expect(consumeGuestLink(
      db,
      link.raw,
      recipient.userId,
    )).resolves.toMatchObject({ workspaceId: state.workspace.id });
  });
  it("bounds retained auth cleanup without expiring accepted membership", async () => {
    const { database: db, sqlite } = numberedMigrationDatabase();
    const state = createEmptyState("Cleanup");
    await new D1SnapshotStore(db).initialize(state);
    const owner = await createOrLinkUser(db, {}, {
      provider: "test",
      subject: "cleanup-owner",
      email: "cleanup-owner@example.com",
      displayName: "Owner",
    });
    const stale = "2020-01-01T00:00:00.000Z";
    const now = new Date("2026-07-24T12:00:00.000Z");
    for (let index = 0; index < AUTH_CLEANUP_BATCH_SIZE + 1; index += 1) {
      sqlite.prepare(
        `INSERT INTO sessions(
           session_id, user_id, token_hash, created_at, expires_at, last_seen_at
         ) VALUES(?,?,?,?,?,?)`,
      ).run(
        `ses_stale_${index}`,
        owner.userId,
        `hash_stale_${index}`,
        stale,
        stale,
        stale,
      );
      sqlite.prepare(
        `INSERT INTO oauth_states(
           state_hash, provider, verifier_ciphertext, return_to, created_at,
           expires_at
         ) VALUES(?,?,?,?,?,?)`,
      ).run(
        `state_stale_${index}`,
        "google",
        "verifier",
        "/",
        stale,
        stale,
      );
      sqlite.prepare(
        `INSERT INTO guest_links(
           guest_link_id, workspace_id, created_by_user_id, token_hash, role,
           created_at, expires_at
         ) VALUES(?,?,?,?,?,?,?)`,
      ).run(
        `guest_stale_${index}`,
        state.workspace.id,
        owner.userId,
        `guest_hash_stale_${index}`,
        "viewer",
        stale,
        stale,
      );
    }

    for (const guest of [
      { id: "usr_unreachable", active: false },
      { id: "usr_reachable", active: true },
    ]) {
      const email = `${guest.id}@stowplan.invalid`;
      sqlite.prepare(
        `INSERT INTO users(
           user_id, email, display_name, global_role, status, created_at,
           updated_at, last_seen_at
         ) VALUES(?,?,'Guest','user','active',?,?,?)`,
      ).run(guest.id, email, stale, stale, stale);
      sqlite.prepare(
        `INSERT INTO identities(
           identity_id, user_id, provider, provider_subject, email, created_at,
           last_used_at
         ) VALUES(?,?,'guest',?,?,?,?)`,
      ).run(
        `idn_${guest.id}`,
        guest.id,
        `link_${guest.id}`,
        email,
        stale,
        stale,
      );
      sqlite.prepare(
        `INSERT INTO workspace_members(
           workspace_id, user_id, role, created_at
         ) VALUES(?,?,'viewer',?)`,
      ).run(state.workspace.id, guest.id, stale);
      if (guest.active) {
        sqlite.prepare(
          `INSERT INTO sessions(
             session_id, user_id, token_hash, created_at, expires_at,
             last_seen_at
           ) VALUES(?,?,?,?,?,?)`,
        ).run(
          "ses_reachable",
          guest.id,
          "hash_reachable",
          now.toISOString(),
          "2026-07-25T12:00:00.000Z",
          now.toISOString(),
        );
      }
    }

    await expect(cleanupAuthRecords(db, now)).resolves.toEqual({
      guestLinks: AUTH_CLEANUP_BATCH_SIZE,
      guestMemberships: 0,
      guestUsers: 0,
      oauthStates: AUTH_CLEANUP_BATCH_SIZE,
      sessions: AUTH_CLEANUP_BATCH_SIZE,
    });
    expect(sqlite.prepare(
      "SELECT COUNT(*) AS count FROM sessions WHERE expires_at = ?",
    ).get(stale)).toEqual({ count: 1 });
    expect(sqlite.prepare(
      "SELECT COUNT(*) AS count FROM oauth_states",
    ).get()).toEqual({ count: 1 });
    expect(sqlite.prepare(
      "SELECT COUNT(*) AS count FROM guest_links",
    ).get()).toEqual({ count: 1 });
    expect(sqlite.prepare(
      "SELECT user_id FROM users WHERE user_id = 'usr_unreachable'",
    ).get()).toEqual({ user_id: "usr_unreachable" });
    expect(sqlite.prepare(
      "SELECT user_id FROM users WHERE user_id = 'usr_reachable'",
    ).get()).toEqual({ user_id: "usr_reachable" });

    await cleanupAuthRecords(db, now);
    expect(sqlite.prepare(
      "SELECT COUNT(*) AS count FROM sessions WHERE expires_at = ?",
    ).get(stale)).toEqual({ count: 0 });
    expect(sqlite.prepare(
      "SELECT COUNT(*) AS count FROM oauth_states",
    ).get()).toEqual({ count: 0 });
    expect(sqlite.prepare(
      "SELECT COUNT(*) AS count FROM guest_links",
    ).get()).toEqual({ count: 0 });
  });
  it("scrubs expired OAuth credentials before lifecycle-row cleanup", async () => {
    const { database: db, sqlite } = numberedMigrationDatabase();
    sqlite.prepare(
      `INSERT INTO oauth_states(
         state_hash, provider, verifier_ciphertext, return_to, created_at,
         expires_at
       ) VALUES(?,?,?,?,?,?)`,
    ).run(
      "recently-expired-state",
      "github",
      "private-verifier",
      "/private-return",
      "2026-07-24T11:50:00.000Z",
      "2026-07-24T12:00:00.000Z",
    );

    await expect(cleanupAuthRecords(
      db,
      new Date("2026-07-24T12:01:00.000Z"),
    )).resolves.toMatchObject({ oauthStates: 0 });
    expect(sqlite.prepare(
      `SELECT verifier_ciphertext, return_to, consumed_at
       FROM oauth_states
       WHERE state_hash='recently-expired-state'`,
    ).get()).toEqual({
      consumed_at: null,
      return_to: "/",
      verifier_ciphertext: "",
    });

    await expect(cleanupAuthRecords(
      db,
      new Date("2026-07-25T12:01:00.000Z"),
    )).resolves.toMatchObject({ oauthStates: 1 });
    expect(sqlite.prepare(
      `SELECT COUNT(*) AS count
       FROM oauth_states`,
    ).get()).toEqual({ count: 0 });
  });
  it("retains legacy accepted guest memberships regardless of session age", async () => {
    const { database: db, sqlite } = numberedMigrationDatabase();
    const shared = createEmptyState("Cleanup revisions");
    const guestOwned = createEmptyState("Guest final owner");
    await new D1SnapshotStore(db).initialize(shared);
    await new D1SnapshotStore(db).initialize(guestOwned);
    const owner = await createOrLinkUser(db, {}, {
      displayName: "Owner",
      email: "cleanup-revision-owner@example.com",
      provider: "test",
      subject: "cleanup-revision-owner",
    });
    await claimWorkspace(db, owner.userId, shared.workspace.id);
    const createdAt = "2026-07-24T00:00:00.000Z";
    for (const guest of [
      {
        role: "viewer",
        userId: "usr_cleanup_viewer",
        workspaceId: shared.workspace.id,
      },
      {
        role: "owner",
        userId: "usr_cleanup_final_owner",
        workspaceId: guestOwned.workspace.id,
      },
    ]) {
      const email = `${guest.userId}@stowplan.invalid`;
      sqlite.prepare(
        `INSERT INTO users(
           user_id,email,display_name,global_role,status,created_at,updated_at,
           last_seen_at
         ) VALUES(?,?,'Guest','user','active',?,?,?)`,
      ).run(guest.userId, email, createdAt, createdAt, createdAt);
      sqlite.prepare(
        `INSERT INTO identities(
           identity_id,user_id,provider,provider_subject,email,created_at,
           last_used_at
         ) VALUES(?,?,'guest',?,?,?,?)`,
      ).run(
        `idn_${guest.userId}`,
        guest.userId,
        `subject_${guest.userId}`,
        email,
        createdAt,
        createdAt,
      );
      sqlite.prepare(
        `INSERT INTO workspace_members(
           workspace_id,user_id,role,created_at
         ) VALUES(?,?,?,?)`,
      ).run(
        guest.workspaceId,
        guest.userId,
        guest.role,
        createdAt,
      );
    }

    await expect(cleanupAuthRecords(
      db,
      new Date("2030-01-01T00:00:00.000Z"),
    )).resolves.toMatchObject({
      guestMemberships: 0,
      guestUsers: 0,
    });
    expect(sqlite.prepare(
      `SELECT access_revision
       FROM workspace_snapshots
       WHERE workspace_id=?`,
    ).get(shared.workspace.id)).toEqual({ access_revision: 2 });
    expect(sqlite.prepare(
      `SELECT role
       FROM workspace_members
       WHERE workspace_id=? AND user_id=?`,
    ).get(
      shared.workspace.id,
      "usr_cleanup_viewer",
    )).toEqual({ role: "viewer" });
    expect(sqlite.prepare(
      `SELECT role
       FROM workspace_members
       WHERE workspace_id=? AND user_id=?`,
    ).get(
      guestOwned.workspace.id,
      "usr_cleanup_final_owner",
    )).toEqual({ role: "owner" });
    expect(sqlite.prepare(
      `SELECT access_revision
       FROM workspace_snapshots
       WHERE workspace_id=?`,
    ).get(guestOwned.workspace.id)).toEqual({ access_revision: 1 });
  });
  it("preserves durable invite membership after retained links expire", async () => {
    const { database: db, sqlite } = numberedMigrationDatabase();
    const state = createEmptyState("Guest creator cleanup");
    await new D1SnapshotStore(db).initialize(state);
    const owner = await createOrLinkUser(db, {}, {
      provider: "test",
      subject: "guest-creator-owner",
      email: "guest-creator-owner@example.com",
      displayName: "Owner",
    });
    const recipient = await createOrLinkUser(db, {}, {
      provider: "test",
      subject: "guest-creator-recipient",
      email: "guest-creator-recipient@example.com",
      displayName: "Recipient",
    });
    await claimWorkspace(db, owner.userId, state.workspace.id);
    const invitation = await createGuestLink(
      db,
      state.workspace.id,
      owner.userId,
      "editor",
      1,
    );
    await consumeGuestLink(
      db,
      invitation.raw,
      recipient.userId,
    );
    sqlite.prepare(
      `UPDATE workspace_members
       SET role='owner'
       WHERE workspace_id=? AND user_id=?`,
    ).run(state.workspace.id, recipient.userId);
    await createGuestLink(
      db,
      state.workspace.id,
      recipient.userId,
      "viewer",
      1,
    );

    const cleanupTime = new Date("2030-01-01T00:00:00.000Z");
    await expect(cleanupAuthRecords(db, cleanupTime)).resolves.toMatchObject({
      guestLinks: 2,
      guestMemberships: 0,
      guestUsers: 0,
      sessions: 0,
    });
    expect(sqlite.prepare(
      "SELECT user_id FROM users WHERE user_id = ?",
    ).get(recipient.userId)).toEqual({ user_id: recipient.userId });
    expect(sqlite.prepare(
      `SELECT role
       FROM workspace_members
       WHERE workspace_id=? AND user_id=?`,
    ).get(state.workspace.id, recipient.userId)).toEqual({
      role: "owner",
    });
    expect(sqlite.prepare(
      "SELECT COUNT(*) AS count FROM guest_links",
    ).get()).toEqual({ count: 0 });

    await expect(cleanupAuthRecords(db, cleanupTime)).resolves.toMatchObject({
      guestMemberships: 0,
      guestUsers: 0,
    });
  });
  it("limits the workspaces owned by one account", async () => {
    const { database: db, sqlite } = numberedMigrationDatabase();
    const owner = await createOrLinkUser(db, {}, {
      provider: "test",
      subject: "workspace-quota-owner",
      email: "workspace-quota-owner@example.com",
      displayName: "Owner",
    });
    for (
      let index = 0;
      index < API_QUOTAS.ownedWorkspacesPerUser;
      index += 1
    ) {
      const state = createEmptyState(`Workspace ${index}`);
      await new D1SnapshotStore(db).initialize(state);
      await claimWorkspace(db, owner.userId, state.workspace.id);
    }
    const overage = createEmptyState("Workspace overage");
    await new D1SnapshotStore(db).initialize(overage);

    await expect(claimWorkspace(
      db,
      owner.userId,
      overage.workspace.id,
    )).rejects.toMatchObject({
      actual: API_QUOTAS.ownedWorkspacesPerUser + 1,
      code: "QUOTA_EXCEEDED",
      limit: API_QUOTAS.ownedWorkspacesPerUser,
      quota: "ownedWorkspacesPerUser",
    } satisfies Partial<QuotaExceededError>);
    expect(sqlite.prepare(
      `SELECT COUNT(*) AS count
       FROM workspace_members
       WHERE user_id = ? AND role = 'owner'`,
    ).get(owner.userId)).toEqual({
      count: API_QUOTAS.ownedWorkspacesPerUser,
    });
  });
  it("limits active and retained guest links independently", async () => {
    const activeDatabase = numberedMigrationDatabase();
    const activeState = createEmptyState("Active guest link quota");
    await new D1SnapshotStore(activeDatabase.database).initialize(activeState);
    const activeOwner = await createOrLinkUser(activeDatabase.database, {}, {
      provider: "test",
      subject: "active-link-owner",
      email: "active-link-owner@example.com",
      displayName: "Owner",
    });
    await claimWorkspace(
      activeDatabase.database,
      activeOwner.userId,
      activeState.workspace.id,
    );
    const now = "2026-07-24T00:00:00.000Z";
    const future = "2099-01-01T00:00:00.000Z";
    const insertLink = activeDatabase.sqlite.prepare(
      `INSERT INTO guest_links(
         guest_link_id, workspace_id, created_by_user_id, token_hash, role,
         created_at, expires_at, revoked_at
       ) VALUES(?,?,?,?,?,?,?,?)`,
    );
    for (
      let index = 0;
      index < API_QUOTAS.activeGuestLinksPerWorkspace;
      index += 1
    ) {
      insertLink.run(
        `guest_active_${index}`,
        activeState.workspace.id,
        activeOwner.userId,
        `hash_active_${index}`,
        "viewer",
        now,
        future,
        null,
      );
    }

    await expect(createGuestLink(
      activeDatabase.database,
      activeState.workspace.id,
      activeOwner.userId,
      "viewer",
    )).rejects.toMatchObject({
      actual: API_QUOTAS.activeGuestLinksPerWorkspace + 1,
      code: "QUOTA_EXCEEDED",
      limit: API_QUOTAS.activeGuestLinksPerWorkspace,
      quota: "activeGuestLinksPerWorkspace",
    } satisfies Partial<QuotaExceededError>);

    const retainedDatabase = numberedMigrationDatabase();
    const retainedState = createEmptyState("Retained guest link quota");
    await new D1SnapshotStore(retainedDatabase.database).initialize(
      retainedState,
    );
    const retainedOwner = await createOrLinkUser(
      retainedDatabase.database,
      {},
      {
        provider: "test",
        subject: "retained-link-owner",
        email: "retained-link-owner@example.com",
        displayName: "Owner",
      },
    );
    await claimWorkspace(
      retainedDatabase.database,
      retainedOwner.userId,
      retainedState.workspace.id,
    );
    const insertRetainedLink = retainedDatabase.sqlite.prepare(
      `INSERT INTO guest_links(
         guest_link_id, workspace_id, created_by_user_id, token_hash, role,
         created_at, expires_at, revoked_at
       ) VALUES(?,?,?,?,?,?,?,?)`,
    );
    for (
      let index = 0;
      index < API_QUOTAS.retainedGuestLinksPerWorkspace;
      index += 1
    ) {
      insertRetainedLink.run(
        `guest_retained_${index}`,
        retainedState.workspace.id,
        retainedOwner.userId,
        `hash_retained_${index}`,
        "viewer",
        now,
        future,
        now,
      );
    }

    await expect(createGuestLink(
      retainedDatabase.database,
      retainedState.workspace.id,
      retainedOwner.userId,
      "viewer",
    )).rejects.toMatchObject({
      actual: API_QUOTAS.retainedGuestLinksPerWorkspace + 1,
      code: "QUOTA_EXCEEDED",
      limit: API_QUOTAS.retainedGuestLinksPerWorkspace,
      quota: "retainedGuestLinksPerWorkspace",
    } satisfies Partial<QuotaExceededError>);
  });
  it("atomically reserves the final workspace member slot", async () => {
    const { database: db, sqlite } = numberedMigrationDatabase();
    const state = createEmptyState("Member quota");
    await new D1SnapshotStore(db).initialize(state);
    const owner = await createOrLinkUser(db, {}, {
      provider: "test",
      subject: "member-quota-owner",
      email: "member-quota-owner@example.com",
      displayName: "Owner",
    });
    await claimWorkspace(db, owner.userId, state.workspace.id);
    const timestamp = "2026-07-24T00:00:00.000Z";
    const insertUser = sqlite.prepare(
      `INSERT INTO users(
         user_id, email, display_name, global_role, status, created_at,
         updated_at, last_seen_at
       ) VALUES(?,?,'Member','user','active',?,?,?)`,
    );
    const insertMembership = sqlite.prepare(
      `INSERT INTO workspace_members(
         workspace_id, user_id, role, created_at
       ) VALUES(?,?,'viewer',?)`,
    );
    for (
      let index = 1;
      index < API_QUOTAS.membersPerWorkspace - 1;
      index += 1
    ) {
      const userId = `usr_member_quota_${index}`;
      insertUser.run(
        userId,
        `member-quota-${index}@example.com`,
        timestamp,
        timestamp,
        timestamp,
      );
      insertMembership.run(state.workspace.id, userId, timestamp);
    }
    const links = await Promise.all([
      createGuestLink(db, state.workspace.id, owner.userId, "viewer"),
      createGuestLink(db, state.workspace.id, owner.userId, "viewer"),
    ]);
    const recipients = await Promise.all([
      createOrLinkUser(db, {}, {
        displayName: "First quota recipient",
        email: "first-quota-recipient@example.com",
        provider: "test",
        subject: "first-quota-recipient",
      }),
      createOrLinkUser(db, {}, {
        displayName: "Second quota recipient",
        email: "second-quota-recipient@example.com",
        provider: "test",
        subject: "second-quota-recipient",
      }),
    ]);

    const results = await Promise.allSettled(links.map((link, index) =>
      consumeGuestLink(
        db,
        link.raw,
        recipients[index].userId,
      )
    ));

    expect(results.filter((result) => result.status === "fulfilled"))
      .toHaveLength(1);
    const rejected = results.find(
      (result): result is PromiseRejectedResult =>
        result.status === "rejected",
    );
    expect(rejected?.reason).toMatchObject({
      actual: API_QUOTAS.membersPerWorkspace + 1,
      code: "QUOTA_EXCEEDED",
      limit: API_QUOTAS.membersPerWorkspace,
      quota: "membersPerWorkspace",
    } satisfies Partial<QuotaExceededError>);
    expect(sqlite.prepare(
      `SELECT COUNT(*) AS count
       FROM workspace_members
       WHERE workspace_id = ?`,
    ).get(state.workspace.id)).toEqual({
      count: API_QUOTAS.membersPerWorkspace,
    });
    expect(sqlite.prepare(
      `SELECT COUNT(*) AS count
       FROM guest_links
       WHERE workspace_id = ? AND consumed_at IS NOT NULL`,
    ).get(state.workspace.id)).toEqual({ count: 1 });
  });
  it("optionally requires a matching Cloudflare Access assertion for admin",async()=>{const db=database(),baseEnv={AUTH_ADMIN_EMAILS:"owner@example.com"};const user=await createOrLinkUser(db,baseEnv,{provider:"test",subject:"owner",email:"owner@example.com",displayName:"Owner"});const session=await issueSession(db,baseEnv,user,new Request("https://example.test"));const request=new Request("https://example.test/admin",{headers:{cookie:`stowplan_session=${session.raw}`}});expect((await authorizeAdmin(db,baseEnv,request)).userId).toBe(user.userId);await expect(authorizeAdmin(db,{...baseEnv,AUTH_ADMIN_REQUIRE_ACCESS:"true"},request)).rejects.toMatchObject({status:403} satisfies Partial<AuthorizationError>)});
  it("rejects cross-origin browser mutations while supporting trusted proxy origins",()=>{expect(isTrustedMutation(new Request("https://example.test/api/sync",{method:"POST"}))).toBe(true);expect(isTrustedMutation(new Request("https://example.test/api/sync",{method:"POST",headers:{"sec-fetch-mode":"cors","sec-fetch-site":"same-origin"}}))).toBe(false);expect(isTrustedMutation(new Request("https://example.test/api/sync",{method:"POST",headers:{origin:"https://example.test","sec-fetch-site":"cross-site"}}))).toBe(false);expect(isTrustedMutation(new Request("https://example.test/api/sync",{method:"POST",headers:{origin:"https://evil.test"}}))).toBe(false);expect(isTrustedMutation(new Request("http://internal:3000/api/sync",{method:"POST",headers:{origin:"https://stowplan.example","x-forwarded-host":"stowplan.example","x-forwarded-proto":"https"}}))).toBe(true);expect(isTrustedMutation(new Request("http://internal:3000/api/sync",{method:"POST",headers:{origin:"https://stowplan.example"}}),"https://stowplan.example")).toBe(true)});
});
