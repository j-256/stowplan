"use client";

import Link from "next/link";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import type { WorkspaceState } from "../domain";
import { workspacePath } from "../domain/app-url";
import {
  ACCOUNT_CONTEXT_HEADER,
  accountContextHeaders,
} from "../shared/account-context";
import { ModalDialog } from "./modal-dialog";
import styles from "./admin-workspace-inspector.module.css";

interface AdminWorkspaceInspection {
  accessRevision: number;
  createdAt: string;
  inspectedAt: string;
  operatorRole: "editor" | "owner" | "viewer" | null;
  snapshotBytes: number;
  state: WorkspaceState;
  updatedAt: string;
  workspaceId: string;
}

interface AdminWorkspaceDeletion {
  deleted: true;
  deletedAt: string;
  deletionId: string;
  finalAccessRevision: number;
  finalSnapshotRevision: number;
  recovery: "not_available";
  workspaceId: string;
}

interface AdminWorkspaceInspectorProps {
  workspaceId: string;
}

function formatDate(value: string): string {
  const date = new Date(value);
  return Number.isFinite(date.getTime())
    ? date.toLocaleString()
    : "not recorded";
}

function formatBytes(bytes: number): string {
  if (bytes < 1_000) return `${bytes} B`;
  if (bytes < 1_000_000) {
    return `${(bytes / 1_000).toFixed(1)} kB`;
  }
  return `${(bytes / 1_000_000).toFixed(2)} MB`;
}

function responseError(body: unknown, fallback: string): string {
  return body &&
      typeof body === "object" &&
      "error" in body &&
      typeof body.error === "string"
    ? body.error
    : fallback;
}

async function readJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

function responseHasAccountMismatch(
  response: Response,
  accountId: string,
): boolean {
  const responseAccountId = response.headers.get(ACCOUNT_CONTEXT_HEADER);
  return responseAccountId === null
    ? response.ok
    : responseAccountId !== accountId;
}

function downloadName(state: WorkspaceState): string {
  const stem = state.workspace.name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-|-$/gu, "")
    .slice(0, 48) || "workspace";
  return `${stem}-admin-inspection.json`;
}

