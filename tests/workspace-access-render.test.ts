import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  GUEST_LINK_MAXIMUM_EXPIRY_HOURS,
  GUEST_LINK_MINIMUM_EXPIRY_HOURS,
  RetainedWorkspaceAccess,
  WorkspaceAccess,
  isShareCancellation,
  matchesWorkspaceDeletionConfirmation,
  validGuestLinkExpiry,
  type WorkspaceAccessActions,
  type WorkspaceAccessData,
  type WorkspaceGuestLink,
  type WorkspaceMember,
} from "../src/client/workspace-access";
import {
  persistConfirmedTerminalAccess,
  TERMINAL_ACCESS_PERSISTENCE_WARNING,
  visibleWorkspaceAccessData,
} from "../src/client/workspace-access-controller";
import { ReadOnlyWorkspace } from "../src/client/read-only-workspace";
import {
  applyConfirmedTerminalAccessInMemory,
} from "../src/client/store";
import { createDemoState } from "../src/domain/demo";
import {
  capabilitiesForWorkspaceRole,
  serverWorkspaceAccess,
} from "../src/domain/workspace-access";

const owner: WorkspaceMember = {
  createdAt: "2026-07-25T00:00:00.000Z",
  displayName: "Owner Person",
  email: "owner@example.test",
  identityKind: "account",
  membershipRevision: 4,
  role: "owner",
  userId: "user_owner",
};

const editor: WorkspaceMember = {
  createdAt: "2026-07-25T00:01:00.000Z",
  displayName: "Editor Person",
  email: "editor@example.test",
  identityKind: "account",
  membershipRevision: 5,
  role: "editor",
  userId: "user_editor",
};

const guestLinks: WorkspaceGuestLink[] = [
  {
    createdAt: "2026-07-25T04:00:00.000Z",
    expiresAt: "2026-07-26T04:00:00.000Z",
    guestLinkId: "guest_active",
    revokedAt: null,
    role: "viewer",
    status: "active",
    usedAt: null,
  },
  {
    createdAt: "2026-07-25T03:00:00.000Z",
    expiresAt: "2026-07-26T03:00:00.000Z",
    guestLinkId: "guest_used",
    revokedAt: null,
    role: "editor",
    status: "used",
    usedAt: "2026-07-25T03:05:00.000Z",
  },
  {
    createdAt: "2026-07-25T02:00:00.000Z",
    expiresAt: "2026-07-25T02:30:00.000Z",
    guestLinkId: "guest_expired",
    revokedAt: null,
    role: "viewer",
    status: "expired",
    usedAt: null,
  },
  {
    createdAt: "2026-07-25T01:00:00.000Z",
    expiresAt: "2026-07-26T01:00:00.000Z",
    guestLinkId: "guest_revoked",
    revokedAt: "2026-07-25T01:30:00.000Z",
    role: "editor",
    status: "revoked",
    usedAt: null,
  },
];

function accessData(role: "owner" | "editor" | "viewer"): WorkspaceAccessData {
  return {
    access: {
      accessRevision: 7,
      capabilities: capabilitiesForWorkspaceRole(role, true),
      membershipRevision: 4,
      role,
    },
    guestLinkPolicy: {
      maximumExpiryHours: GUEST_LINK_MAXIMUM_EXPIRY_HOURS,
      minimumExpiryHours: GUEST_LINK_MINIMUM_EXPIRY_HOURS,
      roles: ["viewer", "editor"],
    },
    ...(role === "owner"
      ? {
          usage: {
            activeGuestLinks: { limit: 10, used: 1 },
            members: { limit: 25, used: 2 },
            owners: 2,
            retainedGuestLinks: { limit: 50, used: 4 },
          },
        }
      : {}),
    workspace: {
      accessRevision: 7,
      capabilities: capabilitiesForWorkspaceRole(role, true),
      id: "ws_shared",
      membershipRevision: 4,
      name: "Shared home",
      revision: 9,
      role,
      updatedAt: "2026-07-25T05:00:00.000Z",
    },
  };
}

