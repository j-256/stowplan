export const ACCOUNT_STATUS = Object.freeze({
  ACTIVE: "active",
  BANNED: "banned",
  DISABLED: "disabled",
} as const);

export type AccountStatus =
  typeof ACCOUNT_STATUS[keyof typeof ACCOUNT_STATUS];

export const GLOBAL_ROLE = Object.freeze({
  ADMIN: "admin",
  USER: "user",
} as const);

export type GlobalRole =
  typeof GLOBAL_ROLE[keyof typeof GLOBAL_ROLE];

export const ADMIN_RECOVERY_MODE = Object.freeze({
  ACCESS: "access",
  APP_SESSION: "app-session",
} as const);

export type AdminRecoveryMode =
  typeof ADMIN_RECOVERY_MODE[keyof typeof ADMIN_RECOVERY_MODE];

export const CIRCUIT_BREAKER_SCOPE = Object.freeze({
  GUEST_LINKS: "guest_links",
  GUEST_REDEMPTIONS: "guest_redemptions",
  NEW_ACCOUNTS: "new_accounts",
  NEW_WORKSPACES: "new_workspaces",
  SNAPSHOT_GROWTH: "snapshot_growth",
} as const);

export type CircuitBreakerScope =
  typeof CIRCUIT_BREAKER_SCOPE[keyof typeof CIRCUIT_BREAKER_SCOPE];

export const CIRCUIT_BREAKER_STATE = Object.freeze({
  OPEN: "open",
  PAUSED: "paused",
} as const);

export type CircuitBreakerState =
  typeof CIRCUIT_BREAKER_STATE[keyof typeof CIRCUIT_BREAKER_STATE];

export const CIRCUIT_BREAKER_PAUSE_KIND = Object.freeze({
  CAPACITY: "capacity",
  SECURITY: "security",
} as const);

export type CircuitBreakerPauseKind =
  typeof CIRCUIT_BREAKER_PAUSE_KIND[
    keyof typeof CIRCUIT_BREAKER_PAUSE_KIND
  ];

export const CREATION_RESOURCE = Object.freeze({
  ACCOUNT: "account",
  GUEST_LINK: "guest_link",
  SESSION: "session",
  WORKSPACE: "workspace",
} as const);

export type CreationResource =
  typeof CREATION_RESOURCE[keyof typeof CREATION_RESOURCE];

export const GOVERNANCE_LIMIT_KEY = Object.freeze({
  NEW_ACCOUNTS_PER_DAY: "new_accounts_per_day",
} as const);

export type GovernanceLimitKey =
  typeof GOVERNANCE_LIMIT_KEY[keyof typeof GOVERNANCE_LIMIT_KEY];

export const MAXIMUM_GOVERNANCE_LIMIT = Object.freeze({
  [GOVERNANCE_LIMIT_KEY.NEW_ACCOUNTS_PER_DAY]: 1_000_000,
} satisfies Record<GovernanceLimitKey, number>);

export const ROUTINE_AUTH_AUDIT_ACTION = Object.freeze({
  SESSION_ISSUE: "session.issue",
  SESSION_REVOKE: "session.revoke",
} as const);

export type RoutineAuthAuditAction =
  typeof ROUTINE_AUTH_AUDIT_ACTION[
    keyof typeof ROUTINE_AUTH_AUDIT_ACTION
  ];

export const AUTH_AUDIT_DETAIL_RETENTION_DAYS = 180;
export const AUTH_AUDIT_REDACTION_BATCH_SIZE = 100;
export const CREATION_LEDGER_ROLLING_RETENTION_DAYS = 31;

export const PUBLIC_LAUNCH_LIMITS = Object.freeze({
  activeSessionsPerAccount: 8,
  aggregateSnapshotBytesPerAccount: 8_000_000,
  guestLinksCreatedPerAccountDay: 10,
  guestLinksCreatedPerAccountRolling30Days: 50,
  linkedIdentitiesPerAccount: 5,
  membershipsPerAccount: 25,
  newAccountsPerDay: 25,
  sessionsIssuedPerAccountDay: 12,
  sessionsIssuedPerAccountRolling30Days: 60,
  terminalSessionRetentionDays: 30,
  terminalSessionsPerAccount: 32,
  workspacesCreatedPerAccountDay: 5,
  workspacesCreatedPerAccountLifetime: 100,
  workspacesCreatedPerAccountRolling30Days: 20,
});

export interface CircuitBreaker {
  effectiveState: CircuitBreakerState;
  pauseKind: CircuitBreakerPauseKind;
  reason: string | null;
  resumeAt: string | null;
  scope: CircuitBreakerScope;
  state: CircuitBreakerState;
  triggerCount: number;
  updatedAt: string;
  updatedByUserId: string | null;
}

export interface GovernanceLimit {
  key: GovernanceLimitKey;
  updatedAt: string;
  updatedByUserId: string | null;
  value: number;
}

export interface AccountDeletionBlocker {
  code:
    | "ACCOUNT_INACTIVE"
    | "CUSTODY_TRANSFER_UNAVAILABLE"
    | "FINAL_ADMIN"
    | "FINAL_WORKSPACE_OWNER"
    | "GLOBAL_ADMIN";
  workspaceId?: string;
}

export interface AccountDeletionCustodyTransfer {
  fromUserId: string;
  toUserId: string;
  workspaceId: string;
}
