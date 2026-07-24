export const API_QUOTA_CODE = "QUOTA_EXCEEDED";

export const API_QUOTAS = Object.freeze({
  activeGuestLinksPerWorkspace: 100,
  activitiesPerSnapshot: 10_000,
  activityPatchesPerSnapshot: 50_000,
  auditEventsPerSnapshot: 10_000,
  commandReceiptsPerSnapshot: 20_000,
  commandsPerSyncRequest: 100,
  itemsPerSnapshot: 4_000,
  locationsPerSnapshot: 1_000,
  membersPerWorkspace: 100,
  ownedWorkspacesPerUser: 50,
  plansPerSnapshot: 250,
  planStepsPerSnapshot: 5_000,
  retainedGuestLinksPerWorkspace: 2_000,
  storedSnapshotBytes: 1_800_000,
});

export type ApiQuotaName = keyof typeof API_QUOTAS;

export interface ApiQuotaDetails {
  actual: number;
  code: typeof API_QUOTA_CODE;
  limit: number;
  quota: ApiQuotaName;
}

export interface ApiQuotaProblem extends ApiQuotaDetails {
  error: string;
}
