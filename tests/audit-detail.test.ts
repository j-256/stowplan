import { describe, expect, it } from "vitest";
import {
  safeAuditDetailJson,
  safeStoredAuditDetailJson,
} from "../src/server/audit-detail";

describe("audit detail privacy", () => {
  it("preserves only action-approved operational fields", () => {
    const safe = JSON.parse(safeAuditDetailJson(
      "workspace.inspect",
      {
        accessAssertion: "private assertion",
        accessRevision: 4,
        nested: {
          inviteHash: "private invite hash",
          rawToken: "private token",
        },
        payload: "private unclassified value",
        snapshotRevision: 9,
        workspaceId: "ws_safe",
      },
    )) as Record<string, unknown>;

    expect(safe).toEqual({
      accessRevision: 4,
      redactedFieldCount: 3,
      snapshotRevision: 9,
      workspaceId: "ws_safe",
    });
    expect(JSON.stringify(safe)).not.toContain("private");
  });

  it("redacts invalid values even when their field is action-approved", () => {
    expect(JSON.parse(safeAuditDetailJson(
      "workspace.inspect",
      {
        snapshotRevision: "raw-session-or-guest-secret",
        workspaceId: 42,
      },
    ))).toEqual({
      snapshotRevision: "[redacted]",
      workspaceId: "[redacted]",
    });
  });

  it("never returns malformed historical detail verbatim", () => {
    const malformed = "token=private malformed detail";
    const safe = safeStoredAuditDetailJson(
      "workspace.inspect",
      malformed,
    );

    expect(safe).toContain("could not be parsed");
    expect(safe).not.toContain(malformed);
  });

  it.each([
    JSON.stringify("raw-session-or-guest-secret"),
    JSON.stringify(["oauth-code-or-token"]),
    JSON.stringify(null),
  ])("withholds non-object historical roots", (stored) => {
    const safe = safeStoredAuditDetailJson("workspace.inspect", stored);

    expect(safe).toContain("not stored as an object");
    expect(safe).not.toContain("secret");
    expect(safe).not.toContain("token");
  });

  it("withholds fields from unknown historical actions", () => {
    const safe = JSON.parse(safeStoredAuditDetailJson(
      "future.unknown",
      JSON.stringify({
        payload: "raw-session-or-guest-secret",
        workspaceId: "ws_visible_only_for_known_actions",
      }),
    )) as Record<string, unknown>;

    expect(safe).toEqual({
      redactedFieldCount: 2,
      unavailable: "Audit detail is not available for this action",
    });
    expect(JSON.stringify(safe)).not.toContain("raw-session");
    expect(JSON.stringify(safe)).not.toContain("ws_visible");
  });

  it("does not treat inherited object names as approved fields", () => {
    const stored =
      '{"__proto__":"private prototype","constructor":"private constructor",' +
      '"toString":"private stringifier","workspaceId":"ws_safe"}';
    const safe = JSON.parse(safeStoredAuditDetailJson(
      "workspace.inspect",
      stored,
    )) as Record<string, unknown>;

    expect(safe).toEqual({
      redactedFieldCount: 3,
      workspaceId: "ws_safe",
    });
    expect(JSON.stringify(safe)).not.toContain("private");
  });
});
