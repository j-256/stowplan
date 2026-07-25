import type {
  D1DatabaseLike,
  D1ResultLike,
} from "../adapters/d1-snapshot-store";
import { workspaceReturnTo } from "../domain/app-url";
import {
  capabilitiesForWorkspaceRole,
  isWorkspaceRole,
  type ServerWorkspaceSummary,
  type WorkspaceCapabilities,
  type WorkspaceRole,
} from "../domain/workspace-access";
import { newId, nowIso } from "../domain/factories";
import {
  API_QUOTAS,
  GUEST_LINK_EXPIRY_HOURS,
} from "../shared/api-quotas";
import {
  authenticate,
  isTrustedMutation,
  type SessionUser,
} from "./auth";
import {
  ApiProblem,
  apiProblemResponse,
  internalProblemResponse,
  privateJson,
} from "./api-problem";
import { requireExpectedAccount } from "./account-context";
import { safeAuditDetailJson } from "./audit-detail";
import {
  QuotaExceededError,
  quotaProblem,
} from "./quotas";
import {
  readJsonRequest,
  RequestBodyTooLargeError,
  WORKSPACE_ACCESS_REQUEST_MAX_BYTES,
} from "./request-body";
import { runtimeEnv } from "./runtime";

const DEFAULT_PAGE_LIMIT = 25;
const MAXIMUM_PAGE_LIMIT = 50;
const MAXIMUM_QUERY_LENGTH = 120;
const MAXIMUM_CURSOR_LENGTH = 2_048;
const MAXIMUM_SAFE_REVISION = Number.MAX_SAFE_INTEGER;

const GUEST_LINK_ROLES = Object.freeze([
  "editor",
  "viewer",
] as const);

const GUEST_LINK_STATUSES = Object.freeze([
  "active",
  "used",
  "expired",
  "revoked",
] as const);

type GuestLinkRole = (typeof GUEST_LINK_ROLES)[number];
type GuestLinkStatus = (typeof GUEST_LINK_STATUSES)[number];

interface Statement {
  all<T>(): Promise<{ results: T[] }>;
  bind(...values: unknown[]): Statement;
  first<T>(): Promise<T | null>;
  run(): Promise<D1ResultLike>;
}

interface WorkspaceDatabase {
  batch(statements: Statement[]): Promise<D1ResultLike[]>;
  prepare(query: string): Statement;
}

interface WorkspacePrincipal {
  baseUrl: string;
  database: D1DatabaseLike;
  user: SessionUser;
}

interface CatalogCursor {
  id: string;
  kind: "catalog";
  membershipRevision: number;
  query: string;
  role: WorkspaceRole | null;
  version: 1;
}

interface MemberCursor {
  accessRevision: number;
  createdAt: string;
  id: string;
  kind: "members";
  query: string;
  version: 1;
}

interface GuestLinkCursor {
  accessRevision: number;
  createdAt: string;
  id: string;
  kind: "guest-links";
  status: GuestLinkStatus | null;
  version: 1;
}

interface CatalogRow {
  access_revision: number;
  membership_revision: number;
  name: string;
  owner_count: number;
  revision: number;
  role: WorkspaceRole;
  updated_at: string;
  workspace_id: string;
}

interface WorkspaceContextRow {
  access_revision: number;
  membership_revision: number;
  name: string;
  owner_count: number;
  revision: number;
  role: WorkspaceRole;
  updated_at: string;
  workspace_id: string;
}

interface MemberRow {
  created_at: string;
  display_name: string;
  email: string;
  guest_identity: number;
  membership_revision: number;
  role: WorkspaceRole;
  status: "active" | "disabled";
  user_id: string;
}

interface GuestLinkRow {
  consumed_at: string | null;
  created_at: string;
  expires_at: string;
  guest_link_id: string;
  revoked_at: string | null;
  role: GuestLinkRole;
  status: GuestLinkStatus;
}

interface AccessRevisionRow {
  access_revision: number;
}

interface MemberMutationRow extends MemberRow, AccessRevisionRow {}

interface GuestLinkMutationRow extends GuestLinkRow, AccessRevisionRow {}

interface PageInfo {
  hasMore: boolean;
  limit: number;
  nextCursor: string | null;
}

interface RoleChangeInput {
  expectedAccessRevision: number;
  expectedMembershipRevision: number;
  role: WorkspaceRole;
}

interface MemberRemovalInput {
  expectedAccessRevision: number;
  expectedMembershipRevision: number;
}

interface OwnershipTransferInput {
  expectedAccessRevision: number;
  expectedActorMembershipRevision: number;
  expectedTargetMembershipRevision: number;
  targetUserId: string;
}

interface LeaveWorkspaceInput {
  expectedAccessRevision: number;
  expectedMembershipRevision: number;
}

interface CreateGuestLinkInput {
  expectedAccessRevision: number;
  expiresInHours: number;
  returnTo?: string;
  role: GuestLinkRole;
}

interface RevokeGuestLinkInput {
  expectedAccessRevision: number;
}

interface DeleteWorkspaceInput {
  confirmationName: string;
  expectedAccessRevision: number;
  expectedMembershipRevision: number;
  expectedRevision: number;
}

function databaseLike(database: D1DatabaseLike): WorkspaceDatabase {
  return database as unknown as WorkspaceDatabase;
}

function resultChanges(result: D1ResultLike | undefined): number {
  return result?.success ? result.meta?.changes ?? 0 : 0;
}

function requiredBatchRow<T>(
  result: D1ResultLike | undefined,
  operation: string,
): T {
  const row = result?.results?.[0] as T | undefined;
  if (!row) throw new Error(`${operation} did not return its committed state`);
  return row;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function requiredRecord(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new ApiProblem(
      "INVALID_REQUEST",
      "The request body must be a JSON object",
      400,
    );
  }
  return value;
}

function requiredRevision(
  record: Record<string, unknown>,
  field: string,
): number {
  const value = record[field];
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < 0
  ) {
    throw new ApiProblem(
      "INVALID_REQUEST",
      `${field} must be a non-negative safe integer`,
      400,
    );
  }
  return value;
}

function requiredString(
  record: Record<string, unknown>,
  field: string,
): string {
  const value = record[field];
  if (typeof value !== "string" || !value.trim()) {
    throw new ApiProblem(
      "INVALID_REQUEST",
      `${field} must be a non-empty string`,
      400,
    );
  }
  return value;
}

function boundedPageLimit(searchParams: URLSearchParams): number {
  const raw = searchParams.get("limit");
  if (raw === null) return DEFAULT_PAGE_LIMIT;
  if (!/^\d+$/.test(raw)) {
    throw new ApiProblem(
      "INVALID_REQUEST",
      `limit must be an integer from 1 through ${MAXIMUM_PAGE_LIMIT}`,
      400,
    );
  }
  const value = Number(raw);
  if (
    !Number.isSafeInteger(value) ||
    value < 1 ||
    value > MAXIMUM_PAGE_LIMIT
  ) {
    throw new ApiProblem(
      "INVALID_REQUEST",
      `limit must be an integer from 1 through ${MAXIMUM_PAGE_LIMIT}`,
      400,
    );
  }
  return value;
}

function normalizedQuery(searchParams: URLSearchParams): string {
  const query = (searchParams.get("q") ?? "").trim().toLowerCase();
  if (query.length > MAXIMUM_QUERY_LENGTH) {
    throw new ApiProblem(
      "INVALID_REQUEST",
      `q must be at most ${MAXIMUM_QUERY_LENGTH} characters`,
      400,
    );
  }
  return query;
}

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, "\\$&");
}

function encodeBytesBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/u, "");
}

function encodeBase64Url(value: string): string {
  return encodeBytesBase64Url(new TextEncoder().encode(value));
}

function decodeBase64Url(value: string): string {
  const normalized = value.replaceAll("-", "+").replaceAll("_", "/");
  const padding = "=".repeat((4 - normalized.length % 4) % 4);
  const binary = atob(`${normalized}${padding}`);
  const bytes = Uint8Array.from(binary, character => character.charCodeAt(0));
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
}

function encodeCursor(value: CatalogCursor | MemberCursor | GuestLinkCursor) {
  return encodeBase64Url(JSON.stringify(value));
}

function decodedCursor(value: string | null): unknown {
  if (value === null) return null;
  if (!value || value.length > MAXIMUM_CURSOR_LENGTH) {
    throw new ApiProblem("INVALID_REQUEST", "The cursor is invalid", 400);
  }
  try {
    return JSON.parse(decodeBase64Url(value)) as unknown;
  } catch {
    throw new ApiProblem("INVALID_REQUEST", "The cursor is invalid", 400);
  }
}

