const REDACTED_AUDIT_VALUE = "[redacted]";
const MAXIMUM_AUDIT_IDENTIFIER_LENGTH = 512;
const MAXIMUM_AUDIT_TIMESTAMP_LENGTH = 64;

type AuditDetailRule =
  | { kind: "boolean" }
  | { kind: "digest" }
  | { kind: "enum"; values: readonly string[] }
  | { kind: "integer" }
  | { kind: "nullable-text"; maximumLength: number }
  | { kind: "text"; maximumLength: number };

type AuditDetailSchema = Readonly<Record<string, AuditDetailRule>>;

const IDENTIFIER_RULE = Object.freeze({
  kind: "text",
  maximumLength: MAXIMUM_AUDIT_IDENTIFIER_LENGTH,
} as const);
const TIMESTAMP_RULE = Object.freeze({
  kind: "text",
  maximumLength: MAXIMUM_AUDIT_TIMESTAMP_LENGTH,
} as const);
const NULLABLE_TIMESTAMP_RULE = Object.freeze({
  kind: "nullable-text",
  maximumLength: MAXIMUM_AUDIT_TIMESTAMP_LENGTH,
} as const);
const INTEGER_RULE = Object.freeze({ kind: "integer" } as const);
const WORKSPACE_ROLE_RULE = Object.freeze({
  kind: "enum",
  values: Object.freeze(["editor", "owner", "viewer"]),
} as const);

function schema(
  value: Record<string, AuditDetailRule>,
): AuditDetailSchema {
  return Object.freeze(value);
}

const AUDIT_DETAIL_SCHEMAS = Object.freeze({
  "account.delete": schema({}),
  "admin.bootstrap": schema({}),
  "admin.recover": schema({
    emailMatched: {
      kind: "boolean",
    },
    principalDigest: {
      kind: "digest",
    },
    reason: {
      kind: "text",
      maximumLength: 500,
    },
    recoveryMode: {
      kind: "enum",
      values: Object.freeze(["access", "app-session"]),
    },
  }),
  "circuit.set": schema({
    pauseKind: {
      kind: "enum",
      values: Object.freeze(["capacity", "security"]),
    },
    resumeAt: NULLABLE_TIMESTAMP_RULE,
    scope: {
      kind: "enum",
      values: Object.freeze([
        "guest_links",
        "guest_redemptions",
        "new_accounts",
        "new_workspaces",
        "snapshot_growth",
      ]),
    },
    state: {
      kind: "enum",
      values: Object.freeze(["open", "paused"]),
    },
  }),
  "governance.limit.set": schema({
    key: {
      kind: "enum",
      values: Object.freeze(["new_accounts_per_day"]),
    },
    reason: {
      kind: "text",
      maximumLength: 500,
    },
    value: INTEGER_RULE,
  }),
  "guest.create": schema({
    expiresAt: TIMESTAMP_RULE,
    role: WORKSPACE_ROLE_RULE,
    workspaceId: IDENTIFIER_RULE,
  }),
  "guest.delete": schema({
    consumedAt: NULLABLE_TIMESTAMP_RULE,
    createdAt: TIMESTAMP_RULE,
    createdByUserId: IDENTIFIER_RULE,
    expiresAt: TIMESTAMP_RULE,
    priorStatus: {
      kind: "enum",
      values: Object.freeze(["active", "expired", "revoked", "used"]),
    },
    redemptionId: {
      kind: "nullable-text",
      maximumLength: MAXIMUM_AUDIT_IDENTIFIER_LENGTH,
    },
    revokedAt: NULLABLE_TIMESTAMP_RULE,
    role: WORKSPACE_ROLE_RULE,
    workspaceId: IDENTIFIER_RULE,
  }),
  "guest.revoke": schema({
    role: WORKSPACE_ROLE_RULE,
    workspaceId: IDENTIFIER_RULE,
  }),
  "identity.unlink": schema({}),
  "member.invite.accept": schema({
    guestLinkId: IDENTIFIER_RULE,
    role: WORKSPACE_ROLE_RULE,
    workspaceId: IDENTIFIER_RULE,
  }),
  "member.leave": schema({
    role: WORKSPACE_ROLE_RULE,
    userId: IDENTIFIER_RULE,
    workspaceId: IDENTIFIER_RULE,
  }),
  "member.remove": schema({
    role: WORKSPACE_ROLE_RULE,
    targetUserId: IDENTIFIER_RULE,
    workspaceId: IDENTIFIER_RULE,
  }),
  "member.role": schema({
    fromRole: WORKSPACE_ROLE_RULE,
    targetUserId: IDENTIFIER_RULE,
    toRole: WORKSPACE_ROLE_RULE,
    value: WORKSPACE_ROLE_RULE,
    workspaceId: IDENTIFIER_RULE,
  }),
  "ownership.transfer": schema({
    actorRole: WORKSPACE_ROLE_RULE,
    targetRole: WORKSPACE_ROLE_RULE,
    targetUserId: IDENTIFIER_RULE,
    workspaceId: IDENTIFIER_RULE,
  }),
  "session.issue": schema({}),
  "session.reauthenticate": schema({}),
  "session.revoke": schema({
    source: {
      kind: "enum",
      values: Object.freeze(["account", "logout"]),
    },
  }),
  "session.revoke-pre-google": schema({}),
  "snapshot.restore": schema({
    fromRevision: INTEGER_RULE,
    items: INTEGER_RULE,
    locations: INTEGER_RULE,
    plans: INTEGER_RULE,
    toRevision: INTEGER_RULE,
  }),
  "user.role": schema({
    value: {
      kind: "enum",
      values: Object.freeze(["admin", "user"]),
    },
  }),
  "user.ban": schema({}),
  "user.ban.lift": schema({}),
  "user.status": schema({
    value: {
      kind: "enum",
      values: Object.freeze(["active", "disabled"]),
    },
  }),
  "workspace.claim": schema({
    role: WORKSPACE_ROLE_RULE,
  }),
  "workspace.custody": schema({
    role: WORKSPACE_ROLE_RULE,
    source: {
      kind: "enum",
      values: Object.freeze(["global-admin"]),
    },
    workspaceId: IDENTIFIER_RULE,
  }),
  "workspace.delete": schema({
    deletionId: IDENTIFIER_RULE,
    finalSnapshotRevision: INTEGER_RULE,
    source: {
      kind: "enum",
      values: Object.freeze(["global-admin"]),
    },
    workspaceId: IDENTIFIER_RULE,
  }),
  "workspace.inspect": schema({
    accessRevision: INTEGER_RULE,
    activityCount: INTEGER_RULE,
    auditEventCount: INTEGER_RULE,
    commandReceiptCount: INTEGER_RULE,
    itemCount: INTEGER_RULE,
    locationCount: INTEGER_RULE,
    planCount: INTEGER_RULE,
    snapshotBytes: INTEGER_RULE,
    snapshotRevision: INTEGER_RULE,
    workspaceId: IDENTIFIER_RULE,
  }),
} satisfies Record<string, AuditDetailSchema>);

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) &&
    typeof value === "object" &&
    !Array.isArray(value);
}

