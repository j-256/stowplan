import { describe, expect, it } from "vitest";
import { createEmptyState } from "../src/domain/factories";
import { D1SnapshotStore } from "../src/adapters/d1-snapshot-store";
import {
  AUTH_CLEANUP_BATCH_SIZE,
  AuthorizationError,
  authenticate,
  authorizeAdmin,
  claimWorkspace,
  cleanupAuthRecords,
  consumeGuestLink,
  createGuestLink,
  createOrLinkUser,
  isTrustedMutation,
  issueSession,
  revokeCurrentSession,
} from "../src/server/auth";
import { numberedMigrationDatabase } from "./helpers/sqlite-d1";

function database() {
  return numberedMigrationDatabase().database;
}

describe("authentication",()=>{
  it("links identities, issues opaque sessions, and revokes them",async()=>{const db=database(),env={AUTH_ADMIN_EMAILS:"owner@example.com"};const user=await createOrLinkUser(db,env,{provider:"test",subject:"one",email:"OWNER@example.com",displayName:"Owner"});expect(user.globalRole).toBe("admin");const request=new Request("https://example.test",{headers:{"user-agent":"test"}}),session=await issueSession(db,env,user,request);expect(session.raw).toHaveLength(64);const authenticated=await authenticate(db,new Request("https://example.test",{headers:{cookie:`stowplan_session=${session.raw}`}}));expect(authenticated?.email).toBe("owner@example.com");await revokeCurrentSession(db,new Request("https://example.test",{headers:{cookie:`stowplan_session=${session.raw}`}}));expect(await authenticate(db,new Request("https://example.test",{headers:{cookie:`stowplan_session=${session.raw}`}}))).toBeNull()});
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
  it("stores an anonymous IPv4 prefix for guest sessions", async () => {
    const { database: db, sqlite } = numberedMigrationDatabase();
    const state = createEmptyState("Guest prefix");
    await new D1SnapshotStore(db).initialize(state);
    const owner = await createOrLinkUser(db, {}, {
      provider: "test",
      subject: "guest-prefix-owner",
      email: "guest-prefix-owner@example.com",
      displayName: "Owner",
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
      {},
      link.raw,
      new Request("https://example.test", {
        headers: { "cf-connecting-ip": "203.0.113.42" },
      }),
    );

    expect(sqlite.prepare(
      `SELECT sessions.ip_prefix
       FROM sessions
       JOIN identities ON identities.user_id = sessions.user_id
       WHERE identities.provider = 'guest'`,
    ).get()).toEqual({ ip_prefix: "203.0.113.0/24" });
  });
  it("atomically consumes a guest link once and creates a short session",async()=>{const db=database(),env={};const state=createEmptyState("Guest test");await new D1SnapshotStore(db).initialize(state);const owner=await createOrLinkUser(db,env,{provider:"test",subject:"owner",email:"owner@example.com",displayName:"Owner"});await claimWorkspace(db,owner.userId,state.workspace.id);const link=await createGuestLink(db,state.workspace.id,owner.userId,"editor",1);const results=await Promise.allSettled([consumeGuestLink(db,env,link.raw,new Request("https://example.test")),consumeGuestLink(db,env,link.raw,new Request("https://example.test"))]);expect(results.filter((result)=>result.status==="fulfilled")).toHaveLength(1);expect(results.filter((result)=>result.status==="rejected")).toHaveLength(1);const fulfilled=results.find((result)=>result.status==="fulfilled");expect(fulfilled?.status==="fulfilled"&&fulfilled.value.workspaceId).toBe(state.workspace.id)});
  it("rolls back the guest claim when identity creation fails", async () => {
    const { database: db, sqlite } = numberedMigrationDatabase();
    const state = createEmptyState("Guest rollback");
    await new D1SnapshotStore(db).initialize(state);
    const owner = await createOrLinkUser(db, {}, {
      provider: "test",
      subject: "rollback-owner",
      email: "rollback-owner@example.com",
      displayName: "Owner",
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
      CREATE TRIGGER fail_guest_identity
      BEFORE INSERT ON identities
      WHEN NEW.provider = 'guest'
      BEGIN
        SELECT RAISE(ABORT, 'injected guest identity failure');
      END
    `);

    await expect(consumeGuestLink(
      db,
      {},
      link.raw,
      new Request("https://example.test"),
    )).rejects.toThrow(/injected guest identity failure/);
    expect(sqlite.prepare(
      `SELECT consumed_at, redemption_id
       FROM guest_links
       WHERE guest_link_id = ?`,
    ).get(link.id)).toEqual({
      consumed_at: null,
      redemption_id: null,
    });
    expect(sqlite.prepare(
      "SELECT COUNT(*) AS count FROM identities WHERE provider = 'guest'",
    ).get()).toEqual({ count: 0 });
    expect(sqlite.prepare(
      "SELECT COUNT(*) AS count FROM users WHERE email LIKE 'guest+%'",
    ).get()).toEqual({ count: 0 });

    sqlite.exec("DROP TRIGGER fail_guest_identity");
    await expect(consumeGuestLink(
      db,
      {},
      link.raw,
      new Request("https://example.test"),
    )).resolves.toMatchObject({ workspaceId: state.workspace.id });
  });
  it("bounds retained auth cleanup and preserves reachable guests", async () => {
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
      guestMemberships: 1,
      guestUsers: 1,
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
    ).get()).toBeUndefined();
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
  it("preserves guest link creators until their expired links are removed", async () => {
    const { database: db, sqlite } = numberedMigrationDatabase();
    const state = createEmptyState("Guest creator cleanup");
    await new D1SnapshotStore(db).initialize(state);
    const owner = await createOrLinkUser(db, {}, {
      provider: "test",
      subject: "guest-creator-owner",
      email: "guest-creator-owner@example.com",
      displayName: "Owner",
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
      {},
      invitation.raw,
      new Request("https://example.test"),
    );
    const guest = sqlite.prepare(
      "SELECT user_id FROM identities WHERE provider = 'guest'",
    ).get() as { user_id: string };
    await createGuestLink(
      db,
      state.workspace.id,
      guest.user_id,
      "viewer",
      1,
    );

    const cleanupTime = new Date("2030-01-01T00:00:00.000Z");
    await expect(cleanupAuthRecords(db, cleanupTime)).resolves.toMatchObject({
      guestLinks: 2,
      guestMemberships: 1,
      guestUsers: 0,
      sessions: 1,
    });
    expect(sqlite.prepare(
      "SELECT user_id FROM users WHERE user_id = ?",
    ).get(guest.user_id)).toEqual({ user_id: guest.user_id });
    expect(sqlite.prepare(
      "SELECT COUNT(*) AS count FROM guest_links",
    ).get()).toEqual({ count: 0 });

    await expect(cleanupAuthRecords(db, cleanupTime)).resolves.toMatchObject({
      guestUsers: 1,
    });
    expect(sqlite.prepare(
      "SELECT user_id FROM users WHERE user_id = ?",
    ).get(guest.user_id)).toBeUndefined();
  });
  it("optionally requires a matching Cloudflare Access assertion for admin",async()=>{const db=database(),baseEnv={AUTH_ADMIN_EMAILS:"owner@example.com"};const user=await createOrLinkUser(db,baseEnv,{provider:"test",subject:"owner",email:"owner@example.com",displayName:"Owner"});const session=await issueSession(db,baseEnv,user,new Request("https://example.test"));const request=new Request("https://example.test/admin",{headers:{cookie:`stowplan_session=${session.raw}`}});expect((await authorizeAdmin(db,baseEnv,request)).userId).toBe(user.userId);await expect(authorizeAdmin(db,{...baseEnv,AUTH_ADMIN_REQUIRE_ACCESS:"true"},request)).rejects.toMatchObject({status:403} satisfies Partial<AuthorizationError>)});
  it("rejects cross-origin browser mutations while supporting trusted proxy origins",()=>{expect(isTrustedMutation(new Request("https://example.test/api/sync",{method:"POST"}))).toBe(true);expect(isTrustedMutation(new Request("https://example.test/api/sync",{method:"POST",headers:{origin:"https://evil.test"}}))).toBe(false);expect(isTrustedMutation(new Request("http://internal:3000/api/sync",{method:"POST",headers:{origin:"https://stowplan.example","x-forwarded-host":"stowplan.example","x-forwarded-proto":"https"}}))).toBe(true);expect(isTrustedMutation(new Request("http://internal:3000/api/sync",{method:"POST",headers:{origin:"https://stowplan.example"}}),"https://stowplan.example")).toBe(true)});
});