function catalogCursor(
  value: string | null,
  query: string,
  role: WorkspaceRole | null,
): CatalogCursor | null {
  const decoded = decodedCursor(value);
  if (decoded === null) return null;
  if (
    !isRecord(decoded) ||
    decoded.version !== 1 ||
    decoded.kind !== "catalog" ||
    typeof decoded.id !== "string" ||
    !decoded.id ||
    typeof decoded.membershipRevision !== "number" ||
    !Number.isSafeInteger(decoded.membershipRevision) ||
    decoded.membershipRevision < 0 ||
    decoded.query !== query ||
    decoded.role !== role
  ) {
    throw new ApiProblem("INVALID_REQUEST", "The cursor is invalid", 400);
  }
  return decoded as unknown as CatalogCursor;
}

function memberCursor(
  value: string | null,
  query: string,
  accessRevision: number,
): MemberCursor | null {
  const decoded = decodedCursor(value);
  if (decoded === null) return null;
  if (
    !isRecord(decoded) ||
    decoded.version !== 1 ||
    decoded.kind !== "members" ||
    typeof decoded.id !== "string" ||
    !decoded.id ||
    typeof decoded.createdAt !== "string" ||
    !decoded.createdAt ||
    typeof decoded.accessRevision !== "number" ||
    !Number.isSafeInteger(decoded.accessRevision) ||
    decoded.accessRevision < 0 ||
    decoded.query !== query
  ) {
    throw new ApiProblem("INVALID_REQUEST", "The cursor is invalid", 400);
  }
  if (decoded.accessRevision !== accessRevision) {
    throw new ApiProblem(
      "ACCESS_STALE",
      "Workspace access changed; restart the member refresh",
      409,
      { accessRevision },
    );
  }
  return decoded as unknown as MemberCursor;
}

function guestLinkCursor(
  value: string | null,
  status: GuestLinkStatus | null,
  accessRevision: number,
): GuestLinkCursor | null {
  const decoded = decodedCursor(value);
  if (decoded === null) return null;
  if (
    !isRecord(decoded) ||
    decoded.version !== 1 ||
    decoded.kind !== "guest-links" ||
    typeof decoded.id !== "string" ||
    !decoded.id ||
    typeof decoded.createdAt !== "string" ||
    !decoded.createdAt ||
    typeof decoded.accessRevision !== "number" ||
    !Number.isSafeInteger(decoded.accessRevision) ||
    decoded.accessRevision < 0 ||
    decoded.status !== status
  ) {
    throw new ApiProblem("INVALID_REQUEST", "The cursor is invalid", 400);
  }
  if (decoded.accessRevision !== accessRevision) {
    throw new ApiProblem(
      "ACCESS_STALE",
      "Workspace access changed; restart the guest-link refresh",
      409,
      { accessRevision },
    );
  }
  return decoded as unknown as GuestLinkCursor;
}

function pageInfo<T>(
  rows: T[],
  limit: number,
  cursorFor: (row: T) => string,
): { page: PageInfo; rows: T[] } {
  const hasMore = rows.length > limit;
  const visible = rows.slice(0, limit);
  return {
    page: {
      hasMore,
      limit,
      nextCursor: hasMore && visible.length
        ? cursorFor(visible[visible.length - 1])
        : null,
    },
    rows: visible,
  };
}

function roleFilter(searchParams: URLSearchParams): WorkspaceRole | null {
  const role = searchParams.get("role");
  if (role === null || role === "") return null;
  if (!isWorkspaceRole(role)) {
    throw new ApiProblem(
      "INVALID_REQUEST",
      "role must be owner, editor, or viewer",
      400,
    );
  }
  return role;
}

function guestStatusFilter(
  searchParams: URLSearchParams,
): GuestLinkStatus | null {
  const status = searchParams.get("status");
  if (status === null || status === "") return null;
  if (!GUEST_LINK_STATUSES.includes(status as GuestLinkStatus)) {
    throw new ApiProblem(
      "INVALID_REQUEST",
      "status must be active, used, expired, or revoked",
      400,
    );
  }
  return status as GuestLinkStatus;
}

function accessCapabilities(
  role: WorkspaceRole,
  ownerCount: number,
): WorkspaceCapabilities {
  return capabilitiesForWorkspaceRole(
    role,
    role !== "owner" || ownerCount > 1,
  );
}

function summaryFromRow(row: CatalogRow): ServerWorkspaceSummary {
  return {
    accessRevision: row.access_revision,
    capabilities: accessCapabilities(row.role, row.owner_count),
    id: row.workspace_id,
    membershipRevision: row.membership_revision,
    name: row.name || row.workspace_id,
    revision: row.revision,
    role: row.role,
    updatedAt: row.updated_at,
  };
}

function accessFromContext(row: WorkspaceContextRow) {
  return {
    accessRevision: row.access_revision,
    capabilities: accessCapabilities(row.role, row.owner_count),
    membershipRevision: row.membership_revision,
    role: row.role,
  };
}

async function deletedByCaller(
  db: WorkspaceDatabase,
  workspaceId: string,
  userId: string,
): Promise<boolean> {
  const row = await db.prepare(
    `SELECT deletion_id
     FROM workspace_deletions
     WHERE workspace_id=? AND deleted_by_user_id=?`,
  ).bind(workspaceId, userId).first<{ deletion_id: string }>();
  return Boolean(row);
}

async function inaccessible(
  db: WorkspaceDatabase,
  workspaceId: string,
  userId: string,
): Promise<never> {
  if (await deletedByCaller(db, workspaceId, userId)) {
    throw new ApiProblem(
      "WORKSPACE_DELETED",
      "The server workspace was deleted",
      410,
    );
  }
  throw new ApiProblem(
    "NOT_FOUND_OR_INACCESSIBLE",
    "The workspace was not found or is not accessible",
    404,
  );
}

async function workspaceContext(
  db: WorkspaceDatabase,
  workspaceId: string,
  userId: string,
): Promise<WorkspaceContextRow> {
  const row = await db.prepare(
    `SELECT s.workspace_id,s.revision,s.access_revision,s.updated_at,
            COALESCE(
              NULLIF(json_extract(s.state_json,'$.workspace.name'),''),
              s.workspace_id
            ) AS name,
            m.role,u.membership_revision,
            (
              SELECT COUNT(*)
              FROM workspace_members owners
              JOIN users owner_user ON owner_user.user_id=owners.user_id
              WHERE owners.workspace_id=s.workspace_id
                AND owners.role='owner'
                AND owner_user.status='active'
            ) AS owner_count
     FROM workspace_snapshots s
     JOIN workspace_members m
       ON m.workspace_id=s.workspace_id AND m.user_id=?
     JOIN users u ON u.user_id=m.user_id AND u.status='active'
     WHERE s.workspace_id=?
       AND NOT EXISTS (
         SELECT 1 FROM workspace_deletions deleted
         WHERE deleted.workspace_id=s.workspace_id
       )`,
  ).bind(userId, workspaceId).first<WorkspaceContextRow>();
  if (!row) return inaccessible(db, workspaceId, userId);
  return row;
}

async function ownerContext(
  db: WorkspaceDatabase,
  workspaceId: string,
  userId: string,
): Promise<WorkspaceContextRow> {
  const context = await workspaceContext(db, workspaceId, userId);
  if (context.role !== "owner") {
    throw new ApiProblem(
      "OWNER_REQUIRED",
      "Workspace owner access is required",
      403,
      { access: accessFromContext(context) },
    );
  }
  return context;
}

function assertExpectedAccess(
  context: WorkspaceContextRow,
  expectedAccessRevision: number,
): void {
  if (context.access_revision !== expectedAccessRevision) {
    throw new ApiProblem(
      "ACCESS_STALE",
      "Workspace access changed; refresh and try again",
      409,
      { access: accessFromContext(context) },
    );
  }
}

function auditStatement(
  db: WorkspaceDatabase,
  actorUserId: string,
  action: string,
  targetType: string,
  targetId: string,
  detail: Record<string, unknown>,
  at: string,
  requiredChanges = 1,
): Statement {
  return db.prepare(
    `INSERT INTO auth_audit_events(
       event_id,actor_user_id,action,target_type,target_id,detail_json,
       created_at
     )
     SELECT ?,?,?,?,?,?,?
     WHERE changes()=?`,
  ).bind(
    newId("aud"),
    actorUserId,
    action,
    targetType,
    targetId,
    safeAuditDetailJson(action, detail),
    at,
    requiredChanges,
  );
}

function accessRevisionResultStatement(
  db: WorkspaceDatabase,
  workspaceId: string,
): Statement {
  return db.prepare(
    `SELECT access_revision
     FROM workspace_snapshots
     WHERE workspace_id=?`,
  ).bind(workspaceId);
}

function memberMutationResultStatement(
  db: WorkspaceDatabase,
  workspaceId: string,
  userId: string,
): Statement {
  return db.prepare(
    `SELECT snapshot.access_revision,
            member.user_id,member.role,member.created_at,
            user.display_name,user.email,user.membership_revision,user.status,
            CASE WHEN EXISTS (
              SELECT 1 FROM identities identity
              WHERE identity.user_id=user.user_id
                AND identity.provider='guest'
            ) AND NOT EXISTS (
              SELECT 1 FROM identities identity
              WHERE identity.user_id=user.user_id
                AND identity.provider<>'guest'
            ) THEN 1 ELSE 0 END AS guest_identity
     FROM workspace_snapshots snapshot
     JOIN workspace_members member
       ON member.workspace_id=snapshot.workspace_id
      AND member.user_id=?
     JOIN users user ON user.user_id=member.user_id
     WHERE snapshot.workspace_id=?`,
  ).bind(userId, workspaceId);
}