function safeFieldValue(
  value: unknown,
  rule: AuditDetailRule,
): unknown {
  if (rule.kind === "boolean") {
    return typeof value === "boolean" ? value : REDACTED_AUDIT_VALUE;
  }
  if (rule.kind === "digest") {
    return typeof value === "string" &&
        /^v1:[0-9a-f]{64}$/u.test(value)
      ? value
      : REDACTED_AUDIT_VALUE;
  }
  if (rule.kind === "integer") {
    return typeof value === "number" &&
        Number.isSafeInteger(value) &&
        value >= 0
      ? value
      : REDACTED_AUDIT_VALUE;
  }
  if (rule.kind === "enum") {
    return typeof value === "string" && rule.values.includes(value)
      ? value
      : REDACTED_AUDIT_VALUE;
  }
  if (rule.kind === "nullable-text" && value === null) return null;
  return typeof value === "string" &&
      value.length <= rule.maximumLength
    ? value
    : REDACTED_AUDIT_VALUE;
}

function unavailableDetail(message: string): Record<string, string> {
  return { unavailable: message };
}

export function safeAuditDetail(
  action: string,
  value: unknown,
): Record<string, unknown> {
  if (!isRecord(value)) {
    return unavailableDetail("Audit detail was not stored as an object");
  }
  const fields = AUDIT_DETAIL_SCHEMAS[
    action as keyof typeof AUDIT_DETAIL_SCHEMAS
  ];
  if (!fields) {
    return {
      ...unavailableDetail("Audit detail is not available for this action"),
      redactedFieldCount: Object.keys(value).length,
    };
  }
  const safe: Record<string, unknown> = {};
  let redactedFieldCount = 0;
  for (const [key, entry] of Object.entries(value)) {
    if (!Object.prototype.hasOwnProperty.call(fields, key)) {
      redactedFieldCount += 1;
      continue;
    }
    const rule = fields[key];
    safe[key] = safeFieldValue(entry, rule);
  }
  if (redactedFieldCount > 0) {
    safe.redactedFieldCount = redactedFieldCount;
  }
  return safe;
}

export function safeAuditDetailJson(
  action: string,
  value: unknown,
): string {
  return JSON.stringify(safeAuditDetail(action, value));
}

export function safeStoredAuditDetailJson(
  action: unknown,
  value: unknown,
): string {
  if (typeof value !== "string") {
    return JSON.stringify(unavailableDetail(
      "Audit detail was not stored as JSON text",
    ));
  }
  try {
    return safeAuditDetailJson(
      typeof action === "string" ? action : "",
      JSON.parse(value) as unknown,
    );
  } catch {
    return JSON.stringify(unavailableDetail(
      "Audit detail could not be parsed",
    ));
  }
}