const actions = {
  changeMemberRole: async (_userId, input) => ({
    accessRevision: input.expectedAccessRevision + 1,
    member: { ...editor, role: input.role },
  }),
  createGuestLink: async (input) => ({
    accessRevision: input.expectedAccessRevision + 1,
    guestLink: guestLinks[0]!,
    oneTimeUrl: "https://example.test/guest/one-time",
  }),
  deleteServerWorkspace: async (input) => ({
    deleted: true as const,
    deletedAt: "2026-07-25T06:00:00.000Z",
    deletionId: "deletion_1",
    finalAccessRevision: input.expectedAccessRevision + 1,
    finalSnapshotRevision: input.expectedRevision,
    localReplicaDispositionRequired: true as const,
    recovery: "not_available" as const,
    workspaceId: "ws_shared",
  }),
  exportLocalRecovery: async () => undefined,
  filterGuestLinks: async () => undefined,
  leaveWorkspace: async (input) => ({
    accessRevision: input.expectedAccessRevision + 1,
    left: true as const,
    localReplicaDispositionRequired: true as const,
    membershipRevision: input.expectedMembershipRevision + 1,
    workspaceId: "ws_shared",
  }),
  loadMoreGuestLinks: async () => undefined,
  loadMoreMembers: async () => undefined,
  refresh: async () => undefined,
  removeLocalReplica: async () => undefined,
  removeMember: async (userId, input) => ({
    accessRevision: input.expectedAccessRevision + 1,
    removed: {
      at: "2026-07-25T06:00:00.000Z",
      role: editor.role,
      userId,
    },
  }),
  revokeGuestLink: async (_guestLinkId, input) => ({
    accessRevision: input.expectedAccessRevision + 1,
    guestLink: { ...guestLinks[0]!, status: "revoked" as const },
  }),
  searchMembers: async () => undefined,
  transferOwnership: async (input) => ({
    accessRevision: input.expectedAccessRevision + 1,
    actor: { ...owner, role: "editor" as const },
    target: { ...editor, role: "owner" as const },
  }),
} satisfies WorkspaceAccessActions;