function guestLinkMutationResultStatement(
  db: WorkspaceDatabase,
  workspaceId: string,
  guestLinkId: string,
  at: string,
): Statement {
  return db.prepare(
    `SELECT snapshot.access_revision,
            link.guest_link_id,link.role,link.created_at,link.expires_at,
            link.consumed_at,link.revoked_at,
            CASE
              WHEN link.revoked_at IS NOT NULL THEN 'revoked'
              WHEN link.consumed_at IS NOT NULL THEN 'used'
              WHEN link.expires_at<=? THEN 'expired'
              ELSE 'active'
            END AS status
     FROM workspace_snapshots snapshot
     JOIN guest_links link
       ON link.workspace_id=snapshot.workspace_id
      AND link.guest_link_id=?
     WHERE snapshot.workspace_id=?`,
  ).bind(at, guestLinkId, workspaceId);
}

async function currentMember(
  db: WorkspaceDatabase,
  workspaceId: string,
  userId: string,
): Promise<MemberRow | null> {
  return db.prepare(
    `SELECT m.user_id,m.role,m.created_at,u.display_name,u.email,
            u.membership_revision,u.status,
            CASE WHEN EXISTS (
              SELECT 1 FROM identities i
              WHERE i.user_id=u.user_id AND i.provider='guest'
            ) AND NOT EXISTS (
              SELECT 1 FROM identities i
              WHERE i.user_id=u.user_id AND i.provider<>'guest'
            ) THEN 1 ELSE 0 END AS guest_identity
     FROM workspace_members m
     JOIN users u ON u.user_id=m.user_id
     WHERE m.workspace_id=? AND m.user_id=?`,
  ).bind(workspaceId, userId).first<MemberRow>();
}

async function assertOwnerPromotionQuota(
  db: WorkspaceDatabase,
  userId: string,
): Promise<void> {
  const owned = await db.prepare(
    `SELECT COUNT(*) AS count
     FROM workspace_members
     WHERE user_id=? AND role='owner'`,
  ).bind(userId).first<{ count: number }>();
  if ((owned?.count ?? 0) >= API_QUOTAS.ownedWorkspacesPerUser) {
    throw new QuotaExceededError(
      "ownedWorkspacesPerUser",
      (owned?.count ?? 0) + 1,
    );
  }
}

function memberResponse(row: MemberRow) {
  return {
    createdAt: row.created_at,
    displayName: row.display_name,
    email: row.guest_identity ? null : row.email,
    identityKind: row.guest_identity ? "guest" : "account",
    membershipRevision: row.membership_revision,
    role: row.role,
    userId: row.user_id,
  };
}

function assertActiveOwnershipTarget(target: MemberRow): void {
  if (target.status !== "active") {
    throw new ApiProblem(
      "INVALID_REQUEST",
      "A disabled account cannot be assigned workspace ownership",
      409,
      { member: memberResponse(target) },
    );
  }
}

async function explainMemberMutationRefusal(
  db: WorkspaceDatabase,
  workspaceId: string,
  actorUserId: string,
  targetUserId: string,
  expectedAccessRevision: number,
  expectedMembershipRevision: number,
  nextRole?: WorkspaceRole,
): Promise<{
  context: WorkspaceContextRow;
  target: MemberRow;
}> {
  const context = await ownerContext(db, workspaceId, actorUserId);
  assertExpectedAccess(context, expectedAccessRevision);
  const target = await currentMember(db, workspaceId, targetUserId);
  if (!target) {
    if (await deletedByCaller(db, workspaceId, actorUserId)) {
      return inaccessible(db, workspaceId, actorUserId);
    }
    throw new ApiProblem(
      "NOT_FOUND_OR_INACCESSIBLE",
      "The workspace member was not found",
      404,
    );
  }
  if (nextRole === "owner" && target.role !== "owner") {
    assertActiveOwnershipTarget(target);
    await assertOwnerPromotionQuota(db, targetUserId);
  }
  if (target.membership_revision !== expectedMembershipRevision) {
    throw new ApiProblem(
      "ACCESS_STALE",
      "Workspace membership changed; refresh and try again",
      409,
      { member: memberResponse(target) },
    );
  }
  return { context, target };
}

function parseRoleChange(value: unknown): RoleChangeInput {
  const record = requiredRecord(value);
  if (!isWorkspaceRole(record.role)) {
    throw new ApiProblem(
      "INVALID_REQUEST",
      "role must be owner, editor, or viewer",
      400,
    );
  }
  return {
    expectedAccessRevision: requiredRevision(
      record,
      "expectedAccessRevision",
    ),
    expectedMembershipRevision: requiredRevision(
      record,
      "expectedMembershipRevision",
    ),
    role: record.role,
  };
}

function parseMemberRemoval(value: unknown): MemberRemovalInput {
  const record = requiredRecord(value);
  return {
    expectedAccessRevision: requiredRevision(
      record,
      "expectedAccessRevision",
    ),
    expectedMembershipRevision: requiredRevision(
      record,
      "expectedMembershipRevision",
    ),
  };
}

function parseOwnershipTransfer(value: unknown): OwnershipTransferInput {
  const record = requiredRecord(value);
  return {
    expectedAccessRevision: requiredRevision(
      record,
      "expectedAccessRevision",
    ),
    expectedActorMembershipRevision: requiredRevision(
      record,
      "expectedActorMembershipRevision",
    ),
    expectedTargetMembershipRevision: requiredRevision(
      record,
      "expectedTargetMembershipRevision",
    ),
    targetUserId: requiredString(record, "targetUserId"),
  };
}

function parseLeaveWorkspace(value: unknown): LeaveWorkspaceInput {
  const record = requiredRecord(value);
  return {
    expectedAccessRevision: requiredRevision(
      record,
      "expectedAccessRevision",
    ),
    expectedMembershipRevision: requiredRevision(
      record,
      "expectedMembershipRevision",
    ),
  };
}

function parseCreateGuestLink(value: unknown): CreateGuestLinkInput {
  const record = requiredRecord(value);
  if (!GUEST_LINK_ROLES.includes(record.role as GuestLinkRole)) {
    throw new ApiProblem(
      "INVALID_REQUEST",
      "role must be editor or viewer",
      400,
    );
  }
  const expiresInHours = record.expiresInHours;
  if (
    typeof expiresInHours !== "number" ||
    !Number.isSafeInteger(expiresInHours) ||
    expiresInHours < GUEST_LINK_EXPIRY_HOURS.minimum ||
    expiresInHours > GUEST_LINK_EXPIRY_HOURS.maximum
  ) {
    throw new ApiProblem(
      "INVALID_REQUEST",
      `expiresInHours must be an integer from ${GUEST_LINK_EXPIRY_HOURS.minimum} through ${GUEST_LINK_EXPIRY_HOURS.maximum}`,
      400,
    );
  }
  if (
    record.returnTo !== undefined &&
    typeof record.returnTo !== "string"
  ) {
    throw new ApiProblem(
      "INVALID_REQUEST",
      "returnTo must be a string",
      400,
    );
  }
  return {
    expectedAccessRevision: requiredRevision(
      record,
      "expectedAccessRevision",
    ),
    expiresInHours,
    returnTo: record.returnTo as string | undefined,
    role: record.role as GuestLinkRole,
  };
}

function parseRevokeGuestLink(value: unknown): RevokeGuestLinkInput {
  const record = requiredRecord(value);
  return {
    expectedAccessRevision: requiredRevision(
      record,
      "expectedAccessRevision",
    ),
  };
}

function parseDeleteWorkspace(value: unknown): DeleteWorkspaceInput {
  const record = requiredRecord(value);
  return {
    confirmationName: requiredString(record, "confirmationName"),
    expectedAccessRevision: requiredRevision(
      record,
      "expectedAccessRevision",
    ),
    expectedMembershipRevision: requiredRevision(
      record,
      "expectedMembershipRevision",
    ),
    expectedRevision: requiredRevision(record, "expectedRevision"),
  };
}

function randomToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return encodeBytesBase64Url(bytes);
}

async function tokenHash(raw: string): Promise<string> {
  const digest = new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(raw)),
  );
  return [...digest]
    .map(value => value.toString(16).padStart(2, "0"))
    .join("");
}

