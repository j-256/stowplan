import { describe, expect, it } from "vitest";
import {
  mergeWorkspaceHub,
  workspaceHubCardMatches,
} from "../src/client/workspace-hub-state";
import type { LocalWorkspaceSummary } from "../src/client/local-replica";
import {
  capabilitiesForWorkspaceRole,
  deviceOnlyWorkspaceAccess,
  serverWorkspaceAccess,
  type ServerWorkspaceSummary,
  type WorkspaceRole,
} from "../src/domain/workspace-access";

function local(
  id: string,
  options: Partial<LocalWorkspaceSummary> = {},
): LocalWorkspaceSummary {
  return {
    authorization: deviceOnlyWorkspaceAccess(),
    blocked: 0,
    changes: [],
    id,
    lastSyncAttemptAt: null,
    lastSyncError: null,
    lastSyncedAt: null,
    name: `Local ${id}`,
    pending: 0,
    revision: 0,
    serverSummary: null,
    updatedAt: "2026-07-25T00:00:00.000Z",
    ...options,
  };
}

function server(
  id: string,
  role: WorkspaceRole = "editor",
  options: Partial<ServerWorkspaceSummary> = {},
): ServerWorkspaceSummary {
  return {
    accessRevision: 2,
    capabilities: capabilitiesForWorkspaceRole(role, true),
    id,
    membershipRevision: 4,
    name: `Server ${id}`,
    revision: 0,
    role,
    updatedAt: "2026-07-25T01:00:00.000Z",
    ...options,
  };
}

