import { describe, expect, it } from "vitest";
import {
  capabilitiesForWorkspaceRole,
  deviceOnlyWorkspaceAccess,
  hasForeignPendingWork,
  normalizeServerWorkspaceSummary,
  normalizeWorkspaceAccessState,
  requireWorkspaceWriteAccess,
  serverWorkspaceAccess,
  shouldApplyWorkspaceAccess,
  workspaceAccessForAccount,
  workspaceReadOnlyReason,
} from "../src/domain/workspace-access";

describe("workspace access", () => {
  it("derives role capabilities without granting owner-only authority", () => {
    expect(capabilitiesForWorkspaceRole("viewer")).toEqual({
      delete: false,
      leave: true,
      manageAccess: false,
      read: true,
      write: false,
    });
    expect(capabilitiesForWorkspaceRole("editor")).toEqual({
      delete: false,
      leave: true,
      manageAccess: false,
      read: true,
      write: true,
    });
    expect(capabilitiesForWorkspaceRole("owner")).toEqual({
      delete: true,
      leave: false,
      manageAccess: true,
      read: true,
      write: true,
    });
    expect(capabilitiesForWorkspaceRole("owner", true).leave).toBe(true);
  });

  it("keeps compatible legacy replicas locally owned", () => {
    expect(normalizeWorkspaceAccessState(undefined)).toEqual(
      deviceOnlyWorkspaceAccess(),
    );
    expect(() =>
      requireWorkspaceWriteAccess(normalizeWorkspaceAccessState(undefined))
    ).not.toThrow();
  });

  it("fails closed when a viewer payload forges write capabilities", () => {
    const access = normalizeWorkspaceAccessState({
      accessRevision: 4,
      capabilities: {
        delete: true,
        leave: true,
        manageAccess: true,
        read: true,
        write: true,
      },
      checkedAt: "2026-07-25T00:00:00.000Z",
      kind: "server",
      membershipRevision: 7,
      role: "viewer",
      status: "active",
    });

    expect(access.capabilities).toEqual({
      delete: false,
      leave: true,
      manageAccess: false,
      read: true,
      write: false,
    });
    expect(() => requireWorkspaceWriteAccess(access)).toThrow(
      /Viewer access/,
    );
  });

  it("retains readable recovery access after membership ends", () => {
    const access = serverWorkspaceAccess("editor", {
      accessRevision: 3,
      membershipRevision: 5,
      status: "revoked",
    });

    expect(access.capabilities).toEqual({
      delete: false,
      leave: false,
      manageAccess: false,
      read: true,
      write: false,
    });
    expect(workspaceReadOnlyReason(access)).toMatch(/access was removed/);
  });

  it("rejects stale authorization revisions and resurrection", () => {
    const active = serverWorkspaceAccess("editor", {
      accessRevision: 2,
      membershipRevision: 8,
    });
    const revoked = serverWorkspaceAccess("editor", {
      accessRevision: 3,
      membershipRevision: 9,
      status: "revoked",
    });
    const staleActive = serverWorkspaceAccess("editor", {
      accessRevision: 2,
      membershipRevision: 8,
    });

    expect(shouldApplyWorkspaceAccess(active, revoked)).toBe(true);
    expect(shouldApplyWorkspaceAccess(revoked, staleActive)).toBe(false);
    expect(shouldApplyWorkspaceAccess(revoked, {
      ...revoked,
      status: "active",
    })).toBe(false);
  });
  it("accepts only restrictive changes when revisions are tied", () => {
    const editor = serverWorkspaceAccess("editor", {
      accessRevision: 3,
      membershipRevision: 8,
    });
    const viewer = serverWorkspaceAccess("viewer", {
      accessRevision: 3,
      membershipRevision: 8,
    });
    const owner = serverWorkspaceAccess("owner", {
      accessRevision: 3,
      membershipRevision: 8,
    });

    expect(shouldApplyWorkspaceAccess(editor, viewer)).toBe(true);
    expect(shouldApplyWorkspaceAccess(viewer, editor)).toBe(false);
    expect(shouldApplyWorkspaceAccess(editor, owner)).toBe(false);
    expect(shouldApplyWorkspaceAccess(editor, {
      ...editor,
      capabilities: {
        ...editor.capabilities,
        leave: false,
      },
    })).toBe(true);
    expect(shouldApplyWorkspaceAccess({
      ...editor,
      capabilities: {
        ...editor.capabilities,
        leave: false,
      },
    }, editor)).toBe(false);
    const finalOwner = serverWorkspaceAccess("owner", {
      accessRevision: 4,
      canLeave: false,
      membershipRevision: 8,
    });
    const ownerWithSuccessor = serverWorkspaceAccess("owner", {
      accessRevision: 5,
      canLeave: true,
      membershipRevision: 8,
    });
    expect(
      shouldApplyWorkspaceAccess(finalOwner, ownerWithSuccessor),
    ).toBe(true);
  });

  it("scopes cached authorization to the signed-in account", () => {
    const firstAccount = serverWorkspaceAccess("owner", {
      accountId: "user_a",
      accessRevision: 8,
      membershipRevision: 12,
    });
    const secondAccount = serverWorkspaceAccess("viewer", {
      accountId: "user_b",
      accessRevision: 1,
      membershipRevision: 2,
    });
    const unscoped = serverWorkspaceAccess("viewer", {
      accessRevision: 20,
      membershipRevision: 20,
    });

    expect(
      shouldApplyWorkspaceAccess(firstAccount, secondAccount),
    ).toBe(true);
    expect(shouldApplyWorkspaceAccess(firstAccount, unscoped)).toBe(
      false,
    );
    expect(
      workspaceAccessForAccount(firstAccount, "user_b"),
    ).toMatchObject({
      accountId: "user_b",
      capabilities: { read: true, write: false },
      role: null,
      status: "unknown",
    });
    expect(
      workspaceAccessForAccount(firstAccount, null),
    ).toEqual(firstAccount);
  });

  it("normalizes member-scoped server summaries", () => {
    expect(normalizeServerWorkspaceSummary({
      accessRevision: 11,
      capabilities: capabilitiesForWorkspaceRole("owner", true),
      id: "ws_shared",
      membershipRevision: 13,
      name: "Shared home",
      revision: 17,
      role: "owner",
      updatedAt: "2026-07-25T01:00:00.000Z",
    })).toEqual({
      accountId: null,
      accessRevision: 11,
      capabilities: capabilitiesForWorkspaceRole("owner", true),
      id: "ws_shared",
      membershipRevision: 13,
      name: "Shared home",
      revision: 17,
      role: "owner",
      updatedAt: "2026-07-25T01:00:00.000Z",
    });
    expect(normalizeServerWorkspaceSummary({
      id: "ws_private",
      name: "Private",
      role: "admin",
      updatedAt: "2026-07-25T01:00:00.000Z",
    })).toBeNull();
    expect(normalizeServerWorkspaceSummary({
      accessRevision: 1,
      capabilities: {
        delete: true,
        leave: true,
        manageAccess: true,
        read: true,
        write: true,
      },
      id: "ws_viewer",
      membershipRevision: 1,
      name: "Viewer workspace",
      revision: 1,
      role: "viewer",
      updatedAt: "2026-07-25T01:00:00.000Z",
    })?.capabilities).toEqual({
      delete: false,
      leave: true,
      manageAccess: false,
      read: true,
      write: false,
    });
  });

  describe("hasForeignPendingWork", () => {
    it("does not treat an unstamped pending entry as foreign", () => {
      // A self-authored edit enqueued before the account id is stamped carries a
      // null account. It must not read as another account's pending work, which
      // would lock the workspace read-only.
      expect(hasForeignPendingWork(
        [{ accountId: null, status: "pending" }],
        "usr_self",
      )).toBe(false);
    });

    it("treats a concretely different account as foreign", () => {
      expect(hasForeignPendingWork(
        [{ accountId: "usr_other", status: "pending" }],
        "usr_self",
      )).toBe(true);
    });

    it("ignores entries authored by the current account", () => {
      expect(hasForeignPendingWork(
        [{ accountId: "usr_self", status: "pending" }],
        "usr_self",
      )).toBe(false);
    });

    it("ignores non-pending entries even from another account", () => {
      expect(hasForeignPendingWork(
        [{ accountId: "usr_other", status: "blocked" }],
        "usr_self",
      )).toBe(false);
    });

    it("is false when there is no signed-in account", () => {
      expect(hasForeignPendingWork(
        [{ accountId: "usr_other", status: "pending" }],
        null,
      )).toBe(false);
    });
  });
});