async function guestLinkUsage(
  db: WorkspaceDatabase,
  workspaceId: string,
  at: string,
): Promise<{ active: number; retained: number }> {
  const row = await db.prepare(
    `SELECT COUNT(*) AS retained,
            COALESCE(SUM(
              CASE
                WHEN consumed_at IS NULL
                  AND revoked_at IS NULL
                  AND expires_at>?
                THEN 1
                ELSE 0
              END
            ),0) AS active
     FROM guest_links
     WHERE workspace_id=?`,
  ).bind(at, workspaceId).first<{ active: number; retained: number }>();
  return {
    active: row?.active ?? 0,
    retained: row?.retained ?? 0,
  };
}

function guestLinkResponse(row: GuestLinkRow) {
  return {
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    guestLinkId: row.guest_link_id,
    revokedAt: row.revoked_at,
    role: row.role,
    status: row.status,
    usedAt: row.consumed_at,
  };
}

async function currentGuestLink(
  db: WorkspaceDatabase,
  workspaceId: string,
  guestLinkId: string,
  at: string,
): Promise<GuestLinkRow | null> {
  return db.prepare(
    `SELECT guest_link_id,role,created_at,expires_at,consumed_at,revoked_at,
            CASE
              WHEN revoked_at IS NOT NULL THEN 'revoked'
              WHEN consumed_at IS NOT NULL THEN 'used'
              WHEN expires_at<=? THEN 'expired'
              ELSE 'active'
            END AS status
     FROM guest_links
     WHERE workspace_id=? AND guest_link_id=?`,
  ).bind(at, workspaceId, guestLinkId).first<GuestLinkRow>();
}

export async function requireWorkspacePrincipal(
  request: Request,
  mutation = false,
): Promise<WorkspacePrincipal> {
  const env = await runtimeEnv();
  if (mutation && !isTrustedMutation(request, env.AUTH_BASE_URL)) {
    throw new ApiProblem(
      "CROSS_ORIGIN_DENIED",
      "Cross-origin mutation denied",
      403,
    );
  }
  if (!env.DB) {
    throw new ApiProblem(
      "STORAGE_UNAVAILABLE",
      "Durable storage is not configured",
      503,
    );
  }
  const user = await authenticate(env.DB, request);
  if (!user) {
    throw new ApiProblem(
      "AUTHENTICATION_REQUIRED",
      "Authentication required",
      401,
    );
  }
  requireExpectedAccount(request, user.userId);
  return {
    baseUrl: env.AUTH_BASE_URL ?? request.url,
    database: env.DB,
    user,
  };
}

export async function readWorkspaceAccessBody(
  request: Request,
): Promise<unknown> {
  const contentType = request.headers.get("content-type") ?? "";
  if (!contentType.toLowerCase().startsWith("application/json")) {
    throw new ApiProblem(
      "INVALID_REQUEST",
      "Content-Type must be application/json",
      415,
    );
  }
  return readJsonRequest<unknown>(
    request,
    WORKSPACE_ACCESS_REQUEST_MAX_BYTES,
  );
}

export function workspaceAccessErrorResponse(error: unknown): Response {
  if (error instanceof ApiProblem) return apiProblemResponse(error);
  if (error instanceof QuotaExceededError) {
    return privateJson(quotaProblem(error), { status: error.status });
  }
  if (error instanceof RequestBodyTooLargeError) {
    return apiProblemResponse(
      new ApiProblem("BODY_TOO_LARGE", error.message, error.status),
    );
  }
  if (error instanceof SyntaxError) {
    return apiProblemResponse(
      new ApiProblem("INVALID_REQUEST", "The JSON body is invalid", 400),
    );
  }
  return internalProblemResponse();
}

export async function listMemberWorkspaces(
  database: D1DatabaseLike,
  userId: string,
  searchParams: URLSearchParams,
) {
  const db = databaseLike(database);
  const limit = boundedPageLimit(searchParams);
  const query = normalizedQuery(searchParams);
  const role = roleFilter(searchParams);
  const cursor = catalogCursor(searchParams.get("cursor"), query, role);
  const user = await db.prepare(
    `SELECT membership_revision
     FROM users
     WHERE user_id=? AND status='active'`,
  ).bind(userId).first<{ membership_revision: number }>();
  if (!user) {
    throw new ApiProblem(
      "AUTHENTICATION_REQUIRED",
      "Authentication required",
      401,
    );
  }
  const membershipRevision = user.membership_revision;
  if (
    cursor &&
    cursor.membershipRevision !== membershipRevision
  ) {
    throw new ApiProblem(
      "ACCESS_STALE",
      "Workspace membership changed; restart the workspace refresh",
      409,
      { membershipRevision },
    );
  }
  const conditions = [
    "m.user_id=?",
    "u.membership_revision=?",
    "u.status='active'",
    `NOT EXISTS (
      SELECT 1 FROM workspace_deletions deleted
      WHERE deleted.workspace_id=s.workspace_id
    )`,
  ];
  const values: unknown[] = [userId, membershipRevision];
  if (query) {
    const pattern = `%${escapeLike(query)}%`;
    conditions.push(
      `(lower(COALESCE(
          NULLIF(json_extract(s.state_json,'$.workspace.name'),''),
          s.workspace_id
        )) LIKE ? ESCAPE '\\'
        OR lower(s.workspace_id) LIKE ? ESCAPE '\\')`,
    );
    values.push(pattern, pattern);
  }
  if (role) {
    conditions.push("m.role=?");
    values.push(role);
  }
  if (cursor) {
    conditions.push("s.workspace_id>?");
    values.push(cursor.id);
  }
  values.push(limit + 1);
  const result = await db.prepare(
    `SELECT s.workspace_id,s.revision,s.access_revision,s.updated_at,
            COALESCE(
              NULLIF(json_extract(s.state_json,'$.workspace.name'),''),
              s.workspace_id
            ) AS name,
            m.role,u.membership_revision,
            (
              SELECT COUNT(*)
              FROM workspace_members owners
              JOIN users owner_user ON owner_user.user_id=owners.user_id
              WHERE owners.workspace_id=s.workspace_id
                AND owners.role='owner'
                AND owner_user.status='active'
            ) AS owner_count
     FROM workspace_members m
     JOIN workspace_snapshots s ON s.workspace_id=m.workspace_id
     JOIN users u ON u.user_id=m.user_id
     WHERE ${conditions.join("\n       AND ")}
     ORDER BY s.workspace_id ASC
     LIMIT ?`,
  ).bind(...values).all<CatalogRow>();
  const page = pageInfo(result.results, limit, row => encodeCursor({
    id: row.workspace_id,
    kind: "catalog",
    membershipRevision,
    query,
    role,
    version: 1,
  }));
  const finalUser = await db.prepare(
    `SELECT membership_revision
     FROM users
     WHERE user_id=? AND status='active'`,
  ).bind(userId).first<{ membership_revision: number }>();
  if (finalUser?.membership_revision !== membershipRevision) {
    throw new ApiProblem(
      "ACCESS_STALE",
      "Workspace membership changed; restart the workspace refresh",
      409,
      { membershipRevision: finalUser?.membership_revision },
    );
  }
  return {
    membershipRevision,
    page: page.page,
    workspaces: page.rows.map(summaryFromRow),
  };
}

export async function getWorkspaceAccess(
  database: D1DatabaseLike,
  workspaceId: string,
  userId: string,
) {
  const db = databaseLike(database);
  const context = await workspaceContext(db, workspaceId, userId);
  const response: Record<string, unknown> = {
    access: accessFromContext(context),
    guestLinkPolicy: {
      maximumExpiryHours: GUEST_LINK_EXPIRY_HOURS.maximum,
      minimumExpiryHours: GUEST_LINK_EXPIRY_HOURS.minimum,
      roles: [...GUEST_LINK_ROLES],
    },
    workspace: summaryFromRow(context),
  };
  if (context.role === "owner") {
    const usage = await db.prepare(
      `SELECT
         (
           SELECT COUNT(*) FROM workspace_members
           WHERE workspace_id=snapshot.workspace_id
         ) AS members,
         (
           SELECT COUNT(*) FROM workspace_members
           WHERE workspace_id=snapshot.workspace_id AND role='owner'
         ) AS owners,
         (
           SELECT COUNT(*) FROM guest_links
           WHERE workspace_id=snapshot.workspace_id
         ) AS retained_links,
         (
           SELECT COUNT(*) FROM guest_links
           WHERE workspace_id=snapshot.workspace_id
             AND consumed_at IS NULL
             AND revoked_at IS NULL
             AND expires_at>?
         ) AS active_links
       FROM workspace_snapshots snapshot
       JOIN workspace_members actor
         ON actor.workspace_id=snapshot.workspace_id
        AND actor.user_id=?
        AND actor.role='owner'
       JOIN users actor_user
         ON actor_user.user_id=actor.user_id
        AND actor_user.status='active'
       WHERE snapshot.workspace_id=?`,
    ).bind(
      nowIso(),
      userId,
      workspaceId,
    ).first<{
      active_links: number;
      members: number;
      owners: number;
      retained_links: number;
    }>();
    if (usage) {
      response.usage = {
        activeGuestLinks: {
          limit: API_QUOTAS.activeGuestLinksPerWorkspace,
          used: usage.active_links,
        },
        members: {
          limit: API_QUOTAS.membersPerWorkspace,
          used: usage.members,
        },
        owners: usage.owners,
        retainedGuestLinks: {
          limit: API_QUOTAS.retainedGuestLinksPerWorkspace,
          used: usage.retained_links,
        },
      };
    }
  }
  return response;
}

