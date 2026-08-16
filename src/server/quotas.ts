import type { WorkspaceState } from "../domain/types";
import {
  SNAPSHOT_QUOTA_ORDER,
  serializedJsonBytes,
  snapshotQuotaUsage,
  type SnapshotQuotaUsage,
} from "../domain/snapshot-quota-usage";
import {
  API_QUOTA_CODE,
  API_QUOTAS,
  type ApiQuotaDetails,
  type ApiQuotaName,
  type ApiQuotaProblem,
} from "../shared/api-quotas";

export {
  serializedJsonBytes,
  snapshotQuotaUsage,
};
export type { SnapshotQuotaUsage };

type QuotaStatus = 409 | 413;

const quotaMessages: Record<ApiQuotaName, string> = {
  activeGuestLinksPerWorkspace: "This workspace has reached its active guest link limit",
  activitiesPerSnapshot: "This workspace has reached its activity record limit",
  activityPatchesPerSnapshot: "This workspace has reached its activity patch limit",
  auditEventsPerSnapshot: "This workspace has reached its audit event limit",
  commandReceiptsPerSnapshot: "This workspace has reached its compact command receipt limit",
  commandsPerSyncRequest: "This sync request contains too many commands",
  itemsPerSnapshot: "This workspace has reached its item record limit",
  locationsPerSnapshot: "This workspace has reached its location record limit",
  membersPerWorkspace: "This workspace has reached its member limit",
  ownedWorkspacesPerUser: "This account has reached its owned workspace limit",
  plansPerSnapshot: "This workspace has reached its plan record limit",
  planStepsPerSnapshot: "This workspace has reached its plan step limit",
  retainedGuestLinksPerWorkspace: "This workspace has reached its retained guest link limit",
  storedSnapshotBytes: "This workspace has reached its stored snapshot size limit",
};

export class QuotaExceededError extends Error implements ApiQuotaDetails {
  readonly actual: number;
  readonly code = API_QUOTA_CODE;
  readonly limit: number;
  readonly quota: ApiQuotaName;
  readonly status: QuotaStatus;

  constructor(
    quota: ApiQuotaName,
    actual: number,
    status: QuotaStatus = 409,
  ) {
    super(quotaMessages[quota]);
    this.name = "QuotaExceededError";
    this.actual = actual;
    this.limit = API_QUOTAS[quota];
    this.quota = quota;
    this.status = status;
  }
}

export function quotaDetails(error: QuotaExceededError): ApiQuotaDetails {
  return {
    actual: error.actual,
    code: error.code,
    limit: error.limit,
    quota: error.quota,
  };
}

export function quotaProblem(error: QuotaExceededError): ApiQuotaProblem {
  return {
    error: error.message,
    ...quotaDetails(error),
  };
}

export function assertSnapshotWithinQuotas(
  value: WorkspaceState | unknown,
  options: {
    previous?: WorkspaceState;
    previousUsage?: SnapshotQuotaUsage;
    status?: QuotaStatus;
  } = {},
): SnapshotQuotaUsage {
  const usage = snapshotQuotaUsage(value);
  const previousUsage = options.previousUsage ??
    (options.previous ? snapshotQuotaUsage(options.previous) : null);
  for (const quota of SNAPSHOT_QUOTA_ORDER) {
    const actual = usage[quota];
    if (
      actual > API_QUOTAS[quota] &&
      (!previousUsage || actual > previousUsage[quota])
    ) {
      throw new QuotaExceededError(quota, actual, options.status);
    }
  }
  return usage;
}