describe("workspace access surface", () => {
  it("describes a retained terminal copy without calling it viewer access", () => {
    const reason =
      "The server workspace was deleted. This retained device copy is read-only.";
    const markup = renderToStaticMarkup(
      createElement(ReadOnlyWorkspace, {
        inventoryItemId: null,
        inventoryLocationId: null,
        onInventoryItemChange: () => undefined,
        onInventoryLocationChange: () => undefined,
        onLocationChange: () => undefined,
        onOpenWorkspaceMenu: () => undefined,
        readOnlyReason: reason,
        selectedLocationId: null,
        setTheme: () => undefined,
        state: createDemoState(),
        theme: "system",
        view: "settings",
        viewer: false,
      }),
    );

    expect(markup).toContain(reason);
    expect(markup).toContain("retained read-only copy");
    expect(markup).not.toContain("Viewer access keeps");
    expect(markup).not.toContain("unavailable to viewers");
    expect(markup).not.toContain(">Workspace access</a>");
  });

  it("keeps workspace access available in active viewer settings", () => {
    const markup = renderToStaticMarkup(
      createElement(ReadOnlyWorkspace, {
        inventoryItemId: null,
        inventoryLocationId: null,
        onInventoryItemChange: () => undefined,
        onInventoryLocationChange: () => undefined,
        onLocationChange: () => undefined,
        onOpenWorkspaceMenu: () => undefined,
        readOnlyReason:
          "Viewer access allows browsing and export, but not editing.",
        selectedLocationId: null,
        setTheme: () => undefined,
        state: createDemoState(),
        theme: "system",
        view: "settings",
        viewer: true,
      }),
    );

    expect(markup).toContain(">Workspace access</a>");
  });

  it.each([
    ["deleted", "Server workspace deleted"],
    ["left", "Server membership ended"],
    ["revoked", "Workspace access removed"],
    ["unknown", "Workspace access unavailable"],
  ] as const)(
    "renders an honest retained-copy panel for %s access",
    (status, heading) => {
      const markup = renderToStaticMarkup(
        createElement(RetainedWorkspaceAccess, {
          onOpenWorkspaceHub: () => undefined,
          status,
        }),
      );

      expect(markup).toContain(heading);
      expect(markup).toContain("Retained device copy");
      expect(markup).toContain("Read-only copy retained");
      expect(markup).toContain("Workspaces and backup status");
      expect(markup).not.toContain("Refresh access");
      expect(markup).not.toContain("Owner role");
      expect(markup).not.toContain("Editor role");
      expect(markup).not.toContain("Viewer role");
      expect(markup).not.toContain(">Workspace access</a>");
    },
  );

  it.each(["deleted", "left", "revoked", "unknown"] as const)(
    "does not reuse loaded owner data after %s authorization",
    (status) => {
      const data = accessData("owner");

      expect(visibleWorkspaceAccessData(
        data,
        serverWorkspaceAccess("owner", {
          accountId: owner.userId,
          accessRevision: data.access.accessRevision + 1,
          membershipRevision: data.access.membershipRevision + 1,
          status,
        }),
        owner.userId,
      )).toBeNull();
    },
  );

  it("renders owner member, guest, pagination, and lifecycle controls", () => {
    const markup = renderToStaticMarkup(
      createElement(WorkspaceAccess, {
        actions,
        currentUserId: owner.userId,
        data: accessData("owner"),
        guestLinkResult: {
          accessRevision: 7,
          guestLinks,
          page: {
            hasMore: true,
            limit: 25,
            nextCursor: "next-guests",
          },
        },
        memberResult: {
          accessRevision: 7,
          members: [owner, editor],
          page: {
            hasMore: true,
            limit: 25,
            nextCursor: "next-members",
          },
        },
        returnTo: "/workspaces/shared-home@ws_shared/access",
      }),
    );

    expect(markup).toContain("Members");
    expect(markup).toContain("Transfer ownership");
    expect(markup).toContain("Create invite link");
    expect(markup).toContain('min="1"');
    expect(markup).toContain('max="168"');
    expect(markup).toContain("Active");
    expect(markup).toContain("Used");
    expect(markup).toContain("Expired");
    expect(markup).toContain("Revoked");
    expect(markup).toContain("Load more members");
    expect(markup).toContain("Load more invite links");
    expect(markup).toContain(">Delete server workspace</button>");
    expect(markup).not.toContain("https://example.test/guest/one-time");
  });

  it.each(["editor", "viewer"] as const)(
    "renders honest %s access without owner controls",
    (role) => {
      const markup = renderToStaticMarkup(
        createElement(WorkspaceAccess, {
          actions,
          currentUserId: owner.userId,
          data: accessData(role),
          guestLinkResult: {
            accessRevision: 7,
            guestLinks,
            page: {
              hasMore: false,
              limit: 25,
              nextCursor: null,
            },
          },
          memberResult: {
            accessRevision: 7,
            members: [owner, editor],
            page: {
              hasMore: false,
              limit: 25,
              nextCursor: null,
            },
          },
        }),
      );

      expect(markup).toContain(`${role[0].toUpperCase()}${role.slice(1)} role`);
      expect(markup).toContain("Access management is owner-only");
      expect(markup).toContain(">Leave shared workspace</button>");
      expect(markup).not.toContain("Create invite link");
      expect(markup).not.toContain(">Delete server workspace</button>");
      expect(markup).not.toContain(owner.email);
      expect(markup).not.toContain(editor.email);
    },
  );

  it.each(["deleted", "left"] as const)(
    "removes stale owner and refresh presentation during local %s completion",
    (terminalStatus) => {
      const markup = renderToStaticMarkup(
        createElement(WorkspaceAccess, {
          actions,
          currentUserId: owner.userId,
          data: accessData("owner"),
          guestLinkResult: null,
          memberResult: null,
          terminalStatus,
        }),
      );

      expect(markup).toContain(terminalStatus === "left"
        ? "Server membership ended"
        : "Server workspace deleted");
      expect(markup).toContain("retained device copy is read-only");
      expect(markup).not.toContain("Owner role");
      expect(markup).not.toContain("Refresh access");
      expect(markup).not.toContain("Current permission");
      expect(markup).not.toContain("Members");
    },
  );

  it("keeps a confirmed deletion successful when device persistence fails", async () => {
    const deletion = await actions.deleteServerWorkspace({
      confirmationName: "Shared home",
      expectedAccessRevision: 7,
      expectedMembershipRevision: 4,
      expectedRevision: 9,
    });
    const outcome = await persistConfirmedTerminalAccess(
      deletion,
      async () => {
        throw new Error("IndexedDB secret diagnostic");
      },
    );

    expect(outcome.result).toBe(deletion);
    expect(outcome.persisted).toBe(false);
    expect(outcome.warning).toBe(TERMINAL_ACCESS_PERSISTENCE_WARNING);
    expect(outcome.warning).not.toContain("secret diagnostic");
  });

  it("applies confirmed deletion to app memory before durable persistence", () => {
    const state = createDemoState();
    const authorization = serverWorkspaceAccess("owner", {
      accountId: owner.userId,
      accessRevision: 7,
      membershipRevision: 4,
    });
    const replica = {
      authorization,
      outbox: [],
      state,
      updatedAt: state.workspace.updatedAt,
    };
    const deleted = serverWorkspaceAccess("owner", {
      accountId: owner.userId,
      accessRevision: 8,
      checkedAt: "2026-07-25T06:00:00.000Z",
      membershipRevision: 5,
      status: "deleted",
    });

    const next = applyConfirmedTerminalAccessInMemory(
      replica,
      state.workspace.id,
      deleted,
    );

    expect(next).not.toBe(replica);
    expect(next?.authorization).toMatchObject({
      capabilities: {
        delete: false,
        leave: false,
        manageAccess: false,
        read: true,
        write: false,
      },
      status: "deleted",
    });
    expect(next?.state).toBe(state);
    expect(next?.outbox).toBe(replica.outbox);
    expect(replica.authorization).toBe(authorization);
    expect(applyConfirmedTerminalAccessInMemory(
      replica,
      state.workspace.id,
      authorization,
    )).toBe(replica);
  });

  it("allows a failed terminal-state write to be retried", async () => {
    let storageAvailable = false;
    let attempts = 0;
    const persist = async () => {
      attempts += 1;
      if (!storageAvailable) throw new Error("IndexedDB unavailable");
    };

    const failed = await persistConfirmedTerminalAccess(undefined, persist);
    storageAvailable = true;
    const retried = await persistConfirmedTerminalAccess(undefined, persist);

    expect(failed.persisted).toBe(false);
    expect(retried).toEqual({
      persisted: true,
      result: undefined,
      warning: null,
    });
    expect(attempts).toBe(2);
  });

  it("renders an actionable warning for an unrecorded deletion state", () => {
    const markup = renderToStaticMarkup(
      createElement(WorkspaceAccess, {
        actions,
        currentUserId: owner.userId,
        data: accessData("owner"),
        guestLinkResult: null,
        memberResult: null,
        onRetryTerminalPersistence: async () => undefined,
        terminalPersistenceWarning:
          TERMINAL_ACCESS_PERSISTENCE_WARNING,
        terminalStatus: "deleted",
      }),
    );

    expect(markup).toContain(TERMINAL_ACCESS_PERSISTENCE_WARNING);
    expect(markup).toContain("Retry saving device status");
    expect(markup).toContain('role="alert"');
    expect(markup).toContain("Server workspace deleted");
    expect(markup).not.toContain("Could not delete the server workspace");
  });

  it("applies an equal-version leave restriction without remounting", () => {
    const data = accessData("owner");
    const visibleData = visibleWorkspaceAccessData(
      data,
      serverWorkspaceAccess("owner", {
        accountId: owner.userId,
        accessRevision: data.access.accessRevision,
        canLeave: false,
        membershipRevision: data.access.membershipRevision,
      }),
      owner.userId,
    );
    expect(visibleData).not.toBeNull();
    if (!visibleData) throw new Error("Expected active owner access");
    const markup = renderToStaticMarkup(
      createElement(WorkspaceAccess, {
        actions,
        currentUserId: owner.userId,
        data: visibleData,
        guestLinkResult: null,
        memberResult: null,
      }),
    );

    expect(visibleData.access.capabilities.leave).toBe(false);
    expect(markup).not.toContain(">Leave shared workspace</button>");
    expect(markup).toContain(
      "Leaving is unavailable for this access state.",
    );
  });

  it("rejects an equal-version capability increase", () => {
    const data = accessData("owner");
    data.access.capabilities = capabilitiesForWorkspaceRole(
      "owner",
      false,
    );
    data.workspace.capabilities = capabilitiesForWorkspaceRole(
      "owner",
      false,
    );

    const visibleData = visibleWorkspaceAccessData(
      data,
      serverWorkspaceAccess("owner", {
        accountId: owner.userId,
        accessRevision: data.access.accessRevision,
        canLeave: true,
        membershipRevision: data.access.membershipRevision,
      }),
      owner.userId,
    );

    expect(visibleData).toBe(data);
    if (!visibleData) throw new Error("Expected active owner access");
    expect(visibleData.access.capabilities.leave).toBe(false);
  });

  it("validates the exact guest expiry range and share cancellation", () => {
    expect(validGuestLinkExpiry(1)).toBe(true);
    expect(validGuestLinkExpiry(168)).toBe(true);
    expect(validGuestLinkExpiry(0)).toBe(false);
    expect(validGuestLinkExpiry(169)).toBe(false);
    expect(validGuestLinkExpiry(1.5)).toBe(false);
    expect(matchesWorkspaceDeletionConfirmation(
      "Shared home",
      "Shared home",
    )).toBe(true);
    expect(matchesWorkspaceDeletionConfirmation(
      "Shared home",
      "shared home",
    )).toBe(false);
    expect(matchesWorkspaceDeletionConfirmation(
      "Shared home",
      " Shared home ",
    )).toBe(false);
    expect(isShareCancellation({ name: "AbortError" })).toBe(true);
    expect(isShareCancellation(new Error("Share failed"))).toBe(false);
  });
});