export async function listWorkspaceMembers(
  database: D1DatabaseLike,
  workspaceId: string,
  actorUserId: string,
  searchParams: URLSearchParams,
) {
  const db = databaseLike(database);
  const context = await ownerContext(db, workspaceId, actorUserId);
  const limit = boundedPageLimit(searchParams);
  const query = normalizedQuery(searchParams);
  const cursor = memberCursor(
    searchParams.get("cursor"),
    query,
    context.access_revision,
  );
  const conditions = [
    "target.workspace_id=?",
    `EXISTS (
      SELECT 1 FROM workspace_snapshots snapshot
      WHERE snapshot.workspace_id=target.workspace_id
        AND snapshot.access_revision=?
    )`,
    `EXISTS (
      SELECT 1
      FROM workspace_members actor
      JOIN users actor_user ON actor_user.user_id=actor.user_id
      WHERE actor.workspace_id=target.workspace_id
        AND actor.user_id=?
        AND actor.role='owner'
        AND actor_user.status='active'
    )`,
  ];
  const values: unknown[] = [
    workspaceId,
    context.access_revision,
    actorUserId,
  ];
  if (query) {
    const pattern = `%${escapeLike(query)}%`;
    conditions.push(
      "(lower(target_user.display_name) LIKE ? ESCAPE '\\' OR lower(target_user.email) LIKE ? ESCAPE '\\')",
    );
    values.push(pattern, pattern);
  }
  if (cursor) {
    conditions.push(
      "(target.created_at>? OR (target.created_at=? AND target.user_id>?))",
    );
    values.push(cursor.createdAt, cursor.createdAt, cursor.id);
  }
  values.push(limit + 1);
  const result = await db.prepare(
    `SELECT target.user_id,target.role,target.created_at,
            target_user.display_name,target_user.email,
            target_user.membership_revision,target_user.status,
            CASE WHEN EXISTS (
              SELECT 1 FROM identities identity
              WHERE identity.user_id=target.user_id
                AND identity.provider='guest'
            ) AND NOT EXISTS (
              SELECT 1 FROM identities identity
              WHERE identity.user_id=target.user_id
                AND identity.provider<>'guest'
            ) THEN 1 ELSE 0 END AS guest_identity
     FROM workspace_members target
     JOIN users target_user ON target_user.user_id=target.user_id
     WHERE ${conditions.join("\n       AND ")}
     ORDER BY target.created_at ASC,target.user_id ASC
     LIMIT ?`,
  ).bind(...values).all<MemberRow>();
  const page = pageInfo(result.results, limit, row => encodeCursor({
    accessRevision: context.access_revision,
    createdAt: row.created_at,
    id: row.user_id,
    kind: "members",
    query,
    version: 1,
  }));
  const finalContext = await ownerContext(db, workspaceId, actorUserId);
  if (finalContext.access_revision !== context.access_revision) {
    throw new ApiProblem(
      "ACCESS_STALE",
      "Workspace access changed; restart the member refresh",
      409,
      { access: accessFromContext(finalContext) },
    );
  }
  return {
    accessRevision: context.access_revision,
    members: page.rows.map(memberResponse),
    page: page.page,
  };
}

export async function changeWorkspaceMemberRole(
  database: D1DatabaseLike,
  workspaceId: string,
  actorUserId: string,
  targetUserId: string,
  value: unknown,
) {
  const input = parseRoleChange(value);
  const db = databaseLike(database);
  const before = await explainMemberMutationRefusal(
    db,
    workspaceId,
    actorUserId,
    targetUserId,
    input.expectedAccessRevision,
    input.expectedMembershipRevision,
    input.role,
  );
  if (before.target.role === input.role) {
    throw new ApiProblem(
      "ROLE_UNCHANGED",
      `The workspace member already has the ${input.role} role`,
      409,
    );
  }
  if (
    before.target.role === "owner" &&
    before.target.status === "active" &&
    input.role !== "owner" &&
    before.context.owner_count <= 1
  ) {
    throw new ApiProblem(
      "FINAL_OWNER_REQUIRED",
      "A workspace must retain at least one owner",
      409,
    );
  }
  const at = nowIso();
  const targetId = `${workspaceId}::${targetUserId}`;
  const [, audit, committed] = await db.batch([
    db.prepare(
      `UPDATE workspace_members
       SET role=?
       WHERE workspace_id=?
         AND user_id=?
         AND role<>?
         AND EXISTS (
           SELECT 1 FROM workspace_snapshots snapshot
           WHERE snapshot.workspace_id=workspace_members.workspace_id
             AND snapshot.access_revision=?
         )
         AND EXISTS (
           SELECT 1 FROM workspace_members actor
           JOIN users actor_user ON actor_user.user_id=actor.user_id
           WHERE actor.workspace_id=workspace_members.workspace_id
             AND actor.user_id=?
             AND actor.role='owner'
             AND actor_user.status='active'
         )
         AND EXISTS (
           SELECT 1 FROM users target_user
           WHERE target_user.user_id=workspace_members.user_id
             AND target_user.membership_revision=?
             AND (?<>'owner' OR target_user.status='active')
         )
         AND (
           role<>'owner'
           OR ?='owner'
           OR NOT EXISTS (
             SELECT 1 FROM users target_owner
             WHERE target_owner.user_id=workspace_members.user_id
               AND target_owner.status='active'
           )
           OR (
             SELECT COUNT(*)
             FROM workspace_members owners
             JOIN users owner_user ON owner_user.user_id=owners.user_id
             WHERE owners.workspace_id=workspace_members.workspace_id
               AND owners.role='owner'
               AND owner_user.status='active'
           )>1
         )
         AND (
           ?<>'owner'
           OR role='owner'
           OR (
             SELECT COUNT(*)
             FROM workspace_members owned
             WHERE owned.user_id=workspace_members.user_id
               AND owned.role='owner'
           )<?
         )`,
    ).bind(
      input.role,
      workspaceId,
      targetUserId,
      input.role,
      input.expectedAccessRevision,
      actorUserId,
      input.expectedMembershipRevision,
      input.role,
      input.role,
      input.role,
      API_QUOTAS.ownedWorkspacesPerUser,
    ),
    auditStatement(
      db,
      actorUserId,
      "member.role",
      "membership",
      targetId,
      {
        fromRole: before.target.role,
        targetUserId,
        toRole: input.role,
        workspaceId,
      },
      at,
    ),
    memberMutationResultStatement(
      db,
      workspaceId,
      targetUserId,
    ),
  ]);
  if (resultChanges(audit) !== 1) {
    await explainMemberMutationRefusal(
      db,
      workspaceId,
      actorUserId,
      targetUserId,
      input.expectedAccessRevision,
      input.expectedMembershipRevision,
      input.role,
    );
    throw new ApiProblem(
      "WORKSPACE_BUSY",
      "The membership changed during the request; refresh and try again",
      409,
    );
  }
  const member = requiredBatchRow<MemberMutationRow>(
    committed,
    "Workspace member role change",
  );
  return {
    accessRevision: member.access_revision,
    member: memberResponse(member),
  };
}

