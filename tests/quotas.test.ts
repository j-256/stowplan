import { readdirSync, readFileSync } from "node:fs";
import { extname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { createEmptyState } from "../src/domain/factories";
import {
  assertSnapshotWithinQuotas,
  QuotaExceededError,
  quotaProblem,
  serializedJsonBytes,
  snapshotQuotaUsage,
} from "../src/server/quotas";
import {
  API_QUOTA_CODE,
  API_QUOTAS,
  GUEST_LINK_EXPIRY_HOURS,
} from "../src/shared/api-quotas";
import {
  API_QUOTA_CODE as COMMENTED_API_QUOTA_CODE,
  API_QUOTAS as COMMENTED_API_QUOTAS,
  GUEST_LINK_EXPIRY_HOURS as COMMENTED_GUEST_LINK_EXPIRY_HOURS,
} from "../src/shared/quotas.js";

const PRODUCTION_SOURCE_EXTENSIONS = new Set([
  ".js",
  ".ts",
  ".tsx",
]);

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return PRODUCTION_SOURCE_EXTENSIONS.has(extname(path)) ? [path] : [];
  });
}

describe("API quotas", () => {
  it("keeps tunable quota values in the commentable source", () => {
    expect(API_QUOTA_CODE).toBe(COMMENTED_API_QUOTA_CODE);
    expect(API_QUOTAS).toBe(COMMENTED_API_QUOTAS);
    expect(GUEST_LINK_EXPIRY_HOURS)
      .toBe(COMMENTED_GUEST_LINK_EXPIRY_HOURS);
    expect(Object.isFrozen(COMMENTED_API_QUOTAS)).toBe(true);
    expect(Object.isFrozen(COMMENTED_GUEST_LINK_EXPIRY_HOURS)).toBe(true);
    expect(Object.values(COMMENTED_API_QUOTAS).every((value) =>
      Number.isSafeInteger(value) && value > 0
    )).toBe(true);
    expect(COMMENTED_GUEST_LINK_EXPIRY_HOURS.minimum)
      .toBeLessThanOrEqual(COMMENTED_GUEST_LINK_EXPIRY_HOURS.default);
    expect(COMMENTED_GUEST_LINK_EXPIRY_HOURS.default)
      .toBeLessThanOrEqual(COMMENTED_GUEST_LINK_EXPIRY_HOURS.maximum);

    const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));
    const canonicalPath = fileURLToPath(
      new URL("../src/shared/quotas.js", import.meta.url),
    );
    const definitionPatterns = [
      ...Object.keys(COMMENTED_API_QUOTAS).map((quota) => ({
        label: quota,
        pattern: new RegExp(`\\b${quota}\\s*:\\s*[\\d_]`, "u"),
      })),
      {
        label: "API_QUOTA_CODE",
        pattern: /\bAPI_QUOTA_CODE\s*=\s*["']/u,
      },
      {
        label: "GUEST_LINK_EXPIRY_HOURS",
        pattern:
          /\bGUEST_LINK_EXPIRY_HOURS\s*=\s*Object\.freeze\s*\(/u,
      },
      {
        label: "numeric guest-link expiry constant",
        pattern:
          /\b[A-Z0-9_]*GUEST_LINK[A-Z0-9_]*(?:EXPIRY|HOURS)[A-Z0-9_]*\s*=\s*[\d_]+/u,
      },
    ];
    const duplicateDefinitions = [
      ...sourceFiles(join(repositoryRoot, "app")),
      ...sourceFiles(join(repositoryRoot, "src")),
    ].flatMap((path) => {
      if (path === canonicalPath) return [];
      const contents = readFileSync(path, "utf8");
      return definitionPatterns
        .filter(({ pattern }) => pattern.test(contents))
        .map(({ label }) => `${relative(repositoryRoot, path)}: ${label}`);
    });

    expect(duplicateDefinitions).toEqual([]);
  });

  it("accepts an empty workspace snapshot", () => {
    const state = createEmptyState("Within quota");

    expect(() => assertSnapshotWithinQuotas(state)).not.toThrow();
    expect(snapshotQuotaUsage(state)).toMatchObject({
      activitiesPerSnapshot: 0,
      activityPatchesPerSnapshot: 0,
      auditEventsPerSnapshot: 0,
      commandReceiptsPerSnapshot: 0,
      itemsPerSnapshot: 0,
      locationsPerSnapshot: 0,
      plansPerSnapshot: 0,
      planStepsPerSnapshot: 0,
    });
  });

  it("reports root and nested collection overages with structured details", () => {
    const rootOverage = createEmptyState("Root overage");
    rootOverage.locations = Array.from(
      { length: API_QUOTAS.locationsPerSnapshot + 1 },
      () => ({}) as never,
    );
    const nestedOverage = createEmptyState("Nested overage");
    nestedOverage.plans = [{
      steps: Array.from(
        { length: API_QUOTAS.planStepsPerSnapshot + 1 },
        () => ({}),
      ),
    } as never];

    expect(() => assertSnapshotWithinQuotas(rootOverage)).toThrowError(
      expect.objectContaining({
        actual: API_QUOTAS.locationsPerSnapshot + 1,
        code: "QUOTA_EXCEEDED",
        limit: API_QUOTAS.locationsPerSnapshot,
        quota: "locationsPerSnapshot",
        status: 409,
      }),
    );
    expect(() => assertSnapshotWithinQuotas(nestedOverage)).toThrowError(
      expect.objectContaining({
        actual: API_QUOTAS.planStepsPerSnapshot + 1,
        limit: API_QUOTAS.planStepsPerSnapshot,
        quota: "planStepsPerSnapshot",
      }),
    );
  });

  it("enforces the compact command receipt bound", () => {
    const state = createEmptyState("Receipt overage");
    state.commandReceipts = Array.from(
      { length: API_QUOTAS.commandReceiptsPerSnapshot + 1 },
      (_, index) => `command_${index}`,
    );

    expect(() => assertSnapshotWithinQuotas(state)).toThrowError(
      expect.objectContaining({
        actual: API_QUOTAS.commandReceiptsPerSnapshot + 1,
        limit: API_QUOTAS.commandReceiptsPerSnapshot,
        quota: "commandReceiptsPerSnapshot",
      }),
    );
  });

  it("measures serialized UTF-8 bytes instead of JavaScript string length", () => {
    const multibyte = "é";

    expect(serializedJsonBytes(multibyte)).toBeGreaterThan(multibyte.length);

    const state = createEmptyState("é".repeat(1_000_000));
    const actual = snapshotQuotaUsage(state).storedSnapshotBytes;
    expect(actual).toBeGreaterThan(API_QUOTAS.storedSnapshotBytes);
    expect(() => assertSnapshotWithinQuotas(state, { status: 413 }))
      .toThrowError(expect.objectContaining({
        actual,
        limit: API_QUOTAS.storedSnapshotBytes,
        quota: "storedSnapshotBytes",
        status: 413,
      }));
  });

  it("lets legacy overages stay level or shrink but rejects further growth", () => {
    const previous = createEmptyState("Legacy overage");
    previous.locations = Array.from(
      { length: API_QUOTAS.locationsPerSnapshot + 2 },
      () => ({}) as never,
    );
    const unchanged = structuredClone(previous);
    const reduced = structuredClone(previous);
    reduced.locations.pop();
    const grown = structuredClone(previous);
    grown.locations.push({} as never);

    expect(() => assertSnapshotWithinQuotas(unchanged, { previous }))
      .not.toThrow();
    expect(() => assertSnapshotWithinQuotas(reduced, { previous }))
      .not.toThrow();
    expect(() => assertSnapshotWithinQuotas(grown, { previous })).toThrowError(
      expect.objectContaining({
        actual: API_QUOTAS.locationsPerSnapshot + 3,
        quota: "locationsPerSnapshot",
      }),
    );
  });

  it("serializes quota failures for API responses", () => {
    const error = new QuotaExceededError(
      "membersPerWorkspace",
      API_QUOTAS.membersPerWorkspace + 1,
    );

    expect(quotaProblem(error)).toEqual({
      actual: API_QUOTAS.membersPerWorkspace + 1,
      code: "QUOTA_EXCEEDED",
      error: "This workspace has reached its member limit",
      limit: API_QUOTAS.membersPerWorkspace,
      quota: "membersPerWorkspace",
    });
  });
});
