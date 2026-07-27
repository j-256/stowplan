import { describe, expect, it } from "vitest";
import {
  backupNotice,
  backupPresentation,
} from "../src/client/backup-presentation";

const BASE_PRESENTATION = Object.freeze({
  accessStatus: "active" as const,
  authenticationReady: true,
  backupConfigured: true,
  blocked: 0,
  lastSyncError: null,
  lastSyncedAt: null,
  online: true,
  pending: 0,
  serverBacked: false,
  signedIn: false,
  syncing: false,
});

describe("backup presentation", () => {
  it("presents signed-out device work as optional local storage", () => {
    const options = {
      ...BASE_PRESENTATION,
      pending: 2,
    };

    expect(backupPresentation(options)).toEqual({
      deviceOnly: true,
      label: "2 changes saved on this device",
      state: "pending",
    });
    expect(backupNotice(options)).toBeNull();
  });

  it("makes interrupted server backup prominent without hiding local safety", () => {
    const options = {
      ...BASE_PRESENTATION,
      lastSyncedAt: "2026-07-26T12:00:00.000Z",
      serverBacked: true,
    };

    expect(backupPresentation(options)).toEqual({
      label: "Remote backup paused",
      state: "blocked",
    });
    expect(backupNotice(options)).toEqual({
      action: "account",
      message:
        "Your Stowplan session ended. Sign in again to resume remote backup and collaboration. Local work is still safe on this device.",
      title: "Remote backup paused",
    });
  });

  it("keeps genuine backup failures loud and recovery-focused", () => {
    const options = {
      ...BASE_PRESENTATION,
      lastSyncError: "Backup service unavailable",
      serverBacked: true,
      signedIn: true,
    };

    expect(backupPresentation(options)).toEqual({
      label: "Backup failed",
      state: "blocked",
    });
    expect(backupNotice(options)).toEqual({
      action: "recovery",
      message: "Backup service unavailable",
      title: "Backup needs attention",
    });
  });

  it("does not promise sign-in recovery for ended workspace access", () => {
    const options = {
      ...BASE_PRESENTATION,
      accessStatus: "revoked" as const,
      serverBacked: true,
    };

    expect(backupPresentation(options)).toEqual({
      deviceOnly: true,
      label: "Access removed",
      state: "local",
      terminal: true,
    });
    expect(backupNotice(options)).toBeNull();
  });

  it("does not flash a stale sign-in error while authentication resolves", () => {
    const options = {
      ...BASE_PRESENTATION,
      accessStatus: "active" as const,
      authenticationReady: false,
      lastSyncError: "Sign in to back up this workspace.",
      lastSyncedAt: "2026-07-26T12:00:00.000Z",
      serverBacked: true,
    };

    expect(backupPresentation(options)).toEqual({
      label: "Backed up online",
      state: "synced",
    });
    expect(backupNotice(options)).toBeNull();
  });

  it("surfaces refused work when workspace access is unconfirmed", () => {
    const options = {
      ...BASE_PRESENTATION,
      accessStatus: "unknown" as const,
      authenticationReady: false,
      lastSyncError: "The signed-in account changed; queued work was not sent",
      lastSyncedAt: "2026-07-26T12:00:00.000Z",
      pending: 1,
      serverBacked: true,
      signedIn: true,
    };

    expect(backupNotice(options)).toEqual({
      action: "recovery",
      message: "The signed-in account changed; queued work was not sent",
      title: "Backup needs attention",
    });
  });

  it("keeps refused changes ahead of an ended session", () => {
    const options = {
      ...BASE_PRESENTATION,
      accessStatus: "active" as const,
      blocked: 1,
      lastSyncError: "Viewer access cannot write workspace changes",
      serverBacked: true,
    };

    expect(backupNotice(options)).toEqual({
      action: "recovery",
      message: "Viewer access cannot write workspace changes",
      title: "Backup needs attention",
    });
  });
});