export async function removeWorkspaceMember(
  database: D1DatabaseLike,
  workspaceId: string,
  actorUserId: string,
  targetUserId: string,
  value: unknown,
) {
  const input = parseMemberRemoval(value);
  const db = databaseLike(database);
  if (actorUserId === targetUserId) {
    throw new ApiProblem(
      "INVALID_REQUEST",
      "Use the leave workspace action to remove your own membership",
      409,
    );
  }
  const before = await explainMemberMutationRefusal(
    db,
    workspaceId,
    actorUserId,
    targetUserId,
    input.expectedAccessRevision,
    input.expectedMembershipRevision,
  );
  if (
    before.target.role === "owner" &&
    before.target.status === "active" &&
    before.context.owner_count <= 1
  ) {
    throw new ApiProblem(
      "FINAL_OWNER_REQUIRED",
      "A workspace must retain at least one owner",
      409,
    );
  }
  const at = nowIso();
  const targetId = `${workspaceId}::${targetUserId}`;
  const [, audit, committed] = await db.batch([
    db.prepare(
      `DELETE FROM workspace_members
       WHERE workspace_id=?
         AND user_id=?
         AND EXISTS (
           SELECT 1 FROM workspace_snapshots snapshot
           WHERE snapshot.workspace_id=workspace_members.workspace_id
             AND snapshot.access_revision=?
         )
         AND EXISTS (
           SELECT 1 FROM workspace_members actor
           JOIN users actor_user ON actor_user.user_id=actor.user_id
           WHERE actor.workspace_id=workspace_members.workspace_id
             AND actor.user_id=?
             AND actor.role='owner'
             AND actor_user.status='active'
         )
         AND EXISTS (
           SELECT 1 FROM users target_user
           WHERE target_user.user_id=workspace_members.user_id
             AND target_user.membership_revision=?
         )
         AND (
           role<>'owner'
           OR NOT EXISTS (
             SELECT 1 FROM users target_owner
             WHERE target_owner.user_id=workspace_members.user_id
               AND target_owner.status='active'
           )
           OR (
             SELECT COUNT(*)
             FROM workspace_members owners
             JOIN users owner_user ON owner_user.user_id=owners.user_id
             WHERE owners.workspace_id=workspace_members.workspace_id
               AND owners.role='owner'
               AND owner_user.status='active'
           )>1
         )`,
    ).bind(
      workspaceId,
      targetUserId,
      input.expectedAccessRevision,
      actorUserId,
      input.expectedMembershipRevision,
    ),
    auditStatement(
      db,
      actorUserId,
      "member.remove",
      "membership",
      targetId,
      {
        role: before.target.role,
        targetUserId,
        workspaceId,
      },
      at,
    ),
    accessRevisionResultStatement(db, workspaceId),
  ]);
  if (resultChanges(audit) !== 1) {
    await explainMemberMutationRefusal(
      db,
      workspaceId,
      actorUserId,
      targetUserId,
      input.expectedAccessRevision,
      input.expectedMembershipRevision,
    );
    throw new ApiProblem(
      "WORKSPACE_BUSY",
      "The membership changed during the request; refresh and try again",
      409,
    );
  }
  const result = requiredBatchRow<AccessRevisionRow>(
    committed,
    "Workspace member removal",
  );
  return {
    accessRevision: result.access_revision,
    removed: {
      at,
      role: before.target.role,
      userId: targetUserId,
    },
  };
}

export async function transferWorkspaceOwnership(
  database: D1DatabaseLike,
  workspaceId: string,
  actorUserId: string,
  value: unknown,
) {
  const input = parseOwnershipTransfer(value);
  const db = databaseLike(database);
  if (input.targetUserId === actorUserId) {
    throw new ApiProblem(
      "INVALID_REQUEST",
      "Ownership must be transferred to another member",
      400,
    );
  }
  const context = await ownerContext(db, workspaceId, actorUserId);
  assertExpectedAccess(context, input.expectedAccessRevision);
  if (context.membership_revision !== input.expectedActorMembershipRevision) {
    throw new ApiProblem(
      "ACCESS_STALE",
      "Your membership changed; refresh and try again",
      409,
      { access: accessFromContext(context) },
    );
  }
  const target = await currentMember(db, workspaceId, input.targetUserId);
  if (!target) {
    throw new ApiProblem(
      "NOT_FOUND_OR_INACCESSIBLE",
      "The target workspace member was not found",
      404,
    );
  }
  if (target.membership_revision !== input.expectedTargetMembershipRevision) {
    throw new ApiProblem(
      "ACCESS_STALE",
      "The target membership changed; refresh and try again",
      409,
      { member: memberResponse(target) },
    );
  }
  if (target.role === "owner") {
    throw new ApiProblem(
      "ROLE_UNCHANGED",
      "The target member is already an owner",
      409,
    );
  }
  assertActiveOwnershipTarget(target);
  await assertOwnerPromotionQuota(db, input.targetUserId);
  const at = nowIso();
  const [, audit, committedActor, committedTarget] = await db.batch([
    db.prepare(
      `UPDATE workspace_members
       SET role=CASE
         WHEN user_id=? THEN 'editor'
         ELSE 'owner'
       END
       WHERE workspace_id=?
         AND user_id IN (?,?)
         AND EXISTS (
           SELECT 1 FROM workspace_snapshots snapshot
           WHERE snapshot.workspace_id=workspace_members.workspace_id
             AND snapshot.access_revision=?
         )
         AND EXISTS (
           SELECT 1 FROM workspace_members actor
           JOIN users actor_user ON actor_user.user_id=actor.user_id
           WHERE actor.workspace_id=workspace_members.workspace_id
             AND actor.user_id=?
             AND actor.role='owner'
             AND actor_user.status='active'
             AND actor_user.membership_revision=?
         )
         AND EXISTS (
           SELECT 1 FROM workspace_members target
           JOIN users target_user ON target_user.user_id=target.user_id
           WHERE target.workspace_id=workspace_members.workspace_id
             AND target.user_id=?
             AND target.role<>'owner'
             AND target_user.membership_revision=?
             AND target_user.status='active'
             AND (
               SELECT COUNT(*)
               FROM workspace_members owned
               WHERE owned.user_id=target.user_id
                 AND owned.role='owner'
             )<?
         )`,
    ).bind(
      actorUserId,
      workspaceId,
      actorUserId,
      input.targetUserId,
      input.expectedAccessRevision,
      actorUserId,
      input.expectedActorMembershipRevision,
      input.targetUserId,
      input.expectedTargetMembershipRevision,
      API_QUOTAS.ownedWorkspacesPerUser,
    ),
    auditStatement(
      db,
      actorUserId,
      "ownership.transfer",
      "workspace",
      workspaceId,
      {
        actorRole: "editor",
        targetRole: "owner",
        targetUserId: input.targetUserId,
        workspaceId,
      },
      at,
      2,
    ),
    memberMutationResultStatement(
      db,
      workspaceId,
      actorUserId,
    ),
    memberMutationResultStatement(
      db,
      workspaceId,
      input.targetUserId,
    ),
  ]);
  if (resultChanges(audit) !== 1) {
    const current = await ownerContext(db, workspaceId, actorUserId);
    assertExpectedAccess(current, input.expectedAccessRevision);
    const nextTarget = await currentMember(
      db,
      workspaceId,
      input.targetUserId,
    );
    if (!nextTarget) {
      if (await deletedByCaller(db, workspaceId, actorUserId)) {
        return inaccessible(db, workspaceId, actorUserId);
      }
      throw new ApiProblem(
        "NOT_FOUND_OR_INACCESSIBLE",
        "The target workspace member was not found",
        404,
      );
    }
    if (nextTarget.role !== "owner") {
      assertActiveOwnershipTarget(nextTarget);
      await assertOwnerPromotionQuota(db, input.targetUserId);
    }
    if (
      current.membership_revision !==
      input.expectedActorMembershipRevision
    ) {
      throw new ApiProblem(
        "ACCESS_STALE",
        "Your membership changed; refresh and try again",
        409,
        { access: accessFromContext(current) },
      );
    }
    if (
      nextTarget.membership_revision !==
      input.expectedTargetMembershipRevision
    ) {
      throw new ApiProblem(
        "ACCESS_STALE",
        "The target membership changed; refresh and try again",
        409,
        { member: memberResponse(nextTarget) },
      );
    }
    if (nextTarget.role === "owner") {
      throw new ApiProblem(
        "ROLE_UNCHANGED",
        "The target member is already an owner",
        409,
      );
    }
    throw new ApiProblem(
      "WORKSPACE_BUSY",
      "Workspace access changed during transfer; refresh and try again",
      409,
    );
  }
  const actor = requiredBatchRow<MemberMutationRow>(
    committedActor,
    "Ownership transfer actor",
  );
  const nextTarget = requiredBatchRow<MemberMutationRow>(
    committedTarget,
    "Ownership transfer target",
  );
  return {
    accessRevision: actor.access_revision,
    actor: memberResponse(actor),
    target: memberResponse(nextTarget),
  };
}

export async function leaveWorkspace(
  database: D1DatabaseLike,
  workspaceId: string,
  actorUserId: string,
  value: unknown,
) {
  const input = parseLeaveWorkspace(value);
  const db = databaseLike(database);
  const context = await workspaceContext(db, workspaceId, actorUserId);
  assertExpectedAccess(context, input.expectedAccessRevision);
  if (context.membership_revision !== input.expectedMembershipRevision) {
    throw new ApiProblem(
      "ACCESS_STALE",
      "Your membership changed; refresh and try again",
      409,
      { access: accessFromContext(context) },
    );
  }
  if (context.role === "owner" && context.owner_count <= 1) {
    throw new ApiProblem(
      "FINAL_OWNER_REQUIRED",
      "Transfer ownership or delete the server workspace before leaving",
      409,
    );
  }
  const at = nowIso();
  const targetId = `${workspaceId}::${actorUserId}`;
  const [, audit] = await db.batch([
    db.prepare(
      `DELETE FROM workspace_members
       WHERE workspace_id=?
         AND user_id=?
         AND EXISTS (
           SELECT 1 FROM workspace_snapshots snapshot
           WHERE snapshot.workspace_id=workspace_members.workspace_id
             AND snapshot.access_revision=?
         )
         AND EXISTS (
           SELECT 1 FROM users actor_user
           WHERE actor_user.user_id=workspace_members.user_id
             AND actor_user.status='active'
             AND actor_user.membership_revision=?
         )
         AND (
           role<>'owner'
           OR (
             SELECT COUNT(*)
             FROM workspace_members owners
             JOIN users owner_user ON owner_user.user_id=owners.user_id
             WHERE owners.workspace_id=workspace_members.workspace_id
               AND owners.role='owner'
               AND owner_user.status='active'
           )>1
         )`,
    ).bind(
      workspaceId,
      actorUserId,
      input.expectedAccessRevision,
      input.expectedMembershipRevision,
    ),
    auditStatement(
      db,
      actorUserId,
      "member.leave",
      "membership",
      targetId,
      { role: context.role, userId: actorUserId, workspaceId },
      at,
    ),
  ]);
  if (resultChanges(audit) !== 1) {
    const current = await workspaceContext(db, workspaceId, actorUserId);
    assertExpectedAccess(current, input.expectedAccessRevision);
    throw new ApiProblem(
      "WORKSPACE_BUSY",
      "Workspace access changed during the request; refresh and try again",
      409,
    );
  }
  const user = await db.prepare(
    "SELECT membership_revision FROM users WHERE user_id=?",
  ).bind(actorUserId).first<{ membership_revision: number }>();
  return {
    accessRevision: input.expectedAccessRevision + 1,
    left: true,
    localReplicaDispositionRequired: true,
    membershipRevision: user?.membership_revision ??
      input.expectedMembershipRevision + 1,
    workspaceId,
  };
}

