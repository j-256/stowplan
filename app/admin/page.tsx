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
import { ModalDialog } from "../../src/client/modal-dialog";
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
import {
  SESSION_REVOCATION_SCOPE,
} from "../../src/shared/authentication";
import {
  CIRCUIT_BREAKER_PAUSE_KIND,
  CIRCUIT_BREAKER_STATE,
  MAXIMUM_GOVERNANCE_LIMIT,
  type CircuitBreaker,
  type GovernanceLimit,
} from "../../src/shared/governance-policy";

type Row = Record<string, unknown>;

interface ListInfo {
  hasMore: boolean;
  limit: number;
  nextOffset?: number | null;
  offset?: number;
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

interface AdminMutationPreconditions {
  expectedAccountRevision?: number;
  expectedAccessRevision?: number;
  expectedMembershipRevision?: number;
}

interface AdminMutationFields {
  pauseKind?: string;
  reason?: string;
}

interface Overview {
  audit: Row[];
  circuitBreakers?: CircuitBreaker[];
  databaseInventory?: {
    entries: InventoryEntry[];
    generatedAt: string;
  };
  deletions?: Row[];
  guestLinks: Row[];
  governanceLimits?: GovernanceLimit[];
  identities: Row[];
  limits?: Record<ApiQuotaName, number>;
  listInfo?: Partial<Record<
    | "audit"
    | "deletions"
    | "guestLinks"
    | "identities"
    | "memberships"
    | "migrations"
    | "oauthStates"
    | "sessions"
    | "users"
    | "workspaces",
    ListInfo
  >>;
  memberships: Row[];
  migrations?: Row[];
  oauthStates?: Row[];
  query?: string;
  sessions: Row[];
  users: Row[];
  workspaces?: Row[];
}

type AdminResource =
  | "audit"
  | "deletions"
  | "guestLinks"
  | "identities"
  | "memberships"
  | "migrations"
  | "oauthStates"
  | "sessions"
  | "users"
  | "workspaces";

type OverviewListField = Exclude<
  keyof Overview,
  "databaseInventory" | "limits" | "listInfo" | "query"
>;

const OVERVIEW_FIELD_BY_RESOURCE = Object.freeze({
  audit: "audit",
  deletions: "deletions",
  guestLinks: "guestLinks",
  identities: "identities",
  memberships: "memberships",
  migrations: "migrations",
  oauthStates: "oauthStates",
  sessions: "sessions",
  users: "users",
  workspaces: "workspaces",
} satisfies Record<AdminResource, OverviewListField>);

const INVENTORY_SECTION_BY_KEY = Object.freeze({
  "account-deletion-receipts": "admin-deletions",
  "auth-audit-events": "admin-audit",
  "circuit-breakers": "admin-circuits",
  "creation-ledger": "admin-users",
  "guest-links": "admin-guest-links",
  "governance-limits": "admin-governance-limits",
  identities: "admin-identities",
  "identity-ban-digests": "admin-users",
  "migration-stream": "admin-migrations",
  "oauth-states": "admin-oauth-states",
  sessions: "admin-sessions",
  users: "admin-users",
  "workspace-custody": "admin-workspaces",
  "workspace-deletions": "admin-deletions",
  "workspace-members": "admin-memberships",
  "workspace-snapshots": "admin-workspaces",
});

function inventorySection(entry: InventoryEntry): string {
  if (entry.key.startsWith("migration-ledger:")) {
    return "admin-migrations";
  }
  return INVENTORY_SECTION_BY_KEY[
    entry.key as keyof typeof INVENTORY_SECTION_BY_KEY
  ] ?? "database-inventory-heading";
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
    ? "More matching records are available. Load the next bounded page or search to narrow the list."
    : null;
}

function guestLinkStatus(row: Row): "active" | "expired" | "revoked" | "used" {
  if (row.revoked_at) return "revoked";
  if (row.consumed_at) return "used";
  return new Date(stringValue(row.expires_at)).getTime() <= Date.now()
    ? "expired"
    : "active";
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

function focusAdminFragment(): boolean {
  const fragment = window.location.hash.slice(1);
  if (!fragment) return false;
  let id: string;
  try {
    id = decodeURIComponent(fragment);
  } catch {
    return false;
  }
  const destination = document.getElementById(id);
  if (!(destination instanceof HTMLElement)) return false;
  destination.focus();
  return true;
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
  const [pendingPage, setPendingPage] = useState<AdminResource | null>(
    null,
  );
  const [pendingGuestDeletion, setPendingGuestDeletion] =
    useState<Row | null>(null);
  const accountId = useRef<string | null>(null);
  const initialFragmentHandled = useRef(false);
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
  useEffect(() => {
    const focusDestination = () => {
      window.requestAnimationFrame(() => focusAdminFragment());
    };
    window.addEventListener("hashchange", focusDestination);
    return () => window.removeEventListener("hashchange", focusDestination);
  }, []);
  useEffect(() => {
    if (!data || initialFragmentHandled.current) return;
    initialFragmentHandled.current = true;
    const frame = window.requestAnimationFrame(() => focusAdminFragment());
    return () => window.cancelAnimationFrame(frame);
  }, [data]);
  const mutate = async (
    action: string,
    targetId: string,
    value?: string,
    preconditions: AdminMutationPreconditions = {},
    fields: AdminMutationFields = {},
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
        body: JSON.stringify({
          action,
          targetId,
          value,
          ...preconditions,
          ...fields,
        }),
        headers: accountContextHeaders(expectedAccountId, {
          "content-type": "application/json",
        }),
        method: "POST",
      });
      const body = await response.json().catch(() => null) as {
        currentSessionRevoked?: boolean;
        error?: string;
        message?: string;
        revokedSessions?: number;
        unusedGuestLinksRevoked?: number;
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
      if (body?.currentSessionRevoked) {
        window.location.assign("/account?returnTo=/admin");
        return true;
      }
      const refreshed = await load(query);
      const sessionMessage = body?.revokedSessions === undefined
        ? body?.message ?? "Administrative change saved"
        : `${body.message ?? "User disabled"}; revoked ${body.revokedSessions.toLocaleString()} active sessions`;
      const resultMessage =
        body?.unusedGuestLinksRevoked === undefined
          ? sessionMessage
          : `${sessionMessage}; revoked ${body.unusedGuestLinksRevoked.toLocaleString()} unused invite links`;
      setNotice(
        refreshed
          ? resultMessage
          : `${resultMessage}, but the records could not be refreshed`,
      );
      return true;
    } catch (reason) {
      setActionError(
        reason instanceof Error && reason.message
          ? reason.message
          : "Admin mutation failed",
      );
      return false;
    } finally {
      setPendingAction("");
    }
  };
  const loadMore = async (resource: AdminResource) => {
    const info = data?.listInfo?.[resource];
    if (
      pendingPage ||
      !info?.hasMore ||
      typeof info.nextOffset !== "number"
    ) {
      return;
    }
    const requestId = loadRequest.current;
    setActionError("");
    setPendingPage(resource);
    try {
      const expectedAccountId = accountId.current;
      if (!expectedAccountId) {
        throw new Error(
          "Administrative account context is not ready; reload the page",
        );
      }
      const params = new URLSearchParams({
        offset: String(info.nextOffset),
        resource,
      });
      if (query) params.set("q", query);
      const response = await fetch(
        `/api/admin/overview?${params.toString()}`,
        {
          cache: "no-store",
          headers: accountContextHeaders(expectedAccountId),
        },
      );
      const body = await response.json().catch(() => null) as
        | (Overview & { error?: string })
        | null;
      if (!response.ok) {
        throw new Error(
          body?.error ?? `Could not load more records (${response.status})`,
        );
      }
      if (!responseMatchesAccount(response, expectedAccountId)) {
        throw new Error(
          "The signed-in account changed; reload the admin page",
        );
      }
      if (!body || requestId !== loadRequest.current) return;
      const field = OVERVIEW_FIELD_BY_RESOURCE[resource];
      const incoming = body[field] as Row[] | undefined;
      setData(current => {
        if (!current) return current;
        const next = { ...current } as Overview &
          Partial<Record<OverviewListField, Row[]>>;
        const existing = next[field] ?? [];
        next[field] = [...existing, ...(incoming ?? [])];
        next.listInfo = {
          ...current.listInfo,
          [resource]: body.listInfo?.[resource],
        };
        return next;
      });
    } catch (reason) {
      setActionError(
        reason instanceof Error && reason.message
          ? reason.message
          : "Could not load more administrative records",
      );
    } finally {
      setPendingPage(null);
    }
  };
  const applySearch = (value: string) => {
    const next = value.trim();
    setDraftQuery(next);
    setActionError("");
    setNotice("");
    if (next === query) {
      void load(next);
    } else {
      setQuery(next);
    }
  };
  const submitSearch = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    applySearch(draftQuery);
  };
  const limits = data?.limits ?? API_QUOTAS;
  const circuitBreakers = data?.circuitBreakers ?? [];
  const governanceLimits = data?.governanceLimits ?? [];
  const inventoryEntries = data?.databaseInventory?.entries ?? [];
  const workspaces = data?.workspaces ?? [];
  const deletions = data?.deletions ?? [];
  const oauthStates = data?.oauthStates ?? [];
  const migrations = data?.migrations ?? [];
  const pendingGuestStatus = pendingGuestDeletion
    ? guestLinkStatus(pendingGuestDeletion)
    : null;
  const moreButton = (
    resource: AdminResource,
    label: string,
  ) => {
    const info = data?.listInfo?.[resource];
    if (!info?.hasMore || typeof info.nextOffset !== "number") {
      return null;
    }
    return <button
      className="admin-load-more"
      disabled={Boolean(pendingPage)}
      onClick={() => void loadMore(resource)}
      type="button"
    >
      {pendingPage === resource ? "Loading..." : `Load more ${label}`}
    </button>;
  };

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
      <section
        aria-labelledby="admin-governance-limits-heading"
        id="admin-governance-limits"
        tabIndex={-1}
      >
        <h2 id="admin-governance-limits-heading">
          Adjustable public limits <small>{governanceLimits.length}</small>
        </h2>
        <p className="admin-list-note">
          The new-account daily fuse can be tuned without a deployment. Every change requires an operational reason and is audited. Never put a credential or other secret in the reason.
        </p>
        <div
          aria-label="Adjustable public governance limits"
          className="admin-table"
          role="list"
        >
          {governanceLimits.map(limit => <div
            aria-label={`Governance limit ${limit.key}`}
            key={limit.key}
            role="listitem"
          >
            <span>
              <strong>{limit.key.replaceAll("_", " ")}</strong>
              <small>
                {limit.value.toLocaleString()} per day
                {" · "}
                hard maximum {MAXIMUM_GOVERNANCE_LIMIT[
                  limit.key
                ].toLocaleString()}
              </small>
              <small>
                Updated {formatDate(limit.updatedAt)}
                {" · "}
                by {limit.updatedByUserId || "system"}
              </small>
            </span>
            <button
              disabled={Boolean(pendingAction)}
              onClick={() => {
                const proposed = window.prompt(
                  `Set ${limit.key} to a non-negative daily count`,
                  String(limit.value),
                )?.trim();
                if (proposed === undefined) return;
                if (!/^(0|[1-9]\d*)$/u.test(proposed)) {
                  setActionError(
                    "The daily account limit must be a non-negative integer",
                  );
                  return;
                }
                const reason = window.prompt(
                  "Why is this launch limit changing? Do not include secrets.",
                )?.trim();
                if (!reason) return;
                void mutate(
                  "governance.limit.set",
                  limit.key,
                  proposed,
                  {},
                  { reason },
                );
              }}
              type="button"
            >
              Change daily fuse
            </button>
          </div>)}
          {!governanceLimits.length && <p
            className="admin-empty"
            role="listitem"
          >
            Adjustable governance limits are unavailable
          </p>}
        </div>
      </section>
      <section
        aria-labelledby="admin-circuits-heading"
        id="admin-circuits"
        tabIndex={-1}
      >
        <h2 id="admin-circuits-heading">
          Public abuse circuit breakers <small>{circuitBreakers.length}</small>
        </h2>
        <p className="admin-list-note">
          Security pauses reopen automatically after 30 minutes, or two hours after a retrigger. Capacity pauses stay latched until an administrator opens them.
        </p>
        <div
          aria-label="Public abuse circuit breakers"
          className="admin-table"
          role="list"
        >
          {circuitBreakers.map(circuit => {
            const paused =
              circuit.effectiveState ===
                CIRCUIT_BREAKER_STATE.PAUSED;
            return <div
              aria-label={`Circuit breaker ${circuit.scope}`}
              key={circuit.scope}
              role="listitem"
            >
              <span>
                <strong>{circuit.scope.replaceAll("_", " ")}</strong>
                <small>
                  Stored state {circuit.state}
                  {" · "}
                  effective state {circuit.effectiveState}
                  {" · "}
                  {circuit.pauseKind}
                </small>
                {circuit.reason && <small>
                  Reason: {circuit.reason}
                </small>}
                <small>
                  Updated {formatDate(circuit.updatedAt)}
                  {" · "}
                  by {circuit.updatedByUserId || "system"}
                  {" · "}
                  trigger count {circuit.triggerCount}
                  {circuit.resumeAt
                    ? ` · scheduled reopen ${formatDate(circuit.resumeAt)}`
                    : ""}
                </small>
              </span>
              <b data-status={circuit.effectiveState}>
                {circuit.effectiveState}
              </b>
              <span
                aria-label={`Actions for ${circuit.scope}`}
                className="admin-row-actions"
                role="group"
              >
                {!paused
                  ? <>
                      <button
                        className="danger"
                        disabled={Boolean(pendingAction)}
                        onClick={() => {
                          const reason = window.prompt(
                            `Why should ${circuit.scope} pause for a security response?`,
                          )?.trim();
                          if (!reason) return;
                          void mutate(
                            "circuit.set",
                            circuit.scope,
                            CIRCUIT_BREAKER_STATE.PAUSED,
                            {},
                            {
                              pauseKind:
                                CIRCUIT_BREAKER_PAUSE_KIND.SECURITY,
                              reason,
                            },
                          );
                        }}
                        type="button"
                      >
                        Security pause
                      </button>
                      <button
                        className="danger"
                        disabled={Boolean(pendingAction)}
                        onClick={() => {
                          const reason = window.prompt(
                            `Why should ${circuit.scope} pause for capacity protection?`,
                          )?.trim();
                          if (!reason) return;
                          void mutate(
                            "circuit.set",
                            circuit.scope,
                            CIRCUIT_BREAKER_STATE.PAUSED,
                            {},
                            {
                              pauseKind:
                                CIRCUIT_BREAKER_PAUSE_KIND.CAPACITY,
                              reason,
                            },
                          );
                        }}
                        type="button"
                      >
                        Capacity pause
                      </button>
                    </>
                  : <button
                      disabled={Boolean(pendingAction)}
                      onClick={() => {
                        if (
                          confirm(
                            `Open ${circuit.scope} and allow this public operation again?`,
                          )
                        ) {
                          void mutate(
                            "circuit.set",
                            circuit.scope,
                            CIRCUIT_BREAKER_STATE.OPEN,
                            {},
                            { pauseKind: circuit.pauseKind },
                          );
                        }
                      }}
                      type="button"
                    >
                      Open circuit
                    </button>}
              </span>
            </div>;
          })}
          {!circuitBreakers.length && <p
            className="admin-empty"
            role="listitem"
          >
            Circuit breaker state is unavailable
          </p>}
        </div>
      </section>
      <section aria-labelledby="database-inventory-heading">
        <h2 id="database-inventory-heading">
          Database inventory <small>{inventoryEntries.length}</small>
        </h2>
        <p className="admin-list-note">
          Every durable application table is indexed here. Open a row for bounded records, lifecycle state, and safe operational details. Credential values, hashes, OAuth verifier material, and provider assertions stay obscured.
        </p>
        {query && <p className="admin-list-note">
          Inventory row counts describe the full database. The search filter applies to the record lists below.
        </p>}
        <nav
          aria-label="Database inventory drill-down"
          className="admin-table admin-inventory"
        >
          {inventoryEntries.map(entry => <a
            href={`#${inventorySection(entry)}`}
            key={entry.key}
          >
            <span>
              <strong>{entry.label}</strong>
              <small>{entry.table}</small>
              {entry.metrics.length > 0 && <small>
                {entry.metrics.map(formatInventoryMetric).join(" · ")}
              </small>}
            </span>
            <span className="admin-inventory-count">
              <b>{entry.rowCount.toLocaleString()} rows</b>
              <small>View records</small>
            </span>
          </a>)}
          {!inventoryEntries.length && <p className="admin-empty">
            Database inventory is unavailable
          </p>}
        </nav>
        {data.databaseInventory?.generatedAt && <small>
          Generated {formatDate(data.databaseInventory.generatedAt)}
        </small>}
      </section>
      <section
        aria-labelledby="admin-workspaces-heading"
        id="admin-workspaces"
        tabIndex={-1}
      >
        <h2 id="admin-workspaces-heading">
          Workspaces <small>{resultCount(
            workspaces,
            data.listInfo?.workspaces,
          )}</small>
        </h2>
        {resultNote(data.listInfo?.workspaces) && <p className="admin-list-note">
          {resultNote(data.listInfo?.workspaces)}
        </p>}
        <div
          aria-label="Workspace records"
          className="admin-table admin-workspaces"
          role="list"
        >
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
            return <div
              aria-label={`Workspace ${workspaceName}`}
              key={workspaceId}
              role="listitem"
            >
              <span>
                <strong>{workspaceName}</strong>
                <small>{workspaceId}</small>
                <small>
                  Snapshot revision {numberValue(workspace.revision)}
                  {" · "}
                  access revision {numberValue(workspace.access_revision)}
                  {" · "}
                  created {formatDate(workspace.created_at)}
                </small>
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
              <span
                aria-label={`Actions for workspace ${workspaceName}`}
                className="admin-row-actions"
                role="group"
              >
                <Link
                  aria-label={`Inspect content (audited) for ${workspaceName}`}
                  href={`/admin/workspaces/${encodeURIComponent(workspaceId)}`}
                >
                  Inspect content (audited)
                </Link>
                {numberValue(workspace.viewer_is_member) > 0
                  ? <Link
                      aria-label={`Open member settings for ${workspaceName}`}
                      href={workspacePath({
                        view: "settings",
                        workspaceId,
                        workspaceLabel: workspaceName,
                      })}
                    >
                      Open member settings
                    </Link>
                  : <small className="admin-access-note">
                      No ordinary membership
                    </small>}
              </span>
            </div>;
          })}
          {!workspaces.length && <p
            className="admin-empty"
            role="listitem"
          >
            No matching workspaces
          </p>}
        </div>
        {moreButton("workspaces", "workspaces")}
      </section>
      <section
        aria-labelledby="admin-users-heading"
        id="admin-users"
        tabIndex={-1}
      >
        <h2 id="admin-users-heading">
          Users <small>{resultCount(
            data.users,
            data.listInfo?.users,
          )}</small>
        </h2>
        {resultNote(data.listInfo?.users) && <p className="admin-list-note">
          {resultNote(data.listInfo?.users)}
        </p>}
        <div
          aria-label="User records"
          className="admin-table"
          role="list"
        >
          {data.users.map(user => {
            const email = stringValue(user.email);
            const userId = stringValue(user.user_id);
            const role = stringValue(user.global_role);
            const status = stringValue(user.status);
            const accountRevision =
              numberValue(user.account_revision);
            const deletedAt = stringValue(user.deleted_at);
            const redactedAfterBan =
              status === "disabled" &&
              numberValue(user.retained_identity_ban_count) > 0;
            const userLabel = email || userId;
            return <div
              aria-label={`User ${userLabel}`}
              key={userId}
              role="listitem"
            >
              <span>
                <strong>{stringValue(user.display_name)}</strong>
                <small>{email}</small>
                <small>
                  {userId}
                  {" · "}
                  {role}
                  {" · "}
                  {status}
                  {" · "}
                  account revision {accountRevision}
                  {" · "}
                  membership revision {numberValue(user.membership_revision)}
                </small>
                {stringValue(user.ban_reason) && <small>
                  Enforcement reason: {stringValue(user.ban_reason)}
                </small>}
                {redactedAfterBan && <small>
                  Identity redaction is permanent. This retained account
                  cannot be enabled.
                </small>}
                <small>
                  {numberValue(user.owned_workspace_count)}/{limits.ownedWorkspacesPerUser} owned workspaces
                </small>
                <small>
                  Created {formatDate(user.created_at)}
                  {" · "}
                  updated {formatDate(user.updated_at)}
                  {" · "}
                  last server activity {formatDate(user.last_seen_at)}
                  {deletedAt
                    ? ` · deleted ${formatDate(deletedAt)}`
                    : ""}
                </small>
              </span>
              <span
                aria-label={`Account actions for ${userLabel}`}
                className="admin-row-actions"
                role="group"
              >
                <select
                  aria-label={`Role for ${userLabel}`}
                  disabled={
                    Boolean(pendingAction) ||
                    Boolean(deletedAt) ||
                    (role === "user" && status !== "active")
                  }
                  onChange={event => {
                    const nextRole = event.target.value;
                    const message = nextRole === "admin"
                      ? `Promote ${userLabel} to global administrator? This grants installation-wide administration only after the account also passes Cloudflare Access.`
                      : `Demote ${userLabel} from global administrator and revoke all of their active sessions? Workspace memberships are unchanged.`;
                    if (!confirm(message)) {
                      event.target.value = role;
                      return;
                    }
                    void mutate(
                      "user.role",
                      userId,
                      nextRole,
                      { expectedAccountRevision: accountRevision },
                    );
                  }}
                  value={role}
                >
                  <option value="user">user</option>
                  <option value="admin">admin</option>
                </select>
                {!deletedAt && <button
                  aria-label={status === "active"
                    ? `Disable and sign out ${userLabel}`
                    : status === "banned"
                      ? `Lift enforcement ban for ${userLabel}`
                      : redactedAfterBan
                        ? `Redacted account ${userLabel} cannot be enabled`
                        : `Enable ${userLabel}`}
                  className={status === "active" ? "danger" : undefined}
                  disabled={
                    Boolean(pendingAction) || redactedAfterBan
                  }
                  onClick={() => {
                    if (status === "banned") {
                      if (
                        confirm(
                          `Lift the identity enforcement ban for ${userLabel}? The redacted account stays disabled, and prior sessions or identities are not restored.`,
                        )
                      ) {
                        void mutate(
                          "user.ban.lift",
                          userId,
                          undefined,
                          {
                            expectedAccountRevision:
                              accountRevision,
                          },
                        );
                      }
                      return;
                    }
                    const nextStatus =
                      status === "active" ? "disabled" : "active";
                    if (
                      nextStatus === "active" ||
                      confirm(
                        `Disable ${userLabel} and revoke all of their active sessions and unused invite links? Re-enabling the account will not restore either.`,
                      )
                    ) {
                      void mutate(
                        "user.status",
                        userId,
                        nextStatus,
                        {
                          expectedAccountRevision:
                            accountRevision,
                        },
                      );
                    }
                  }}
                  type="button"
                >
                  {status === "active"
                    ? "Disable and sign out"
                    : status === "banned"
                      ? "Lift enforcement ban"
                      : redactedAfterBan
                        ? "Redacted account cannot be enabled"
                        : "Enable"}
                </button>}
                {!deletedAt && status !== "banned" && <button
                  aria-label={`Ban ${userLabel}`}
                  className="danger"
                  disabled={Boolean(pendingAction)}
                  onClick={() => {
                    const reason = window.prompt(
                      `Why should ${userLabel} be banned? This permanently redacts their sign-in identities and profile.`,
                    )?.trim();
                    if (!reason) return;
                    if (
                      !confirm(
                        `Ban ${userLabel}, revoke their sessions and unused guest links, and retain only enforcement digests for their identities? This redaction cannot be reversed.`,
                      )
                    ) {
                      return;
                    }
                    void mutate(
                      "user.ban",
                      userId,
                      undefined,
                      {
                        expectedAccountRevision:
                          accountRevision,
                      },
                      { reason },
                    );
                  }}
                  type="button"
                >
                  Ban account
                </button>}
              </span>
            </div>;
          })}
          {!data.users.length && <p
            className="admin-empty"
            role="listitem"
          >
            No matching users
          </p>}
        </div>
        {moreButton("users", "users")}
      </section>
      <section
        aria-labelledby="admin-identities-heading"
        id="admin-identities"
        tabIndex={-1}
      >
        <h2 id="admin-identities-heading">
          Linked identities <small>{resultCount(
            data.identities,
            data.listInfo?.identities,
          )}</small>
        </h2>
        {resultNote(data.listInfo?.identities) && <p className="admin-list-note">
          {resultNote(data.listInfo?.identities)}
        </p>}
        <div
          aria-label="Linked identity records"
          className="admin-table"
          role="list"
        >
          {data.identities.map(identity => {
            const identityId = stringValue(identity.identity_id);
            const identityEmail = stringValue(identity.email);
            const provider = stringValue(identity.provider);
            const identityLabel =
              `${provider} ${identityEmail || identityId}`.trim();
            return <div
              aria-label={`Linked identity ${identityLabel}`}
              key={identityId}
              role="listitem"
            >
              <span>
                <strong>{provider} · {identityEmail}</strong>
                <small>
                  User {stringValue(identity.user_display_name)}
                  {" · "}
                  {stringValue(identity.user_email)}
                  {" · "}
                  {stringValue(identity.user_status)}
                </small>
                <small>
                  Identity {identityId}
                  {" · "}
                  provider subject {stringValue(identity.provider_subject)}
                </small>
                <small>
                  Created {formatDate(identity.created_at)}
                  {" · "}
                  last used {formatDate(identity.last_used_at)}
                </small>
              </span>
              <button
                aria-label={`Unlink ${identityLabel}`}
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
          {!data.identities.length && <p
            className="admin-empty"
            role="listitem"
          >
            No matching identities
          </p>}
        </div>
        {moreButton("identities", "identities")}
      </section>
      <section
        aria-labelledby="admin-memberships-heading"
        id="admin-memberships"
        tabIndex={-1}
      >
        <h2 id="admin-memberships-heading">
          Workspace access <small>{resultCount(
            data.memberships,
            data.listInfo?.memberships,
          )}</small>
        </h2>
        {resultNote(data.listInfo?.memberships) && <p className="admin-list-note">
          {resultNote(data.listInfo?.memberships)}
        </p>}
        <div
          aria-label="Workspace membership records"
          className="admin-table"
          role="list"
        >
          {data.memberships.map(membership => {
            const workspaceId = stringValue(membership.workspace_id);
            const workspaceName =
              stringValue(membership.workspace_name) || workspaceId;
            const userId = stringValue(membership.user_id);
            const email = stringValue(membership.email);
            const target = `${workspaceId}::${userId}`;
            const memberLabel = email || userId;
            return <div
              aria-label={`Workspace membership for ${memberLabel} in ${workspaceName}`}
              key={target}
              role="listitem"
            >
              <span>
                <strong>{workspaceName}</strong>
                <small>
                  {stringValue(membership.display_name)}
                  {" · "}
                  {email}
                  {" · "}
                  {stringValue(membership.user_status)}
                </small>
                <small>
                  Workspace {workspaceId}
                  {" · "}
                  user {userId}
                  {" · "}
                  created {formatDate(membership.created_at)}
                </small>
                <small>
                  Workspace revision {numberValue(membership.workspace_revision)}
                  {" · "}
                  access revision {numberValue(membership.workspace_access_revision)}
                  {" · "}
                  user membership revision {numberValue(membership.membership_revision)}
                </small>
              </span>
              <select
                aria-label={`Workspace role for ${memberLabel} in ${workspaceName}`}
                disabled={Boolean(pendingAction)}
                onChange={event =>
                  void mutate(
                    "member.role",
                    target,
                    event.target.value,
                    {
                      expectedAccessRevision: numberValue(
                        membership.workspace_access_revision,
                      ),
                      expectedMembershipRevision: numberValue(
                        membership.membership_revision,
                      ),
                    },
                  )}
                value={stringValue(membership.role)}
              >
                <option>viewer</option>
                <option>editor</option>
                <option>owner</option>
              </select>
              <button
                aria-label={`Remove ${memberLabel} from ${workspaceName}`}
                className="danger"
                disabled={Boolean(pendingAction)}
                onClick={() => {
                  if (
                    confirm(
                      `Remove ${memberLabel} from ${workspaceName}?`,
                    )
                  ) {
                    void mutate(
                      "member.remove",
                      target,
                      undefined,
                      {
                        expectedAccessRevision: numberValue(
                          membership.workspace_access_revision,
                        ),
                        expectedMembershipRevision: numberValue(
                          membership.membership_revision,
                        ),
                      },
                    );
                  }
                }}
              >
                Remove
              </button>
            </div>;
          })}
          {!data.memberships.length && <p
            className="admin-empty"
            role="listitem"
          >
            No matching memberships
          </p>}
        </div>
        {moreButton("memberships", "memberships")}
      </section>
      <section
        aria-labelledby="admin-sessions-heading"
        id="admin-sessions"
        tabIndex={-1}
      >
        <h2 id="admin-sessions-heading">
          Sessions <small>{resultCount(
            data.sessions,
            data.listInfo?.sessions,
          )}</small>
        </h2>
        {resultNote(data.listInfo?.sessions) && <p className="admin-list-note">
          {resultNote(data.listInfo?.sessions)}
        </p>}
        <p className="admin-list-note">
          The session used to load this page is identified as the current browser session. Revoking it signs this browser out immediately.
        </p>
        <button
          className="danger"
          disabled={Boolean(pendingAction)}
          onClick={() => {
            if (
              !confirm(
                "Revoke every active pre-Google session, including legacy unrecorded and temporary Cloudflare Access migration sessions? Do this after disabling the exchange and before making Account public. Any affected browser must sign in with Google.",
              )
            ) {
              return;
            }
            void mutate(
              "session.revoke-pre-google",
              SESSION_REVOCATION_SCOPE.PRE_GOOGLE,
            );
          }}
          type="button"
        >
          Revoke pre-Google sessions
        </button>
        <div
          aria-label="Session records"
          className="admin-table"
          role="list"
        >
          {data.sessions.map(session => {
            const sessionId = stringValue(session.session_id);
            const status = sessionStatus(session);
            const email = stringValue(session.email);
            const displayName = stringValue(session.display_name);
            const sessionUser =
              email || displayName || stringValue(session.user_id);
            const isCurrent =
              numberValue(session.viewer_is_current) > 0;
            return <div
              aria-label={`Session ${sessionId} for ${sessionUser}`}
              key={sessionId}
              role="listitem"
            >
              <span>
                <strong>
                  {displayName}
                  {" · "}
                  {email}
                </strong>
                {isCurrent && <small className="admin-current-session">
                  Current browser session
                </small>}
                <small>
                  Session {sessionId}
                  {" · "}
                  user {stringValue(session.user_id)}
                  {" · "}
                  signed in via {stringValue(
                    session.authentication_provider,
                  ) || "legacy or unrecorded"}
                  {" · "}
                  {stringValue(session.global_role)}
                  {" · "}
                  account {stringValue(session.status)}
                </small>
                <small>
                  {stringValue(session.user_agent) || "Browser or device not recorded"}
                </small>
                <small>
                  Coarse network {stringValue(session.ip_prefix) || "not recorded"}
                </small>
                <small>
                  Created {formatDate(session.created_at)}
                  {" · "}
                  last server activity {formatDate(session.last_seen_at)}
                  {" · "}
                  expires {formatDate(session.expires_at)}
                  {session.revoked_at
                    ? ` · revoked ${formatDate(session.revoked_at)}`
                    : ""}
                </small>
              </span>
              <b data-status={status}>{status}</b>
              <button
                aria-label={isCurrent
                  ? `Revoke current session ${sessionId} for ${sessionUser} and sign out`
                  : `Revoke session ${sessionId} for ${sessionUser}`}
                className="danger"
                disabled={Boolean(pendingAction) || status !== "active"}
                onClick={() => {
                  const message = isCurrent
                    ? `Revoke your current browser session ${sessionId}? This signs you out immediately. Local workspace data stays on this device.`
                    : `Revoke session ${sessionId} for ${sessionUser}? That browser or device will be signed out and must sign in again.`;
                  if (!confirm(message)) return;
                  void mutate("session.revoke", sessionId);
                }}
                type="button"
              >
                {isCurrent ? "Revoke and sign out" : "Revoke"}
              </button>
            </div>;
          })}
          {!data.sessions.length && <p
            className="admin-empty"
            role="listitem"
          >
            No matching sessions
          </p>}
        </div>
        {moreButton("sessions", "sessions")}
      </section>
      <section
        aria-labelledby="admin-guest-links-heading"
        id="admin-guest-links"
        tabIndex={-1}
      >
        <h2 id="admin-guest-links-heading">
          Single-use enrollment links <small>{resultCount(
            data.guestLinks,
            data.listInfo?.guestLinks,
          )}</small>
        </h2>
        {resultNote(data.listInfo?.guestLinks) && <p className="admin-list-note">
          {resultNote(data.listInfo?.guestLinks)}
        </p>}
        <div
          aria-label="Enrollment link records"
          className="admin-table"
          role="list"
        >
          {data.guestLinks.map(link => {
            const guestLinkId = stringValue(link.guest_link_id);
            const status = guestLinkStatus(link);
            const workspaceName =
              stringValue(link.workspace_name) ||
              stringValue(link.workspace_id);
            const redeemedByUserId =
              stringValue(link.redeemed_by_user_id);
            const redeemedByDisplayName =
              stringValue(link.redeemed_by_display_name);
            const redeemedByEmail =
              stringValue(link.redeemed_by_email);
            const redeemedByLabel =
              redeemedByDisplayName || redeemedByEmail ||
              redeemedByUserId;
            const acceptedAt = stringValue(link.accepted_at);
            return <div
              aria-label={`Enrollment link ${guestLinkId} for ${workspaceName}`}
              key={guestLinkId}
              role="listitem"
            >
              <span>
                <strong>{stringValue(link.role)} · {workspaceName}</strong>
                <small>
                  Link {guestLinkId}
                  {" · "}
                  workspace {stringValue(link.workspace_id)}
                </small>
                <small>
                  Created by {stringValue(link.created_by_display_name)}
                  {" · "}
                  {stringValue(link.created_by_email)}
                  {" · "}
                  {stringValue(link.created_by_user_id)}
                </small>
                <small>
                  Creator {stringValue(link.created_by_global_role)}
                  {" · "}
                  account {stringValue(link.created_by_status)}
                  {" · "}
                  membership revision {numberValue(link.created_by_membership_revision)}
                </small>
                <small>
                  Workspace revision {numberValue(link.workspace_revision)}
                  {" · "}
                  access revision {numberValue(link.workspace_access_revision)}
                  {" · "}
                  updated {formatDate(link.workspace_updated_at)}
                </small>
                <small>
                  Created {formatDate(link.created_at)}
                  {" · "}
                  expires {formatDate(link.expires_at)}
                  {link.consumed_at
                    ? ` · used ${formatDate(link.consumed_at)}`
                    : ""}
                  {link.revoked_at
                    ? ` · revoked ${formatDate(link.revoked_at)}`
                    : ""}
                </small>
                {Boolean(link.redemption_id) && <small>
                  Redemption {stringValue(link.redemption_id)}
                </small>}
                {status === "used" && redeemedByUserId && <>
                  <small>
                    Accepted by {redeemedByDisplayName || "Unnamed user"}
                    {" · "}
                    {redeemedByEmail || "Email unavailable"}
                    {" · "}
                    user {redeemedByUserId}
                    {acceptedAt
                      ? ` · accepted ${formatDate(acceptedAt)}`
                      : ""}
                  </small>
                  <span
                    aria-label={`Find accepted member ${redeemedByLabel}`}
                    className="admin-row-actions"
                    role="group"
                  >
                    <a
                      aria-label={`Find user ${redeemedByLabel}`}
                      href="#admin-users"
                      onClick={() => applySearch(redeemedByUserId)}
                    >
                      Find user
                    </a>
                    <a
                      aria-label={`Find membership for ${redeemedByLabel}`}
                      href="#admin-memberships"
                      onClick={() => applySearch(redeemedByUserId)}
                    >
                      Find membership
                    </a>
                  </span>
                </>}
              </span>
              <b data-status={status}>{status}</b>
              <span
                aria-label={`Actions for enrollment link ${guestLinkId}`}
                className="admin-row-actions"
                role="group"
              >
                <button
                  aria-label={`Revoke enrollment link ${guestLinkId} for ${workspaceName}`}
                  disabled={Boolean(pendingAction) || status !== "active"}
                  onClick={() => void mutate("guest.revoke", guestLinkId)}
                  type="button"
                >
                  Revoke
                </button>
                <button
                  aria-label={`Delete record for enrollment link ${guestLinkId} in ${workspaceName}`}
                  className="danger"
                  disabled={Boolean(pendingAction)}
                  onClick={() => setPendingGuestDeletion(link)}
                  type="button"
                >
                  Delete record
                </button>
              </span>
            </div>;
          })}
          {!data.guestLinks.length && <p
            className="admin-empty"
            role="listitem"
          >
            No matching enrollment links
          </p>}
        </div>
        {moreButton("guestLinks", "enrollment links")}
      </section>
      <section
        aria-labelledby="admin-deletions-heading"
        id="admin-deletions"
        tabIndex={-1}
      >
        <h2 id="admin-deletions-heading">
          Workspace deletion tombstones <small>{resultCount(
            deletions,
            data.listInfo?.deletions,
          )}</small>
        </h2>
        <p className="admin-list-note">
          Tombstones are retained to prevent deleted server workspaces from being recreated by stale devices.
        </p>
        {resultNote(data.listInfo?.deletions) && <p className="admin-list-note">
          {resultNote(data.listInfo?.deletions)}
        </p>}
        <div
          aria-label="Workspace deletion records"
          className="admin-table admin-records"
          role="list"
        >
          {deletions.map(deletion => {
            const deletionId = stringValue(deletion.deletion_id);
            const workspaceId = stringValue(deletion.workspace_id);
            return <div
              aria-label={`Deletion ${deletionId} for workspace ${workspaceId}`}
              key={deletionId}
              role="listitem"
            >
              <span>
                <strong>{workspaceId}</strong>
                <small>Deletion {deletionId}</small>
                <small>
                  Deleted {formatDate(deletion.deleted_at)}
                  {" · "}
                  by {stringValue(deletion.deleted_by_display_name) || "system"}
                  {" · "}
                  {stringValue(deletion.deleted_by_email)}
                  {" · "}
                  {stringValue(deletion.deleted_by_user_id)}
                </small>
                <small>
                  Final snapshot revision {numberValue(deletion.final_snapshot_revision)}
                  {" · "}
                  final access revision {numberValue(deletion.final_access_revision)}
                </small>
              </span>
            </div>;
          })}
          {!deletions.length && <p
            className="admin-empty"
            role="listitem"
          >
            No matching deletion tombstones
          </p>}
        </div>
        {moreButton("deletions", "deletion tombstones")}
      </section>
      <section
        aria-labelledby="admin-oauth-states-heading"
        id="admin-oauth-states"
        tabIndex={-1}
      >
        <h2 id="admin-oauth-states-heading">
          OAuth diagnostics <small>{resultCount(
            oauthStates,
            data.listInfo?.oauthStates,
          )}</small>
        </h2>
        <p className="admin-list-note">
          Lifecycle metadata is visible without state hashes, PKCE verifiers, authorization codes, tokens, or return paths that could contain an invite.
        </p>
        {resultNote(data.listInfo?.oauthStates) && <p className="admin-list-note">
          {resultNote(data.listInfo?.oauthStates)}
        </p>}
        <div
          aria-label="OAuth diagnostic records"
          className="admin-table admin-records"
          role="list"
        >
          {oauthStates.map((oauth, index) => {
            const status = stringValue(oauth.status);
            const key = [
              stringValue(oauth.provider),
              stringValue(oauth.created_at),
              String(index),
            ].join(":");
            return <div
              aria-label={`OAuth ${stringValue(oauth.provider)} ${status} record`}
              key={key}
              role="listitem"
            >
              <span>
                <strong>{stringValue(oauth.provider)}</strong>
                <small>
                  Created {formatDate(oauth.created_at)}
                  {" · "}
                  expires {formatDate(oauth.expires_at)}
                  {Boolean(oauth.consumed_at)
                    ? ` · consumed ${formatDate(oauth.consumed_at)}`
                    : ""}
                </small>
              </span>
              <b data-status={status}>{status}</b>
            </div>;
          })}
          {!oauthStates.length && <p
            className="admin-empty"
            role="listitem"
          >
            No matching OAuth state rows
          </p>}
        </div>
        {moreButton("oauthStates", "OAuth records")}
      </section>
      <section
        aria-labelledby="admin-migrations-heading"
        id="admin-migrations"
        tabIndex={-1}
      >
        <h2 id="admin-migrations-heading">
          Migration records <small>{resultCount(
            migrations,
            data.listInfo?.migrations,
          )}</small>
        </h2>
        {resultNote(data.listInfo?.migrations) && <p className="admin-list-note">
          {resultNote(data.listInfo?.migrations)}
        </p>}
        <div
          aria-label="Migration records"
          className="admin-table admin-records"
          role="list"
        >
          {migrations.map((migration, index) => {
            const table = stringValue(migration.ledger_table);
            const record = stringValue(migration.name) ||
              stringValue(migration.migration_id) ||
              `record ${index + 1}`;
            return <div
              aria-label={`Migration ${record} in ${table}`}
              key={`${table}:${record}:${index}`}
              role="listitem"
            >
              <span>
                <strong>{record}</strong>
                <small>{table}</small>
                <small>Applied {formatDate(migration.applied_at)}</small>
              </span>
            </div>;
          })}
          {!migrations.length && <p
            className="admin-empty"
            role="listitem"
          >
            No matching migration ledger rows
          </p>}
        </div>
        {moreButton("migrations", "migration records")}
      </section>
      <section
        aria-labelledby="admin-audit-heading"
        id="admin-audit"
        tabIndex={-1}
      >
        <h2 id="admin-audit-heading">
          Auth audit <small>{resultCount(
            data.audit,
            data.listInfo?.audit,
          )}</small>
        </h2>
        <p className="admin-list-note">
          Successful security and control-plane changes are retained indefinitely unless an operator applies a documented retention policy.
        </p>
        {resultNote(data.listInfo?.audit) && <p className="admin-list-note">
          {resultNote(data.listInfo?.audit)}
        </p>}
        <div
          aria-label="Authentication audit records"
          className="admin-table admin-audit"
          role="list"
        >
          {data.audit.map(event => {
            const eventId = stringValue(event.event_id);
            const detail = prettyDetail(event.detail_json);
            const action = stringValue(event.action);
            return <div
              aria-label={`Audit event ${eventId}: ${action}`}
              key={eventId}
              role="listitem"
            >
              <span>
                <strong>{action}</strong>
                <small>
                  {formatDate(event.created_at)}
                  {" · "}
                  {stringValue(event.actor_display_name) || "system"}
                  {" · "}
                  {stringValue(event.actor_email)}
                  {" · "}
                  {stringValue(event.actor_user_id)}
                </small>
                <small>
                  {stringValue(event.target_type)}
                  {" · "}
                  {stringValue(event.target_id)}
                </small>
                {Boolean(event.ip_prefix) && <small>
                  Coarse network {stringValue(event.ip_prefix)}
                </small>}
              </span>
              {detail && <details>
                <summary
                  aria-label={`Details for audit event ${eventId}: ${action}`}
                >
                  Details
                </summary>
                <pre>{detail}</pre>
              </details>}
            </div>;
          })}
          {!data.audit.length && <p
            className="admin-empty"
            role="listitem"
          >
            No matching audit events
          </p>}
        </div>
        {moreButton("audit", "audit events")}
      </section>
      <ModalDialog
        busy={Boolean(pendingAction)}
        description={<>
          <p>
            This permanently removes the retained guest-link record and invalidates the link if it is still active. The raw invite URL cannot be recovered.
          </p>
          {pendingGuestDeletion && <p>
            Link {stringValue(pendingGuestDeletion.guest_link_id)} for {stringValue(pendingGuestDeletion.workspace_name) || stringValue(pendingGuestDeletion.workspace_id)} will be deleted.
          </p>}
          {Boolean(pendingGuestDeletion?.consumed_at) && <p>
            This link was already used. Deleting its record does not remove the resulting workspace member.
          </p>}
        </>}
        destructive
        onClose={() => {
          if (!pendingAction) setPendingGuestDeletion(null);
        }}
        open={Boolean(pendingGuestDeletion)}
        title="Delete this guest-link record?"
      >
        <div className="admin-dialog-actions">
          <button
            data-dialog-initial-focus
            disabled={Boolean(pendingAction)}
            onClick={() => setPendingGuestDeletion(null)}
            type="button"
          >
            Cancel
          </button>
          <button
            className="danger"
            disabled={Boolean(pendingAction)}
            onClick={() => {
              const guestLinkId = stringValue(
                pendingGuestDeletion?.guest_link_id,
              );
              if (!guestLinkId) return;
              void mutate("guest.delete", guestLinkId).then(saved => {
                if (saved) setPendingGuestDeletion(null);
              });
            }}
            type="button"
          >
            {pendingAction
              ? "Deleting..."
              : pendingGuestStatus === "active"
                ? "Delete and invalidate"
                : "Delete retained record"}
          </button>
        </div>
      </ModalDialog>
    </>}
  </main>;
}
