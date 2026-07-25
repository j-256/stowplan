"use client";

import { RefreshCw, Search } from "lucide-react";
import Link from "next/link";
import {
  type FormEvent,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { workspacePath } from "../../src/domain/app-url";
import {
  API_QUOTAS,
  type ApiQuotaName,
} from "../../src/shared/api-quotas";
import {
  ACCOUNT_CONTEXT_HEADER,
  accountContextHeaders,
  responseMatchesAccount,
} from "../../src/shared/account-context";

type Row = Record<string, unknown>;

interface ListInfo {
  hasMore: boolean;
  limit: number;
}

interface InventoryMetric {
  kind: "bytes" | "count" | "date" | "text";
  label: string;
  value: number | string | null;
}

interface InventoryEntry {
  key: string;
  label: string;
  metrics: InventoryMetric[];
  rowCount: number;
  table: string;
}

interface Overview {
  audit: Row[];
  databaseInventory?: {
    entries: InventoryEntry[];
    generatedAt: string;
  };
  guestLinks: Row[];
  identities: Row[];
  limits?: Record<ApiQuotaName, number>;
  listInfo?: Partial<Record<
    | "audit"
    | "guestLinks"
    | "identities"
    | "memberships"
    | "sessions"
    | "users"
    | "workspaces",
    ListInfo
  >>;
  memberships: Row[];
  query?: string;
  sessions: Row[];
  users: Row[];
  workspaces?: Row[];
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function numberValue(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : 0;
}

function formatDate(value: unknown): string {
  const date = new Date(stringValue(value));
  return Number.isNaN(date.getTime())
    ? "Unknown"
    : date.toLocaleString();
}

function formatBytes(value: unknown): string {
  const bytes = numberValue(value);
  if (bytes < 1_000) return `${bytes} B`;
  if (bytes < 1_000_000) return `${(bytes / 1_000).toFixed(1)} kB`;
  return `${(bytes / 1_000_000).toFixed(2)} MB`;
}

function formatInventoryMetric(metric: InventoryMetric): string {
  let value: string;
  switch (metric.kind) {
    case "bytes":
      value = formatBytes(metric.value);
      break;
    case "count":
      value = numberValue(metric.value).toLocaleString();
      break;
    case "date":
      value = metric.value ? formatDate(metric.value) : "None";
      break;
    case "text":
      value = stringValue(metric.value) || "Unknown";
      break;
  }
  return `${metric.label}: ${value}`;
}

function resultCount(
  rows: Row[],
  info: ListInfo | undefined,
): string {
  return `${rows.length}${info?.hasMore ? "+" : ""}`;
}

function resultNote(info: ListInfo | undefined): string | null {
  return info?.hasMore
    ? `Showing the first ${info.limit} matches. Search to narrow the list.`
    : null;
}

function guestLinkStatus(row: Row): "available" | "expired" | "revoked" | "used" {
  if (row.revoked_at) return "revoked";
  if (row.consumed_at) return "used";
  return new Date(stringValue(row.expires_at)).getTime() <= Date.now()
    ? "expired"
    : "available";
}

function sessionStatus(row: Row): "active" | "expired" | "revoked" {
  if (row.revoked_at) return "revoked";
  return new Date(stringValue(row.expires_at)).getTime() <= Date.now()
    ? "expired"
    : "active";
}

function prettyDetail(value: unknown): string {
  try {
    return JSON.stringify(JSON.parse(stringValue(value)), null, 2);
  } catch {
    return stringValue(value);
  }
}

function nearLimit(actual: number, limit: number): boolean {
  return limit > 0 && actual / limit >= 0.8;
}

export default function AdminPage() {
  const [data, setData] = useState<Overview | null>(null);
  const [draftQuery, setDraftQuery] = useState("");
  const [query, setQuery] = useState("");
  const [loadError, setLoadError] = useState("");
  const [actionError, setActionError] = useState("");
  const [notice, setNotice] = useState("");
  const [loading, setLoading] = useState(true);
  const [pendingAction, setPendingAction] = useState("");
  const accountId = useRef<string | null>(null);
  const loadRequest = useRef(0);
  const load = useCallback(async (search = "") => {
    const requestId = loadRequest.current + 1;
    loadRequest.current = requestId;
    setLoading(true);
    try {
      const params = new URLSearchParams();
      if (search) params.set("q", search);
      const suffix = params.size ? `?${params.toString()}` : "";
      const expectedAccountId = accountId.current;
      const response = await fetch(
        `/api/admin/overview${suffix}`,
        {
          cache: "no-store",
          headers: expectedAccountId
            ? accountContextHeaders(expectedAccountId)
            : undefined,
        },
      );
      const body = await response.json().catch(() => null) as
        | (Overview & { error?: string })
        | null;
      if (!response.ok) {
        throw new Error(
          body?.error ?? `Could not load admin data (${response.status})`,
        );
      }
      const responseAccountId = response.headers.get(
        ACCOUNT_CONTEXT_HEADER,
      );
      if (
        !responseAccountId ||
        (
          expectedAccountId &&
          !responseMatchesAccount(response, expectedAccountId)
        )
      ) {
        throw new Error(
          "The signed-in account changed; reload the admin page",
        );
      }
      accountId.current = responseAccountId;
      if (!body) throw new Error("Could not read the admin response");
      if (requestId !== loadRequest.current) return false;
      setData(body);
      setLoadError("");
      return true;
    } catch (reason) {
      if (requestId !== loadRequest.current) return false;
      setLoadError(
        reason instanceof Error && reason.message
          ? reason.message
          : "Could not load admin data",
      );
      return false;
    } finally {
      if (requestId === loadRequest.current) setLoading(false);
    }
  }, []);
  useEffect(() => {
    const timer = window.setTimeout(() => void load(query), 0);
    return () => window.clearTimeout(timer);
  }, [load, query]);
  const mutate = async (
    action: string,
    targetId: string,
    value?: string,
  ) => {
    const actionKey = `${action}:${targetId}`;
    if (pendingAction) return;
    setActionError("");
    setNotice("");
    setPendingAction(actionKey);
    try {
      const expectedAccountId = accountId.current;
      if (!expectedAccountId) {
        throw new Error(
          "Administrative account context is not ready; reload the page",
        );
      }
      const response = await fetch("/api/admin/mutate", {
        body: JSON.stringify({ action, targetId, value }),
        headers: accountContextHeaders(expectedAccountId, {
          "content-type": "application/json",
        }),
        method: "POST",
      });
      const body = await response.json().catch(() => null) as {
        error?: string;
        message?: string;
      } | null;
      if (!response.ok) {
        throw new Error(
          body?.error ?? `Admin mutation failed (${response.status})`,
        );
      }
      if (!responseMatchesAccount(response, expectedAccountId)) {
        throw new Error(
          "The signed-in account changed; the administrative change was not accepted",
        );
      }
      const refreshed = await load(query);
      setNotice(
        refreshed
          ? body?.message ?? "Administrative change saved"
          : `${body?.message ?? "Administrative change saved"}, but the records could not be refreshed`,
      );
    } catch (reason) {
      setActionError(
        reason instanceof Error && reason.message
          ? reason.message
          : "Admin mutation failed",
      );
    } finally {
      setPendingAction("");
    }
  };
  const submitSearch = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const next = draftQuery.trim();
    setActionError("");
    setNotice("");
    if (next === query) {
      void load(next);
    } else {
      setQuery(next);
    }
  };
  const limits = data?.limits ?? API_QUOTAS;
  const inventoryEntries = data?.databaseInventory?.entries ?? [];
  const workspaces = data?.workspaces ?? [];

  return <main className="admin-page">
    <header>
      <div>
        <p className="eyebrow">Server-enforced control plane</p>
        <h1>Stowplan administration</h1>
      </div>
      <Link href="/">Back to organizer</Link>
    </header>
    <form className="admin-toolbar" onSubmit={submitSearch}>
      <label>
        <span>Search server records</span>
        <span className="admin-search-field">
          <Search aria-hidden="true" />
          <input
            aria-label="Search server records"
            onChange={event => setDraftQuery(event.target.value)}
            placeholder="Email, workspace, action, or ID"
            type="search"
            value={draftQuery}
          />
        </span>
      </label>
      <button type="submit">
        Search
      </button>
      <button
        aria-label="Refresh admin records"
        disabled={loading}
        onClick={() => void load(query)}
        type="button"
      >
        <RefreshCw aria-hidden="true" />
        Refresh
      </button>
    </form>
    {query && <p className="admin-filter-note">
      Filtered by <strong>{query}</strong>
      <button
        onClick={() => {
          setDraftQuery("");
          setQuery("");
        }}
        type="button"
      >
        Clear
      </button>
    </p>}
    {loadError && <div className="admin-error" role="alert">
      <strong>{loadError}</strong>
      {!data && <>
        <p>The admin panel needs a configured server database plus an authenticated app administrator.</p>
        <Link href="/account?returnTo=/admin">Sign in or inspect server setup</Link>
        <Link href="/docs/">Open the testing guide</Link>
      </>}
    </div>}
    {actionError && <div className="admin-error" role="alert">
      <strong>{actionError}</strong>
      <p>The change could not be confirmed. Refresh records before retrying.</p>
    </div>}
    {notice && <output className="admin-notice">{notice}</output>}
    {!data && loading && <p>Loading administrative records...</p>}
    {data && <>
      <section>
        <h2>Capacity limits</h2>
        <div className="admin-quota-grid">
          <span><strong>{limits.ownedWorkspacesPerUser}</strong><small>owned workspaces per account</small></span>
          <span><strong>{limits.membersPerWorkspace}</strong><small>members per workspace</small></span>
          <span><strong>{limits.activeGuestLinksPerWorkspace}</strong><small>active invite links per workspace</small></span>
          <span><strong>{limits.retainedGuestLinksPerWorkspace}</strong><small>retained invite links per workspace</small></span>
          <span><strong>{limits.locationsPerSnapshot}</strong><small>spaces per workspace</small></span>
          <span><strong>{limits.itemsPerSnapshot}</strong><small>items per workspace</small></span>
          <span><strong>{limits.plansPerSnapshot}</strong><small>plans per workspace</small></span>
          <span><strong>{limits.planStepsPerSnapshot}</strong><small>plan steps per workspace</small></span>
          <span><strong>{limits.activitiesPerSnapshot}</strong><small>activity records per workspace</small></span>
          <span><strong>{limits.activityPatchesPerSnapshot}</strong><small>activity patches per workspace</small></span>
          <span><strong>{limits.auditEventsPerSnapshot}</strong><small>history audit events per workspace</small></span>
          <span><strong>{limits.commandReceiptsPerSnapshot}</strong><small>compacted command receipts per workspace</small></span>
          <span><strong>{formatBytes(limits.storedSnapshotBytes)}</strong><small>stored snapshot per workspace</small></span>
        </div>
      </section>
      <section aria-labelledby="database-inventory-heading">
        <h2 id="database-inventory-heading">
          Database inventory <small>{inventoryEntries.length}</small>
        </h2>
        <p className="admin-list-note">
          Bounded aggregate metadata for durable application tables. Workspace contents, raw invite URLs, authentication secrets, and provider assertions are not included.
        </p>
        <div className="admin-table admin-workspaces">
          {inventoryEntries.map(entry => <div key={entry.key}>
            <span>
              <strong>{entry.label}</strong>
              <small>{entry.table}</small>
              {entry.metrics.length > 0 && <small>
                {entry.metrics.map(formatInventoryMetric).join(" · ")}
              </small>}
            </span>
            <b>{entry.rowCount.toLocaleString()} rows</b>
          </div>)}
          {!inventoryEntries.length && <p className="admin-empty">
            Database inventory is unavailable
          </p>}
        </div>
        {data.databaseInventory?.generatedAt && <small>
          Generated {formatDate(data.databaseInventory.generatedAt)}
        </small>}
      </section>
      <section>
        <h2>
          Workspaces <small>{resultCount(
            workspaces,
            data.listInfo?.workspaces,
          )}</small>
        </h2>
        {resultNote(data.listInfo?.workspaces) && <p className="admin-list-note">
          {resultNote(data.listInfo?.workspaces)}
        </p>}
        <div className="admin-table admin-workspaces">
          {workspaces.map(workspace => {
            const workspaceId = stringValue(workspace.workspace_id);
            const workspaceName =
              stringValue(workspace.workspace_name) || workspaceId;
            const memberCount = numberValue(workspace.member_count);
            const activeLinkCount =
              numberValue(workspace.active_guest_link_count);
            const retainedLinkCount =
              numberValue(workspace.retained_guest_link_count);
            const snapshotBytes = numberValue(workspace.snapshot_bytes);
            const activityCount = numberValue(workspace.activity_count);
            const activityPatchCount =
              numberValue(workspace.activity_patch_count);
            const auditEventCount =
              numberValue(workspace.audit_event_count);
            const commandReceiptCount =
              numberValue(workspace.command_receipt_count);
            const locationCount = numberValue(workspace.location_count);
            const itemCount = numberValue(workspace.item_count);
            const planCount = numberValue(workspace.plan_count);
            const planStepCount = numberValue(workspace.plan_step_count);
            const collaborationNearLimit =
              nearLimit(memberCount, limits.membersPerWorkspace) ||
              nearLimit(
                activeLinkCount,
                limits.activeGuestLinksPerWorkspace,
              ) ||
              nearLimit(
                retainedLinkCount,
                limits.retainedGuestLinksPerWorkspace,
              );
            const recordsNearLimit =
              nearLimit(
                locationCount,
                limits.locationsPerSnapshot,
              ) ||
              nearLimit(itemCount, limits.itemsPerSnapshot) ||
              nearLimit(planCount, limits.plansPerSnapshot) ||
              nearLimit(planStepCount, limits.planStepsPerSnapshot);
            const historyNearLimit =
              nearLimit(activityCount, limits.activitiesPerSnapshot) ||
              nearLimit(
                activityPatchCount,
                limits.activityPatchesPerSnapshot,
              ) ||
              nearLimit(auditEventCount, limits.auditEventsPerSnapshot) ||
              nearLimit(
                commandReceiptCount,
                limits.commandReceiptsPerSnapshot,
              );
            return <div key={workspaceId}>
              <span>
                <strong>{workspaceName}</strong>
                <small>{workspaceId}</small>
                <small data-near-limit={
                  collaborationNearLimit ||
                  nearLimit(snapshotBytes, limits.storedSnapshotBytes)
                }>
                  {memberCount}/{limits.membersPerWorkspace} members
                  {" · "}
                  {activeLinkCount}/{limits.activeGuestLinksPerWorkspace} active invite links
                  {" · "}
                  {retainedLinkCount}/{limits.retainedGuestLinksPerWorkspace} retained invite links
                  {" · "}
                  {formatBytes(snapshotBytes)}/{formatBytes(limits.storedSnapshotBytes)}
                </small>
                <small data-near-limit={recordsNearLimit}>
                  {locationCount}/{limits.locationsPerSnapshot} spaces
                  {" · "}
                  {itemCount}/{limits.itemsPerSnapshot} items
                  {" · "}
                  {planCount}/{limits.plansPerSnapshot} plans
                  {" · "}
                  {planStepCount}/{limits.planStepsPerSnapshot} plan steps
                </small>
                <small data-near-limit={historyNearLimit}>
                  {activityCount}/{limits.activitiesPerSnapshot} activities
                  {" · "}
                  {activityPatchCount}/{limits.activityPatchesPerSnapshot} patches
                  {" · "}
                  {auditEventCount}/{limits.auditEventsPerSnapshot} audit events
                  {" · "}
                  {commandReceiptCount}/{limits.commandReceiptsPerSnapshot} compact receipts
                  {" · "}
                  updated {formatDate(workspace.updated_at)}
                </small>
              </span>
              {numberValue(workspace.viewer_is_member) > 0
                ? <Link href={workspacePath({
                  view: "settings",
                  workspaceId,
                  workspaceLabel: workspaceName,
                })}>
                  Open settings
                </Link>
                : <small className="admin-access-note">Not a member</small>}
            </div>;
          })}
          {!workspaces.length && <p className="admin-empty">No matching workspaces</p>}
        </div>
      </section>
      <section>
        <h2>
          Users <small>{resultCount(
            data.users,
            data.listInfo?.users,
          )}</small>
        </h2>
        {resultNote(data.listInfo?.users) && <p className="admin-list-note">
          {resultNote(data.listInfo?.users)}
        </p>}
        <div className="admin-table">
          {data.users.map(user => {
            const email = stringValue(user.email);
            const userId = stringValue(user.user_id);
            const role = stringValue(user.global_role);
            const status = stringValue(user.status);
            return <div key={userId}>
              <span>
                <strong>{stringValue(user.display_name)}</strong>
                <small>{email}</small>
                <small>
                  {numberValue(user.owned_workspace_count)}/{limits.ownedWorkspacesPerUser} owned workspaces
                </small>
              </span>
              <select
                aria-label={`Role for ${email}`}
                disabled={Boolean(pendingAction)}
                onChange={event =>
                  void mutate("user.role", userId, event.target.value)}
                value={role}
              >
                <option>user</option>
                <option>admin</option>
              </select>
              <button
                disabled={Boolean(pendingAction)}
                onClick={() => void mutate(
                  "user.status",
                  userId,
                  status === "active" ? "disabled" : "active",
                )}
              >
                {status === "active" ? "Disable" : "Enable"}
              </button>
            </div>;
          })}
          {!data.users.length && <p className="admin-empty">No matching users</p>}
        </div>
      </section>
      <section>
        <h2>
          Linked identities <small>{resultCount(
            data.identities,
            data.listInfo?.identities,
          )}</small>
        </h2>
        {resultNote(data.listInfo?.identities) && <p className="admin-list-note">
          {resultNote(data.listInfo?.identities)}
        </p>}
        <div className="admin-table">
          {data.identities.map(identity => {
            const identityId = stringValue(identity.identity_id);
            const identityEmail = stringValue(identity.email);
            const provider = stringValue(identity.provider);
            return <div key={identityId}>
              <span>
                <strong>{provider} · {identityEmail}</strong>
                <small>User {stringValue(identity.user_email)} · last used {formatDate(identity.last_used_at)}</small>
              </span>
              <button
                className="danger"
                disabled={Boolean(pendingAction)}
                onClick={() => {
                  if (
                    confirm(
                      `Unlink ${provider} identity ${identityEmail}?`,
                    )
                  ) {
                    void mutate("identity.unlink", identityId);
                  }
                }}
              >
                Unlink
              </button>
            </div>;
          })}
          {!data.identities.length && <p className="admin-empty">No matching identities</p>}
        </div>
      </section>
      <section>
        <h2>
          Workspace access <small>{resultCount(
            data.memberships,
            data.listInfo?.memberships,
          )}</small>
        </h2>
        {resultNote(data.listInfo?.memberships) && <p className="admin-list-note">
          {resultNote(data.listInfo?.memberships)}
        </p>}
        <div className="admin-table">
          {data.memberships.map(membership => {
            const workspaceId = stringValue(membership.workspace_id);
            const workspaceName =
              stringValue(membership.workspace_name) || workspaceId;
            const userId = stringValue(membership.user_id);
            const email = stringValue(membership.email);
            const target = `${workspaceId}::${userId}`;
            return <div key={target}>
              <span>
                <strong>{workspaceName}</strong>
                <small>{email}</small>
              </span>
              <select
                aria-label={`Workspace role for ${email} in ${workspaceName}`}
                disabled={Boolean(pendingAction)}
                onChange={event =>
                  void mutate("member.role", target, event.target.value)}
                value={stringValue(membership.role)}
              >
                <option>viewer</option>
                <option>editor</option>
                <option>owner</option>
              </select>
              <button
                className="danger"
                disabled={Boolean(pendingAction)}
                onClick={() => {
                  if (
                    confirm(
                      `Remove ${email} from ${workspaceName}?`,
                    )
                  ) {
                    void mutate("member.remove", target);
                  }
                }}
              >
                Remove
              </button>
            </div>;
          })}
          {!data.memberships.length && <p className="admin-empty">No matching memberships</p>}
        </div>
      </section>
      <section>
        <h2>
          Sessions <small>{resultCount(
            data.sessions,
            data.listInfo?.sessions,
          )}</small>
        </h2>
        {resultNote(data.listInfo?.sessions) && <p className="admin-list-note">
          {resultNote(data.listInfo?.sessions)}
        </p>}
        <div className="admin-table">
          {data.sessions.map(session => {
            const sessionId = stringValue(session.session_id);
            const status = sessionStatus(session);
            return <div key={sessionId}>
              <span>
                <strong>{stringValue(session.email)}</strong>
                <small>Last seen {formatDate(session.last_seen_at)} · expires {formatDate(session.expires_at)}</small>
              </span>
              <b data-status={status}>{status}</b>
              <button
                disabled={Boolean(pendingAction) || status !== "active"}
                onClick={() =>
                  void mutate("session.revoke", sessionId)}
              >
                Revoke
              </button>
            </div>;
          })}
          {!data.sessions.length && <p className="admin-empty">No matching sessions</p>}
        </div>
      </section>
      <section>
        <h2>
          Single-use enrollment links <small>{resultCount(
            data.guestLinks,
            data.listInfo?.guestLinks,
          )}</small>
        </h2>
        {resultNote(data.listInfo?.guestLinks) && <p className="admin-list-note">
          {resultNote(data.listInfo?.guestLinks)}
        </p>}
        <div className="admin-table">
          {data.guestLinks.map(link => {
            const guestLinkId = stringValue(link.guest_link_id);
            const status = guestLinkStatus(link);
            const workspaceName =
              stringValue(link.workspace_name) ||
              stringValue(link.workspace_id);
            return <div key={guestLinkId}>
              <span>
                <strong>{stringValue(link.role)} · {workspaceName}</strong>
                <small>Expires {formatDate(link.expires_at)}</small>
              </span>
              <b data-status={status}>{status}</b>
              <button
                disabled={Boolean(pendingAction) || status !== "available"}
                onClick={() => void mutate("guest.revoke", guestLinkId)}
              >
                Revoke
              </button>
            </div>;
          })}
          {!data.guestLinks.length && <p className="admin-empty">No matching enrollment links</p>}
        </div>
      </section>
      <section>
        <h2>
          Auth audit <small>{resultCount(
            data.audit,
            data.listInfo?.audit,
          )}</small>
        </h2>
        {resultNote(data.listInfo?.audit) && <p className="admin-list-note">
          {resultNote(data.listInfo?.audit)}
        </p>}
        <div className="admin-table admin-audit">
          {data.audit.map(event => {
            const eventId = stringValue(event.event_id);
            const detail = prettyDetail(event.detail_json);
            return <div key={eventId}>
              <span>
                <strong>{stringValue(event.action)}</strong>
                <small>{formatDate(event.created_at)} · {stringValue(event.actor_email) || "system"} · {stringValue(event.target_type)} · {stringValue(event.target_id)}</small>
              </span>
              {detail && <details>
                <summary>Details</summary>
                <pre>{detail}</pre>
              </details>}
            </div>;
          })}
          {!data.audit.length && <p className="admin-empty">No matching audit events</p>}
        </div>
      </section>
    </>}
  </main>;
}