export async function listWorkspaceGuestLinks(
  database: D1DatabaseLike,
  workspaceId: string,
  actorUserId: string,
  searchParams: URLSearchParams,
) {
  const db = databaseLike(database);
  const context = await ownerContext(db, workspaceId, actorUserId);
  const limit = boundedPageLimit(searchParams);
  const status = guestStatusFilter(searchParams);
  const cursor = guestLinkCursor(
    searchParams.get("cursor"),
    status,
    context.access_revision,
  );
  const at = nowIso();
  const conditions = [
    "link.workspace_id=?",
    `EXISTS (
      SELECT 1
      FROM workspace_members actor
      JOIN users actor_user ON actor_user.user_id=actor.user_id
      WHERE actor.workspace_id=link.workspace_id
        AND actor.user_id=?
        AND actor.role='owner'
        AND actor_user.status='active'
    )`,
    `EXISTS (
      SELECT 1 FROM workspace_snapshots snapshot
      WHERE snapshot.workspace_id=link.workspace_id
        AND snapshot.access_revision=?
    )`,
  ];
  const values: unknown[] = [
    workspaceId,
    actorUserId,
    context.access_revision,
  ];
  if (status === "active") {
    conditions.push(
      "link.consumed_at IS NULL AND link.revoked_at IS NULL AND link.expires_at>?",
    );
    values.push(at);
  } else if (status === "used") {
    conditions.push("link.consumed_at IS NOT NULL");
  } else if (status === "revoked") {
    conditions.push("link.revoked_at IS NOT NULL");
  } else if (status === "expired") {
    conditions.push(
      "link.consumed_at IS NULL AND link.revoked_at IS NULL AND link.expires_at<=?",
    );
    values.push(at);
  }
  if (cursor) {
    conditions.push(
      "(link.created_at<? OR (link.created_at=? AND link.guest_link_id>?))",
    );
    values.push(cursor.createdAt, cursor.createdAt, cursor.id);
  }
  values.push(limit + 1);
  const result = await db.prepare(
    `SELECT link.guest_link_id,link.role,link.created_at,link.expires_at,
            link.consumed_at,link.revoked_at,
            CASE
              WHEN link.revoked_at IS NOT NULL THEN 'revoked'
              WHEN link.consumed_at IS NOT NULL THEN 'used'
              WHEN link.expires_at<=? THEN 'expired'
              ELSE 'active'
            END AS status
     FROM guest_links link
     WHERE ${conditions.join("\n       AND ")}
     ORDER BY link.created_at DESC,link.guest_link_id ASC
     LIMIT ?`,
  ).bind(at, ...values).all<GuestLinkRow>();
  const page = pageInfo(result.results, limit, row => encodeCursor({
    accessRevision: context.access_revision,
    createdAt: row.created_at,
    id: row.guest_link_id,
    kind: "guest-links",
    status,
    version: 1,
  }));
  const finalContext = await ownerContext(db, workspaceId, actorUserId);
  if (finalContext.access_revision !== context.access_revision) {
    throw new ApiProblem(
      "ACCESS_STALE",
      "Workspace access changed; restart the guest-link refresh",
      409,
      { access: accessFromContext(finalContext) },
    );
  }
  return {
    accessRevision: context.access_revision,
    guestLinks: page.rows.map(guestLinkResponse),
    page: page.page,
  };
}

export async function createWorkspaceGuestLink(
  database: D1DatabaseLike,
  workspaceId: string,
  actorUserId: string,
  value: unknown,
) {
  const input = parseCreateGuestLink(value);
  const db = databaseLike(database);
  const context = await ownerContext(db, workspaceId, actorUserId);
  assertExpectedAccess(context, input.expectedAccessRevision);
  const raw = randomToken();
  const guestLinkId = newId("guest");
  const at = nowIso();
  const expiresAt = new Date(
    Date.parse(at) + input.expiresInHours * 3_600_000,
  ).toISOString();
  const [, audit, committed] = await db.batch([
    db.prepare(
      `INSERT INTO guest_links(
         guest_link_id,workspace_id,created_by_user_id,token_hash,role,
         created_at,expires_at
       )
       SELECT ?,?,?,?,?,?,?
       FROM workspace_snapshots snapshot
       WHERE snapshot.workspace_id=?
         AND snapshot.access_revision=?
         AND EXISTS (
           SELECT 1 FROM workspace_members actor
           JOIN users actor_user ON actor_user.user_id=actor.user_id
           WHERE actor.workspace_id=snapshot.workspace_id
             AND actor.user_id=?
             AND actor.role='owner'
             AND actor_user.status='active'
         )
         AND (
           SELECT COUNT(*)
           FROM guest_links retained
           WHERE retained.workspace_id=snapshot.workspace_id
         )<?
         AND (
           SELECT COUNT(*)
           FROM guest_links active
           WHERE active.workspace_id=snapshot.workspace_id
             AND active.consumed_at IS NULL
             AND active.revoked_at IS NULL
             AND active.expires_at>?
         )<?`,
    ).bind(
      guestLinkId,
      workspaceId,
      actorUserId,
      await tokenHash(raw),
      input.role,
      at,
      expiresAt,
      workspaceId,
      input.expectedAccessRevision,
      actorUserId,
      API_QUOTAS.retainedGuestLinksPerWorkspace,
      at,
      API_QUOTAS.activeGuestLinksPerWorkspace,
    ),
    auditStatement(
      db,
      actorUserId,
      "guest.create",
      "guest_link",
      guestLinkId,
      {
        expiresAt,
        role: input.role,
        workspaceId,
      },
      at,
    ),
    guestLinkMutationResultStatement(
      db,
      workspaceId,
      guestLinkId,
      at,
    ),
  ]);
  if (resultChanges(audit) !== 1) {
    const current = await ownerContext(db, workspaceId, actorUserId);
    const usage = await guestLinkUsage(db, workspaceId, at);
    if (usage.retained >= API_QUOTAS.retainedGuestLinksPerWorkspace) {
      throw new QuotaExceededError(
        "retainedGuestLinksPerWorkspace",
        usage.retained + 1,
      );
    }
    if (usage.active >= API_QUOTAS.activeGuestLinksPerWorkspace) {
      throw new QuotaExceededError(
        "activeGuestLinksPerWorkspace",
        usage.active + 1,
      );
    }
    assertExpectedAccess(current, input.expectedAccessRevision);
    throw new ApiProblem(
      "WORKSPACE_BUSY",
      "Workspace access changed during link creation; refresh and try again",
      409,
    );
  }
  const link = requiredBatchRow<GuestLinkMutationRow>(
    committed,
    "Guest link creation",
  );
  return {
    accessRevision: link.access_revision,
    guestLink: guestLinkResponse(link),
    raw,
    returnTo: workspaceReturnTo(input.returnTo, workspaceId),
  };
}

