import { describe, expect, it } from "vitest";
import {
  canUseLocalRecoveryWrite,
  canUseRecoveryCapability,
  parseAuthorizedRecoverySnapshot,
  recoveryCommandLabel,
} from "../src/client/recovery-permissions";
import { applyCommand } from "../src/domain/commands";
import {
  createEmptyState,
  createEnvelope,
} from "../src/domain/factories";
import {
  capabilitiesForWorkspaceRole,
  serverWorkspaceAccess,
} from "../src/domain/workspace-access";

const ACCOUNT_ID = "user_recovery_owner";

function snapshotResponse(role: "owner" | "editor" | "viewer") {
  const state = createEmptyState("Recovery permissions");
  const capabilities = capabilitiesForWorkspaceRole(role, true);
  return {
    authorization: serverWorkspaceAccess(role, {
      accessRevision: 7,
      canLeave: true,
      checkedAt: "2026-07-25T00:00:00.000Z",
      membershipRevision: 4,
    }),
    state,
    workspace: {
      accessRevision: 7,
      capabilities,
      id: state.workspace.id,
      membershipRevision: 4,
      name: state.workspace.name,
      revision: state.workspace.revision,
      role,
      updatedAt: state.workspace.updatedAt,
    },
  };
}

describe("recovery permissions", () => {
  it("preserves an owner snapshot authorization without a local replica", () => {
    const payload = snapshotResponse("owner");
    const snapshot = parseAuthorizedRecoverySnapshot(
      payload,
      payload.state.workspace.id,
      ACCOUNT_ID,
    );

    expect(snapshot.authorization).toMatchObject({
      accountId: ACCOUNT_ID,
      kind: "server",
      role: "owner",
      status: "active",
    });
    expect(snapshot.workspace.accountId).toBe(ACCOUNT_ID);
    expect(
      canUseRecoveryCapability(
        snapshot,
        ACCOUNT_ID,
        true,
        "manageAccess",
      ),
    ).toBe(true);
  });

  it.each(["editor", "viewer"] as const)(
    "keeps matching restore disabled for a %s",
    role => {
      const payload = snapshotResponse(role);
      const snapshot = parseAuthorizedRecoverySnapshot(
        payload,
        payload.state.workspace.id,
        ACCOUNT_ID,
      );

      expect(
        canUseRecoveryCapability(
          snapshot,
          ACCOUNT_ID,
          true,
          "manageAccess",
        ),
      ).toBe(false);
    },
  );

  it("fails closed while authentication is unknown or belongs to another account", () => {
    const payload = snapshotResponse("owner");
    const snapshot = parseAuthorizedRecoverySnapshot(
      payload,
      payload.state.workspace.id,
      ACCOUNT_ID,
    );

    expect(
      canUseRecoveryCapability(
        snapshot,
        ACCOUNT_ID,
        false,
        "manageAccess",
      ),
    ).toBe(false);
    expect(
      canUseRecoveryCapability(
        snapshot,
        "user_other",
        true,
        "manageAccess",
      ),
    ).toBe(false);
    expect(
      canUseLocalRecoveryWrite(
        {
          authorization: snapshot.authorization,
          outbox: [],
          state: snapshot.state,
          updatedAt: snapshot.state.workspace.updatedAt,
        },
        "user_other",
        true,
      ),
    ).toBe(false);
  });

  it("rejects missing, mismatched, or inconsistent snapshot authorization", () => {
    const payload = snapshotResponse("owner");
    expect(() =>
      parseAuthorizedRecoverySnapshot(
        { state: payload.state },
        payload.state.workspace.id,
        ACCOUNT_ID,
      ),
    ).toThrow(/incomplete workspace access/);
    expect(() =>
      parseAuthorizedRecoverySnapshot(
        payload,
        "ws_other",
        ACCOUNT_ID,
      ),
    ).toThrow(/inconsistent workspace access/);
    expect(() =>
      parseAuthorizedRecoverySnapshot(
        {
          ...payload,
          workspace: {
            ...payload.workspace,
            role: "viewer",
          },
        },
        payload.state.workspace.id,
        ACCOUNT_ID,
      ),
    ).toThrow(/inconsistent workspace access/);
  });

  it.each([
    {
      change: (payload: ReturnType<typeof snapshotResponse>) => ({
        ...payload,
        workspace: {
          ...payload.workspace,
          name: "Different summary name",
        },
      }),
      label: "summary name",
    },
    {
      change: (payload: ReturnType<typeof snapshotResponse>) => ({
        ...payload,
        workspace: {
          ...payload.workspace,
          revision: payload.workspace.revision + 1,
        },
      }),
      label: "summary revision",
    },
    {
      change: (payload: ReturnType<typeof snapshotResponse>) => ({
        ...payload,
        authorization: {
          ...payload.authorization,
          capabilities: {
            ...payload.authorization.capabilities,
            write: false,
          },
        },
      }),
      label: "authorization capabilities",
    },
  ])("rejects an inconsistent $label", ({ change }) => {
    const payload = snapshotResponse("owner");

    expect(() =>
      parseAuthorizedRecoverySnapshot(
        change(payload),
        payload.state.workspace.id,
        ACCOUNT_ID,
      ),
    ).toThrow(/inconsistent workspace access/);
  });

  it("rejects capabilities that normalization would silently reduce", () => {
    const payload = snapshotResponse("viewer");
    const writeCapabilities = {
      ...payload.workspace.capabilities,
      write: true,
    };

    expect(() =>
      parseAuthorizedRecoverySnapshot(
        {
          ...payload,
          authorization: {
            ...payload.authorization,
            capabilities: writeCapabilities,
          },
          workspace: {
            ...payload.workspace,
            capabilities: writeCapabilities,
          },
        },
        payload.state.workspace.id,
        ACCOUNT_ID,
      ),
    ).toThrow(/inconsistent workspace access/);
  });

  it("rejects snapshot metadata scoped to another account", () => {
    const payload = snapshotResponse("owner");

    expect(() =>
      parseAuthorizedRecoverySnapshot(
        {
          ...payload,
          authorization: {
            ...payload.authorization,
            accountId: "user_other",
          },
        },
        payload.state.workspace.id,
        ACCOUNT_ID,
      ),
    ).toThrow(/another account/);
  });

  it("shows the human activity label for blocked work", () => {
    const initial = createEmptyState("Recovery labels");
    const envelope = createEnvelope(
      initial,
      {
        name: "Recovered workspace name",
        type: "workspace.rename",
      },
      { id: "cmd_recovery_label" },
    );
    const state = applyCommand(initial, envelope).state;
    const entry = {
      envelope,
      error: "Viewer access no longer permits this change",
      status: "blocked" as const,
    };

    expect(
      recoveryCommandLabel(
        {
          outbox: [entry],
          state,
          updatedAt: envelope.timestamp,
        },
        entry,
      ),
    ).toContain("Recovered workspace name");
  });
});