describe("workspace hub state", () => {
  it("merges device and server summaries into one stable card", () => {
    const remote = server("ws_shared", "viewer", {
      name: "Server name",
      revision: 3,
    });
    const cards = mergeWorkspaceHub([
      local("ws_shared", {
        authorization: serverWorkspaceAccess("viewer", {
          accessRevision: remote.accessRevision,
          membershipRevision: remote.membershipRevision,
        }),
        name: "Local pending name",
        revision: 3,
        serverSummary: remote,
      }),
    ], [remote, remote], { online: true });

    expect(cards).toHaveLength(1);
    expect(cards[0]).toMatchObject({
      id: "ws_shared",
      localName: "Local pending name",
      name: "Server name",
      presence: "local-and-server",
      role: "viewer",
      serverName: "Server name",
      state: "synchronized",
    });
  });

  it("distinguishes device-only, server-only, and offline cards", () => {
    const remote = server("ws_remote");
    const online = mergeWorkspaceHub(
      [local("ws_device")],
      [remote],
      { online: true },
    );
    const offline = mergeWorkspaceHub([], [remote], { online: false });

    expect(online.map((card) => [card.id, card.state]).sort()).toEqual([
      ["ws_device", "device-only"],
      ["ws_remote", "server-only"],
    ]);
    expect(offline[0]).toMatchObject({
      presence: "server-only",
      state: "offline",
    });
  });

  it("prioritizes blocked and pending local work over revision labels", () => {
    const remote = server("ws_shared", "editor", { revision: 8 });
    const blocked = mergeWorkspaceHub([
      local("ws_shared", {
        blocked: 1,
        pending: 2,
        revision: 5,
        serverSummary: remote,
      }),
    ], [remote], { online: true });
    const pending = mergeWorkspaceHub([
      local("ws_shared", {
        pending: 2,
        revision: 5,
        serverSummary: remote,
      }),
    ], [remote], { online: true });

    expect(blocked[0]?.state).toBe("blocked");
    expect(pending[0]?.state).toBe("pending-upload");
  });

  it("shows confirmed local and server revision differences honestly", () => {
    expect(mergeWorkspaceHub([
      local("ws_local", {
        revision: 9,
        serverSummary: server("ws_local", "editor", { revision: 7 }),
      }),
    ], [], { online: true })[0]?.state).toBe("locally-newer");
    const serverNewer = mergeWorkspaceHub([
      local("ws_server", {
        name: "Stale local name",
        revision: 4,
        serverSummary: server("ws_server", "editor", {
          name: "Current server name",
          revision: 6,
        }),
      }),
    ], [], { online: true })[0];
    expect(serverNewer).toMatchObject({
      name: "Current server name",
      state: "server-newer",
    });
  });

  it("keeps revoked local copies visible but unavailable", () => {
    const cards = mergeWorkspaceHub([
      local("ws_revoked", {
        authorization: serverWorkspaceAccess("editor", {
          accessRevision: 8,
          membershipRevision: 10,
          status: "revoked",
        }),
        name: "Retained copy",
      }),
    ], [], { online: true });

    expect(cards[0]).toMatchObject({
      name: "Retained copy",
      presence: "local-only",
      state: "unavailable",
    });
    expect(cards[0]?.capabilities.write).toBe(false);
  });

  it("does not present a retained deleted replica as a server copy", () => {
    const priorServerSummary = server("ws_deleted", "owner", {
      revision: 7,
    });
    const cards = mergeWorkspaceHub([
      local("ws_deleted", {
        authorization: serverWorkspaceAccess("owner", {
          accessRevision: 9,
          membershipRevision: 11,
          status: "deleted",
        }),
        name: "Retained deleted copy",
        revision: 7,
        serverSummary: priorServerSummary,
      }),
    ], [priorServerSummary], { online: true });

    expect(cards[0]).toMatchObject({
      name: "Retained deleted copy",
      presence: "local-only",
      role: null,
      serverRevision: null,
      state: "unavailable",
    });
  });

  it("does not expose another account's cached role in the hub", () => {
    const firstSummary = server("ws_account", "owner", {
      accountId: "user_a",
      accessRevision: 9,
      membershipRevision: 12,
    });
    const secondSummary = server("ws_account", "viewer", {
      accountId: "user_b",
      accessRevision: 1,
      membershipRevision: 2,
    });
    const cards = mergeWorkspaceHub([
      local("ws_account", {
        authorization: serverWorkspaceAccess("owner", {
          accountId: "user_a",
          accessRevision: 9,
          membershipRevision: 12,
        }),
        serverSummary: firstSummary,
      }),
    ], [secondSummary], {
      accountId: "user_b",
      online: true,
    });

    expect(cards).toHaveLength(1);
    expect(cards[0]).toMatchObject({
      role: "viewer",
      serverName: "Server ws_account",
    });
    expect(cards[0]?.capabilities).toMatchObject({
      manageAccess: false,
      write: false,
    });
  });

  it("keeps the newest duplicate server summary deterministically", () => {
    const stale = server("ws_shared", "viewer", {
      accessRevision: 2,
      membershipRevision: 4,
      name: "Stale",
      revision: 2,
    });
    const fresh = server("ws_shared", "owner", {
      accessRevision: 5,
      membershipRevision: 7,
      name: "Fresh",
      revision: 6,
    });
    const cards = mergeWorkspaceHub([], [fresh, stale], { online: true });

    expect(cards).toHaveLength(1);
    expect(cards[0]).toMatchObject({
      name: "Fresh",
      role: "owner",
      serverRevision: 6,
    });
    expect(workspaceHubCardMatches(cards[0]!, "OWNER")).toBe(true);
    expect(workspaceHubCardMatches(cards[0]!, "missing")).toBe(false);
  });

  it("uses an authoritative equal-version summary for dynamic capabilities", () => {
    const cached = server("ws_shared", "owner", {
      capabilities: capabilitiesForWorkspaceRole("owner", true),
    });
    const capabilities = capabilitiesForWorkspaceRole("owner", false);
    const refreshed = server("ws_shared", "owner", { capabilities });
    const cards = mergeWorkspaceHub([
      local("ws_shared", { serverSummary: cached }),
    ], [refreshed], { online: true });

    expect(cards[0]?.capabilities).toEqual(capabilities);
  });
});