export async function revokeWorkspaceGuestLink(
  database: D1DatabaseLike,
  workspaceId: string,
  actorUserId: string,
  guestLinkId: string,
  value: unknown,
) {
  const input = parseRevokeGuestLink(value);
  const db = databaseLike(database);
  const context = await ownerContext(db, workspaceId, actorUserId);
  assertExpectedAccess(context, input.expectedAccessRevision);
  const at = nowIso();
  const before = await currentGuestLink(db, workspaceId, guestLinkId, at);
  if (!before) {
    throw new ApiProblem(
      "NOT_FOUND_OR_INACCESSIBLE",
      "The guest link was not found",
      404,
    );
  }
  if (before.status !== "active") {
    throw new ApiProblem(
      "ACCESS_STALE",
      `The guest link is ${before.status} and cannot be revoked`,
      409,
      { guestLink: guestLinkResponse(before) },
    );
  }
  const [, audit, committed] = await db.batch([
    db.prepare(
      `UPDATE guest_links
       SET revoked_at=?
       WHERE guest_link_id=?
         AND workspace_id=?
         AND revoked_at IS NULL
         AND consumed_at IS NULL
         AND expires_at>?
         AND EXISTS (
           SELECT 1 FROM workspace_snapshots snapshot
           WHERE snapshot.workspace_id=guest_links.workspace_id
             AND snapshot.access_revision=?
         )
         AND EXISTS (
           SELECT 1 FROM workspace_members actor
           JOIN users actor_user ON actor_user.user_id=actor.user_id
           WHERE actor.workspace_id=guest_links.workspace_id
             AND actor.user_id=?
             AND actor.role='owner'
             AND actor_user.status='active'
         )`,
    ).bind(
      at,
      guestLinkId,
      workspaceId,
      at,
      input.expectedAccessRevision,
      actorUserId,
    ),
    auditStatement(
      db,
      actorUserId,
      "guest.revoke",
      "guest_link",
      guestLinkId,
      { role: before.role, workspaceId },
      at,
    ),
    guestLinkMutationResultStatement(
      db,
      workspaceId,
      guestLinkId,
      at,
    ),
  ]);
  if (resultChanges(audit) !== 1) {
    const current = await ownerContext(db, workspaceId, actorUserId);
    assertExpectedAccess(current, input.expectedAccessRevision);
    const link = await currentGuestLink(db, workspaceId, guestLinkId, at);
    if (!link) {
      throw new ApiProblem(
        "NOT_FOUND_OR_INACCESSIBLE",
        "The guest link was not found",
        404,
      );
    }
    throw new ApiProblem(
      "ACCESS_STALE",
      `The guest link is ${link.status} and cannot be revoked`,
      409,
      { guestLink: guestLinkResponse(link) },
    );
  }
  const link = requiredBatchRow<GuestLinkMutationRow>(
    committed,
    "Guest link revocation",
  );
  return {
    accessRevision: link.access_revision,
    guestLink: guestLinkResponse(link),
  };
}

export async function deleteServerWorkspace(
  database: D1DatabaseLike,
  workspaceId: string,
  actorUserId: string,
  value: unknown,
) {
  const input = parseDeleteWorkspace(value);
  const db = databaseLike(database);
  const context = await ownerContext(db, workspaceId, actorUserId);
  assertExpectedAccess(context, input.expectedAccessRevision);
  if (context.membership_revision !== input.expectedMembershipRevision) {
    throw new ApiProblem(
      "ACCESS_STALE",
      "Your membership changed; refresh and try again",
      409,
      { access: accessFromContext(context) },
    );
  }
  if (
    context.revision !== input.expectedRevision ||
    context.name !== input.confirmationName
  ) {
    throw new ApiProblem(
      "CONFIRMATION_REQUIRED",
      "The workspace changed; confirm its current name and revision",
      409,
      {
        currentName: context.name,
        currentRevision: context.revision,
      },
    );
  }
  if (context.access_revision >= MAXIMUM_SAFE_REVISION) {
    throw new ApiProblem(
      "WORKSPACE_BUSY",
      "The workspace access revision counter is exhausted",
      409,
    );
  }
  const deletionId = newId("deletion");
  const deletedAt = nowIso();
  const detail = {
    deletionId,
    finalSnapshotRevision: context.revision,
    workspaceId,
  };
  const results = await db.batch([
    db.prepare(
      `INSERT INTO workspace_deletions(
         workspace_id,deletion_id,deleted_at,deleted_by_user_id,
         final_snapshot_revision,final_access_revision
       )
       SELECT snapshot.workspace_id,?,?,?,
              snapshot.revision,snapshot.access_revision+1
       FROM workspace_snapshots snapshot
       JOIN workspace_members actor
         ON actor.workspace_id=snapshot.workspace_id
        AND actor.user_id=?
        AND actor.role='owner'
       JOIN users actor_user
         ON actor_user.user_id=actor.user_id
        AND actor_user.status='active'
       WHERE snapshot.workspace_id=?
         AND snapshot.revision=?
         AND snapshot.access_revision=?
         AND actor_user.membership_revision=?
         AND json_extract(
           snapshot.state_json,
           '$.workspace.name'
         )=?
         AND snapshot.access_revision<?
         AND NOT EXISTS (
           SELECT 1 FROM workspace_deletions prior
           WHERE prior.workspace_id=snapshot.workspace_id
         )`,
    ).bind(
      deletionId,
      deletedAt,
      actorUserId,
      actorUserId,
      workspaceId,
      input.expectedRevision,
      input.expectedAccessRevision,
      input.expectedMembershipRevision,
      input.confirmationName,
      MAXIMUM_SAFE_REVISION,
    ),
    auditStatement(
      db,
      actorUserId,
      "workspace.delete",
      "workspace",
      workspaceId,
      detail,
      deletedAt,
    ),
    db.prepare(
      `UPDATE sessions
       SET revoked_at=?
       WHERE revoked_at IS NULL
         AND expires_at>?
         AND user_id IN (
           SELECT member.user_id
           FROM workspace_members member
           WHERE member.workspace_id=?
             AND EXISTS (
               SELECT 1 FROM identities identity
               WHERE identity.user_id=member.user_id
                 AND identity.provider='guest'
             )
             AND NOT EXISTS (
               SELECT 1 FROM identities identity
               WHERE identity.user_id=member.user_id
                 AND identity.provider<>'guest'
             )
             AND NOT EXISTS (
               SELECT 1 FROM workspace_members other
               WHERE other.user_id=member.user_id
                 AND other.workspace_id<>member.workspace_id
             )
         )
         AND EXISTS (
           SELECT 1 FROM workspace_deletions deleted
           WHERE deleted.workspace_id=?
             AND deleted.deletion_id=?
         )`,
    ).bind(
      deletedAt,
      deletedAt,
      workspaceId,
      workspaceId,
      deletionId,
    ),
    db.prepare(
      `DELETE FROM guest_links
       WHERE workspace_id=?
         AND EXISTS (
           SELECT 1 FROM workspace_deletions deleted
           WHERE deleted.workspace_id=guest_links.workspace_id
             AND deleted.deletion_id=?
         )`,
    ).bind(workspaceId, deletionId),
    db.prepare(
      `DELETE FROM workspace_members
       WHERE workspace_id=?
         AND EXISTS (
           SELECT 1 FROM workspace_deletions deleted
           WHERE deleted.workspace_id=workspace_members.workspace_id
             AND deleted.deletion_id=?
         )`,
    ).bind(workspaceId, deletionId),
    db.prepare(
      `UPDATE workspace_deletions
       SET final_access_revision=(
         SELECT snapshot.access_revision+1
         FROM workspace_snapshots snapshot
         WHERE snapshot.workspace_id=workspace_deletions.workspace_id
       )
       WHERE workspace_id=?
         AND deletion_id=?
         AND EXISTS (
           SELECT 1 FROM workspace_snapshots snapshot
           WHERE snapshot.workspace_id=workspace_deletions.workspace_id
             AND snapshot.access_revision<?
         )`,
    ).bind(workspaceId, deletionId, MAXIMUM_SAFE_REVISION),
    db.prepare(
      `DELETE FROM workspace_snapshots
       WHERE workspace_id=?
         AND revision=?
         AND EXISTS (
           SELECT 1 FROM workspace_deletions deleted
           WHERE deleted.workspace_id=workspace_snapshots.workspace_id
             AND deleted.deletion_id=?
         )`,
    ).bind(workspaceId, input.expectedRevision, deletionId),
  ]);
  if (
    resultChanges(results[0]) !== 1 ||
    resultChanges(results[1]) !== 1 ||
    resultChanges(results[5]) !== 1 ||
    resultChanges(results[6]) !== 1
  ) {
    if (await deletedByCaller(db, workspaceId, actorUserId)) {
      throw new ApiProblem(
        "WORKSPACE_DELETED",
        "The server workspace was already deleted",
        410,
      );
    }
    const current = await ownerContext(db, workspaceId, actorUserId);
    assertExpectedAccess(current, input.expectedAccessRevision);
    throw new ApiProblem(
      "WORKSPACE_BUSY",
      "The workspace changed during deletion; refresh and try again",
      409,
    );
  }
  const deletion = await db.prepare(
    `SELECT final_access_revision
     FROM workspace_deletions
     WHERE workspace_id=? AND deletion_id=?`,
  ).bind(workspaceId, deletionId).first<{
    final_access_revision: number;
  }>();
  return {
    deleted: true,
    deletedAt,
    deletionId,
    finalAccessRevision: deletion?.final_access_revision ??
      context.access_revision + 1,
    finalSnapshotRevision: context.revision,
    localReplicaDispositionRequired: true,
    recovery: "not_available",
    workspaceId,
  };
}