export function AdminWorkspaceInspector({
  workspaceId,
}: AdminWorkspaceInspectorProps) {
  const [inspection, setInspection] =
    useState<AdminWorkspaceInspection | null>(null);
  const accountId = useRef<string | null>(null);
  const [deletion, setDeletion] =
    useState<AdminWorkspaceDeletion | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [custodyOpen, setCustodyOpen] = useState(false);
  const [deletionOpen, setDeletionOpen] = useState(false);
  const [confirmationName, setConfirmationName] = useState("");
  const inspectionRequest = useRef(0);

  const load = useCallback(async () => {
    const requestId = inspectionRequest.current + 1;
    inspectionRequest.current = requestId;
    setLoading(true);
    setError("");
    try {
      let expectedAccountId = accountId.current;
      if (!expectedAccountId) {
        const accountResponse = await fetch("/api/auth/me", {
          cache: "no-store",
        });
        const accountBody = await readJson(accountResponse);
        if (
          !accountResponse.ok ||
          !accountBody ||
          typeof accountBody !== "object" ||
          !("user" in accountBody) ||
          !accountBody.user ||
          typeof accountBody.user !== "object" ||
          !("userId" in accountBody.user) ||
          typeof accountBody.user.userId !== "string" ||
          !accountBody.user.userId
        ) {
          throw new Error(
            responseError(
              accountBody,
              "An authenticated administrator account is required",
            ),
          );
        }
        if (requestId !== inspectionRequest.current) return;
        expectedAccountId = accountBody.user.userId;
        accountId.current = expectedAccountId;
      }
      const response = await fetch(
        `/api/admin/workspaces/${encodeURIComponent(workspaceId)}`,
        {
          body: JSON.stringify({ action: "inspect" }),
          cache: "no-store",
          headers: accountContextHeaders(expectedAccountId, {
            "content-type": "application/json",
          }),
          method: "POST",
        },
      );
      const body = await readJson(response);
      if (responseHasAccountMismatch(response, expectedAccountId)) {
        throw new Error(
          "The signed-in account changed; reload before inspecting this workspace",
        );
      }
      if (!response.ok) {
        throw new Error(
          responseError(body, "Could not inspect the workspace"),
        );
      }
      if (requestId !== inspectionRequest.current) return;
      accountId.current = expectedAccountId;
      setInspection(body as AdminWorkspaceInspection);
      setDeletion(null);
      setNotice("");
    } catch (reason) {
      if (requestId !== inspectionRequest.current) return;
      setError(
        reason instanceof Error && reason.message
          ? reason.message
          : "Could not inspect the workspace",
      );
    } finally {
      if (requestId === inspectionRequest.current) setLoading(false);
    }
  }, [workspaceId]);

  useEffect(() => {
    const timer = window.setTimeout(() => void load(), 0);
    return () => {
      window.clearTimeout(timer);
      inspectionRequest.current += 1;
    };
  }, [load]);

  const takeCustody = async () => {
    const expectedAccountId = accountId.current;
    if (!inspection || !expectedAccountId || busy || loading) return;
    inspectionRequest.current += 1;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const response = await fetch(
        `/api/admin/workspaces/${encodeURIComponent(workspaceId)}`,
        {
          body: JSON.stringify({
            action: "takeOwnership",
            expectedAccessRevision: inspection.accessRevision,
          }),
          headers: accountContextHeaders(expectedAccountId, {
            "content-type": "application/json",
          }),
          method: "POST",
        },
      );
      const body = await readJson(response);
      if (responseHasAccountMismatch(response, expectedAccountId)) {
        throw new Error(
          "The signed-in account changed; custody was not accepted",
        );
      }
      if (!response.ok) {
        throw new Error(
          responseError(body, "Could not take workspace custody"),
        );
      }
      const result = body as {
        accessRevision: number;
        operatorRole: "owner";
      };
      setInspection(current => current
        ? {
            ...current,
            accessRevision: result.accessRevision,
            operatorRole: result.operatorRole,
          }
        : current
      );
      setNotice(
        "Owner custody added and audited. You can now use ordinary owner controls or disable the prior final owner.",
      );
      setCustodyOpen(false);
    } catch (reason) {
      setError(
        reason instanceof Error && reason.message
          ? reason.message
          : "Could not take workspace custody",
      );
      setCustodyOpen(false);
    } finally {
      setBusy(false);
    }
  };

  const deleteWorkspace = async () => {
    const expectedAccountId = accountId.current;
    if (!inspection || !expectedAccountId || busy || loading) return;
    inspectionRequest.current += 1;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const response = await fetch(
        `/api/admin/workspaces/${encodeURIComponent(workspaceId)}`,
        {
          body: JSON.stringify({
            confirmationName,
            expectedAccessRevision: inspection.accessRevision,
            expectedRevision: inspection.state.workspace.revision,
          }),
          headers: accountContextHeaders(expectedAccountId, {
            "content-type": "application/json",
          }),
          method: "DELETE",
        },
      );
      const body = await readJson(response);
      if (responseHasAccountMismatch(response, expectedAccountId)) {
        throw new Error(
          "The signed-in account changed; deletion was not accepted",
        );
      }
      if (!response.ok) {
        throw new Error(
          responseError(body, "Could not delete the workspace"),
        );
      }
      setDeletion(body as AdminWorkspaceDeletion);
      setInspection(null);
      setDeletionOpen(false);
      setConfirmationName("");
    } catch (reason) {
      setError(
        reason instanceof Error && reason.message
          ? reason.message
          : "Could not delete the workspace",
      );
      setDeletionOpen(false);
    } finally {
      setBusy(false);
    }
  };

  const download = () => {
    if (!inspection) return;
    const url = URL.createObjectURL(new Blob(
      [JSON.stringify(inspection.state, null, 2)],
      { type: "application/json" },
    ));
    const anchor = document.createElement("a");
    anchor.download = downloadName(inspection.state);
    anchor.href = url;
    anchor.click();
    URL.revokeObjectURL(url);
  };

  if (deletion) {
    return <main className={styles.page}>
      <header className={styles.header}>
        <div>
          <p className={styles.eyebrow}>Global control plane</p>
          <h1>Server workspace deleted</h1>
        </div>
        <Link href="/admin#admin-deletions">Back to administration</Link>
      </header>
      <section className={styles.deleted} aria-live="polite">
        <p>
          The server copy was deleted immediately. There is no server-side
          recovery window.
        </p>
        <dl>
          <div>
            <dt>Workspace</dt>
            <dd>{deletion.workspaceId}</dd>
          </div>
          <div>
            <dt>Deletion record</dt>
            <dd>{deletion.deletionId}</dd>
          </div>
          <div>
            <dt>Deleted</dt>
            <dd>{formatDate(deletion.deletedAt)}</dd>
          </div>
          <div>
            <dt>Final snapshot revision</dt>
            <dd>{deletion.finalSnapshotRevision}</dd>
          </div>
        </dl>
        <p>
          The durable tombstone prevents stale devices, sync, membership
          changes, and guest redemption from recreating this workspace ID.
        </p>
      </section>
    </main>;
  }

  return <main className={styles.page}>
    <header className={styles.header}>
      <div>
        <p className={styles.eyebrow}>Audited global control plane</p>
        <h1>
          {inspection?.state.workspace.name || "Workspace inspection"}
        </h1>
      </div>
      <Link href="/admin#admin-workspaces">Back to administration</Link>
    </header>
    {error && <div className={styles.error} role="alert">
      <strong>{error}</strong>
      <button
        disabled={loading || busy}
        onClick={() => void load()}
        type="button"
      >
        {inspection ? "Refresh inspected snapshot" : "Retry"}
      </button>
    </div>}
    {notice && <output className={styles.notice}>{notice}</output>}
    {loading && !inspection && <p>Loading audited workspace content...</p>}
    {inspection && <>
      <section className={styles.intro}>
        <p>
          This is the complete validated server snapshot. Opening this page
          created a non-secret <code>workspace.inspect</code> audit event and
          did not add a workspace membership or local replica.
        </p>
        <p>
          Content edits remain on Stowplan&apos;s deterministic workspace
          command path so field history and conflicts stay intact. The global
          control plane can inspect, export, take explicit owner custody, or
          delete the entire server workspace.
        </p>
      </section>
      <section aria-labelledby="inspection-summary-heading">
        <h2 id="inspection-summary-heading">Snapshot summary</h2>
        <dl className={styles.summary}>
          <div>
            <dt>Stable workspace ID</dt>
            <dd>{inspection.workspaceId}</dd>
          </div>
          <div>
            <dt>Operator membership</dt>
            <dd>{inspection.operatorRole ?? "none"}</dd>
          </div>
          <div>
            <dt>Snapshot revision</dt>
            <dd>{inspection.state.workspace.revision}</dd>
          </div>
          <div>
            <dt>Access revision</dt>
            <dd>{inspection.accessRevision}</dd>
          </div>
          <div>
            <dt>Serialized size</dt>
            <dd>{formatBytes(inspection.snapshotBytes)}</dd>
          </div>
          <div>
            <dt>Created</dt>
            <dd>{formatDate(inspection.createdAt)}</dd>
          </div>
          <div>
            <dt>Server updated</dt>
            <dd>{formatDate(inspection.updatedAt)}</dd>
          </div>
          <div>
            <dt>Inspected</dt>
            <dd>{formatDate(inspection.inspectedAt)}</dd>
          </div>
          <div>
            <dt>Locations</dt>
            <dd>{inspection.state.locations.length}</dd>
          </div>
          <div>
            <dt>Items</dt>
            <dd>{inspection.state.items.length}</dd>
          </div>
          <div>
            <dt>Plans</dt>
            <dd>{inspection.state.plans.length}</dd>
          </div>
          <div>
            <dt>Activities</dt>
            <dd>{inspection.state.activities.length}</dd>
          </div>
        </dl>
      </section>
      <section aria-labelledby="inspection-content-heading">
        <div className={styles.sectionHeading}>
          <div>
            <h2 id="inspection-content-heading">Complete snapshot content</h2>
            <p>
              Browser Find searches names, notes, IDs, plans, history, and
              command receipts in this validated representation.
            </p>
          </div>
          <div className={styles.sectionActions}>
            <button
              disabled={loading || busy}
              onClick={() => void load()}
              type="button"
            >
              {loading ? "Refreshing..." : "Refresh inspection"}
            </button>
            <button onClick={download} type="button">
              Export inspected snapshot
            </button>
          </div>
        </div>
        <pre
          aria-label="Complete validated workspace snapshot"
          className={styles.snapshot}
          tabIndex={0}
        >
          {JSON.stringify(inspection.state, null, 2)}
        </pre>
      </section>
      <section
        aria-labelledby="inspection-controls-heading"
        className={styles.controls}
      >
        <h2 id="inspection-controls-heading">Operator controls</h2>
        <p>
          Custody is an explicit, audited owner membership. Use it before
          disabling a workspace&apos;s final owner when the server copy should
          remain available. Deletion is immediate and removes the server
          snapshot, memberships, and guest links.
        </p>
        <div className={styles.actions}>
          {inspection.operatorRole === "owner"
            ? <span className={styles.ownerStatus}>
                Owner custody is active
              </span>
            : <button
                disabled={busy || loading}
                onClick={() => setCustodyOpen(true)}
                type="button"
              >
                Take owner custody
              </button>}
          {inspection.operatorRole && <Link href={workspacePath({
            view: "settings",
            workspaceId: inspection.workspaceId,
            workspaceLabel: inspection.state.workspace.name,
          })}>
            Open member settings
          </Link>}
          <button
            className="danger"
            disabled={busy || loading}
            onClick={() => {
              setConfirmationName("");
              setDeletionOpen(true);
            }}
            type="button"
          >
            Delete server workspace
          </button>
        </div>
      </section>
    </>}
    <ModalDialog
      busy={busy}
      description={<p>
        This adds your global-admin account as a workspace owner. It preserves
        the existing owners, advances authorization revisions, and creates an
        audit event. It also makes ordinary member-scoped workspace URLs
        available to this account.
      </p>}
      onClose={() => {
        if (!busy) setCustodyOpen(false);
      }}
      open={custodyOpen}
      title="Take owner custody?"
    >
      <div className={styles.dialogActions}>
        <button
          data-dialog-initial-focus
          disabled={busy}
          onClick={() => setCustodyOpen(false)}
          type="button"
        >
          Cancel
        </button>
        <button
          disabled={busy}
          onClick={() => void takeCustody()}
          type="button"
        >
          {busy ? "Taking custody..." : "Add owner membership"}
        </button>
      </div>
    </ModalDialog>
    <ModalDialog
      busy={busy}
      description={<>
        <p>
          This immediately deletes the server snapshot, memberships, and guest
          links. It leaves an audit event and durable tombstone, but there is
          no server-side recovery window.
        </p>
        <p>
          Existing device replicas are not remotely erased. Export this
          inspected snapshot first if a user-held recovery copy is needed.
        </p>
      </>}
      destructive
      onClose={() => {
        if (!busy) setDeletionOpen(false);
      }}
      open={deletionOpen}
      title="Delete this server workspace?"
    >
      <label className={styles.confirmation}>
        <span>
          Type <strong>{inspection?.state.workspace.name}</strong> to confirm
        </span>
        <input
          autoComplete="off"
          data-dialog-initial-focus
          disabled={busy}
          onChange={event => setConfirmationName(event.target.value)}
          value={confirmationName}
        />
      </label>
      <div className={styles.dialogActions}>
        <button
          disabled={busy}
          onClick={() => setDeletionOpen(false)}
          type="button"
        >
          Cancel
        </button>
        <button
          className="danger"
          disabled={
            busy ||
            confirmationName !== inspection?.state.workspace.name
          }
          onClick={() => void deleteWorkspace()}
          type="button"
        >
          {busy ? "Deleting..." : "Delete server workspace"}
        </button>
      </div>
    </ModalDialog>
  </main>;
}
