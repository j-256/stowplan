import { readFileSync } from "node:fs";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { createEmptyState } from "../src/domain/factories";
import { D1SnapshotStore, type D1DatabaseLike } from "../src/adapters/d1-snapshot-store";
import { authenticate, claimWorkspace, consumeGuestLink, createGuestLink, createOrLinkUser, issueSession, revokeCurrentSession } from "../src/server/auth";

function database(): D1DatabaseLike {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec(readFileSync(new URL("../migrations/0001_initial.sql", import.meta.url), "utf8"));
  return { prepare(sql:string){const statement=sqlite.prepare(sql);const wrapped=(values:unknown[]=[]):ReturnType<D1DatabaseLike["prepare"]>=>({bind(...next:unknown[]){return wrapped(next)},first:async()=>statement.get(...values as SQLInputValue[]) as never,run:async()=>{const result=statement.run(...values as SQLInputValue[]);return{success:true,meta:{changes:Number(result.changes)}}}});return wrapped()} };
}

describe("authentication",()=>{
  it("links identities, issues opaque sessions, and revokes them",async()=>{const db=database(),env={AUTH_ADMIN_EMAILS:"owner@example.com"};const user=await createOrLinkUser(db,env,{provider:"test",subject:"one",email:"OWNER@example.com",displayName:"Owner"});expect(user.globalRole).toBe("admin");const request=new Request("https://example.test",{headers:{"user-agent":"test"}}),session=await issueSession(db,env,user,request);expect(session.raw).toHaveLength(64);const authenticated=await authenticate(db,new Request("https://example.test",{headers:{cookie:`stowplan_session=${session.raw}`}}));expect(authenticated?.email).toBe("owner@example.com");await revokeCurrentSession(db,new Request("https://example.test",{headers:{cookie:`stowplan_session=${session.raw}`}}));expect(await authenticate(db,new Request("https://example.test",{headers:{cookie:`stowplan_session=${session.raw}`}}))).toBeNull()});
  it("consumes a guest link once and creates a short session",async()=>{const db=database(),env={};const state=createEmptyState("Guest test");await new D1SnapshotStore(db).initialize(state);const owner=await createOrLinkUser(db,env,{provider:"test",subject:"owner",email:"owner@example.com",displayName:"Owner"});await claimWorkspace(db,owner.userId,state.workspace.id);const link=await createGuestLink(db,state.workspace.id,owner.userId,"editor",1),result=await consumeGuestLink(db,env,link.raw,new Request("https://example.test"));expect(result.workspaceId).toBe(state.workspace.id);await expect(consumeGuestLink(db,env,link.raw,new Request("https://example.test"))).rejects.toThrow(/invalid|used/)});
});
