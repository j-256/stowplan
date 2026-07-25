// @ts-check

// Application quotas that operators may intentionally tune
// Transport, pagination, timing, and UI bounds stay beside their enforcement

/** @type {"QUOTA_EXCEEDED"} */
export const API_QUOTA_CODE = "QUOTA_EXCEEDED";

export const API_QUOTAS = Object.freeze({
  // Guest links that are still available for enrollment
  activeGuestLinksPerWorkspace: 100,

  // Durable activity records retained in one workspace snapshot
  activitiesPerSnapshot: 10_000,

  // Field-aware undo patches retained across durable activity records
  activityPatchesPerSnapshot: 50_000,

  // Non-secret workspace audit records retained in one snapshot
  auditEventsPerSnapshot: 10_000,

  // Compact command IDs retained after full activity history is pruned
  commandReceiptsPerSnapshot: 20_000,

  // Deterministic commands accepted in one sync request
  commandsPerSyncRequest: 100,

  // Inventory items stored in one workspace snapshot
  itemsPerSnapshot: 4_000,

  // Locations stored in one workspace snapshot
  locationsPerSnapshot: 1_000,

  // Active members in one server-backed workspace
  membersPerWorkspace: 100,

  // Server-backed workspaces owned by one account
  ownedWorkspacesPerUser: 50,

  // Plans stored in one workspace snapshot
  plansPerSnapshot: 250,

  // Steps stored across all plans in one workspace snapshot
  planStepsPerSnapshot: 5_000,

  // Guest-link records retained across active and terminal states
  retainedGuestLinksPerWorkspace: 2_000,

  // UTF-8 JSON bytes stored for one workspace snapshot
  storedSnapshotBytes: 1_800_000,
});

// Expiry limits enrollment only and does not expire the resulting membership
// Owners choose a whole-hour guest-link expiry within this range
export const GUEST_LINK_EXPIRY_HOURS = Object.freeze({
  default: 24,
  maximum: 168,
  minimum: 1,
});
