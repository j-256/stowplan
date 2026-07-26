"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  workspacePath,
} from "../domain/app-url";
import {
  workspaceHubCardMatches,
  type WorkspaceHubCard,
} from "./workspace-hub-state";
import { ModalDialog } from "./modal-dialog";
import styles from "./workspace-hub.module.css";

const CARD_STATE_COPY = Object.freeze({
  blocked: "Backup refused one or more local changes",
  "device-only": "Stored only on this device",
  "locally-newer": "This device has newer work",
  offline: "Server workspace unavailable while offline",
  "pending-upload": "Local changes are waiting to upload",
  "server-newer": "The server copy is newer",
  "server-only": "Available from the server",
  synchronized: "Device and server are synchronized",
  unavailable: "Workspace access is unavailable",
});

interface WorkspaceHubProps {
  backupConfigured: boolean | null;
  cards: readonly WorkspaceHubCard[];
  catalogError: string | null;
  catalogLoading: boolean;
  currentId?: string;
  hasMore: boolean;
  online: boolean;
  onContinue?: () => void;
  onLoadMore: () => Promise<void>;
  onOpen: (workspaceId: string) => Promise<void>;
  onOpenDemo: () => Promise<void>;
  onRefresh: () => Promise<void>;
  onReviewRecovery: (workspaceId: string) => Promise<void>;
  onRemove: (
    workspaceId: string,
    expectedUpdatedAt?: string,
  ) => Promise<void>;
  onResetDemo?: () => Promise<void>;
  onStart: (demo: boolean, name?: string) => Promise<void>;
  signedIn: boolean;
}

function formatDate(value: string | null): string {
  if (!value) return "Not available";
  const date = new Date(value);
  return Number.isFinite(date.getTime())
    ? date.toLocaleString()
    : "Not available";
}

function roleLabel(card: WorkspaceHubCard): string {
  if (card.access.kind === "device-only") return "Device owner";
  if (card.access.status === "deleted") return "Server deleted";
  if (card.access.status === "left") return "Membership left";
  if (card.access.status === "revoked") return "Access removed";
  if (card.role) {
    return `${card.role[0].toLocaleUpperCase()}${card.role.slice(1)}`;
  }
  return "Role unavailable";
}

function removalWarning(card: WorkspaceHubCard): string | null {
  if (card.presence !== "local-only") return null;
  if (card.access.kind === "device-only") {
    return "This device holds the only known copy. Export a backup first if you need to keep it.";
  }
  if (card.access.status === "deleted") {
    return "The server copy was deleted. Export this retained device copy first if you need to keep it.";
  }
  return "Server access is unavailable. Export this retained device copy first if you need to keep it.";
}

export function WorkspaceHub({
  backupConfigured,
  cards,
  catalogError,
  catalogLoading,
  currentId,
  hasMore,
  online,
  onContinue,
  onLoadMore,
  onOpen,
  onOpenDemo,
  onRefresh,
  onReviewRecovery,
  onRemove,
  onResetDemo,
  onStart,
  signedIn,
}: WorkspaceHubProps) {
  const headingRef = useRef<HTMLHeadingElement>(null);
  const [query, setQuery] = useState("");
  const [workspaceName, setWorkspaceName] = useState("");
  const [busyId, setBusyId] = useState<string | null>(null);
  const [removeCard, setRemoveCard] = useState<WorkspaceHubCard | null>(null);
  const [resetCard, setResetCard] = useState<WorkspaceHubCard | null>(null);
  const [alert, setAlert] = useState("");
  const filtered = useMemo(
    () => cards.filter((card) => workspaceHubCardMatches(card, query)),
    [cards, query],
  );
  useEffect(() => {
    if (!currentId) return;
    const frame = requestAnimationFrame(() => {
      window.scrollTo({ left: 0, top: 0 });
      headingRef.current?.focus({ preventScroll: true });
    });
    return () => cancelAnimationFrame(frame);
  }, [currentId]);

  const run = async (
    id: string,
    action: () => Promise<void>,
    fallback: string,
  ): Promise<boolean> => {
    setAlert("");
    setBusyId(id);
    try {
      await action();
      return true;
    } catch (error) {
      setAlert(error instanceof Error ? error.message : fallback);
      return false;
    } finally {
      setBusyId(null);
    }
  };

  const createWorkspace = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const name = workspaceName.trim();
    if (!name) return;
    await run("create", () => onStart(false, name), "Could not create workspace");
  };

  const confirmRemoval = async () => {
    if (!removeCard) return;
    const card = removeCard;
    await run(
      card.id,
      () => onRemove(card.id, card.localUpdatedAt ?? undefined),
      "Could not remove this device copy",
    );
    setRemoveCard(null);
  };

  const confirmDemoReset = async () => {
    if (!resetCard || !onResetDemo) return;
    if (await run(
      "reset-demo",
      onResetDemo,
      "Could not reset the kitchen demo",
    )) {
      setResetCard(null);
    }
  };

  return <main className={styles.hub}>
    <header>
      <div>
        <p className="eyebrow">Device and server workspaces</p>
        <h1 ref={headingRef} tabIndex={-1}>Your workspaces</h1>
        <p>Open local work offline, discover authorized server workspaces after sign-in, and review backup state in one place.</p>
      </div>
      <div className={styles.headerActions}>
        {currentId && onContinue &&
          <button className="primary" onClick={onContinue} type="button">
            Continue current workspace
          </button>}
        <button
          disabled={catalogLoading || !online || !signedIn}
          onClick={() => void run(
            "refresh",
            onRefresh,
            "Could not refresh server workspaces",
          )}
          type="button"
        >
          {catalogLoading ? "Refreshing..." : "Refresh server list"}
        </button>
      </div>
    </header>

    {alert && <output className={styles.alert} role="alert">{alert}</output>}
    {catalogError && <output className={styles.alert} role="alert">
      {catalogError}
    </output>}
    {backupConfigured === false && <p className={styles.notice}>
      This deployment is device-only. Local workspaces remain available.
    </p>}
    {backupConfigured && !signedIn && <p className={styles.notice}>
      Sign in to discover server workspaces on this device.{" "}
      <a href="/account?returnTo=%2Fworkspaces">Open Account</a>
    </p>}

    <section className={styles.toolbar} aria-label="Workspace tools">
      <label>
        <span>Search workspaces</span>
        <input
          onChange={(event) => setQuery(event.currentTarget.value)}
          placeholder="Name, role, or status"
          type="search"
          value={query}
        />
      </label>
      <form onSubmit={createWorkspace}>
        <label>
          <span>New device workspace</span>
          <input
            maxLength={80}
            onChange={(event) => setWorkspaceName(event.currentTarget.value)}
            placeholder="Workspace name"
            required
            value={workspaceName}
          />
        </label>
        <button className="primary" disabled={busyId === "create"}>
          Create
        </button>
      </form>
      <button
        disabled={busyId === "demo"}
        onClick={() => void run(
          "demo",
          onOpenDemo,
          "Could not open the kitchen demo",
        )}
        type="button"
      >
        Open kitchen demo
      </button>
    </section>

    <section className={styles.cards} aria-busy={catalogLoading}>
      {filtered.map((card) => {
        const serverBacked = card.access.kind === "server";
        const accessPath = workspacePath({
          view: "access",
          workspaceId: card.id,
          workspaceLabel: card.name,
        });
        const unavailableOffline =
          card.presence === "server-only" && !online;
        const current = card.id === currentId;
        return <article className={styles.card} key={card.id}>
          <header>
            <span>
              <h2>{card.name}</h2>
              {card.localName && card.serverName &&
                card.localName !== card.serverName &&
                <small>Server name: {card.serverName}</small>}
            </span>
            <b>{roleLabel(card)}</b>
          </header>
          <p className={styles.state} data-state={card.state}>
            {CARD_STATE_COPY[card.state]}
          </p>
          <dl>
            <div><dt>Last local edit</dt><dd>{formatDate(card.localUpdatedAt)}</dd></div>
            <div><dt>Last successful backup</dt><dd>{formatDate(card.lastSyncedAt)}</dd></div>
            <div><dt>Pending changes</dt><dd>{card.pending}</dd></div>
            <div><dt>Blocked changes</dt><dd>{card.blocked}</dd></div>
          </dl>
          {card.lastSyncError && <p className={styles.cardError}>
            Latest backup check: {card.lastSyncError}
          </p>}
          <div className={styles.actions}>
            {unavailableOffline
              ? <button
                  aria-disabled="true"
                  onClick={() => setAlert(
                    `${card.name} is stored on the server and needs a network connection before it can be opened on this device.`,
                  )}
                  type="button"
                >
                  Open when online
                </button>
              : <button
                  className="primary"
                  disabled={busyId === card.id}
                  onClick={() => void run(
                    card.id,
                    () => onOpen(card.id),
                    "Could not open workspace",
                  )}
                  type="button"
                >
                  {current ? "Continue" : card.presence === "server-only"
                    ? "Download and open"
                    : "Open"}
                </button>}
            {serverBacked && card.access.status === "active" &&
              <a href={accessPath}>Workspace access</a>}
            {card.blocked > 0 &&
              <button
                disabled={busyId === `recovery:${card.id}`}
                onClick={() => void run(
                  `recovery:${card.id}`,
                  () => onReviewRecovery(card.id),
                  "Could not open sync recovery",
                )}
                type="button"
              >
                Review sync issues
              </button>}
            {current &&
              (
                card.access.kind === "device-only" ||
                card.capabilities.delete
              ) &&
              card.id.startsWith("ws_demo") &&
              onResetDemo &&
              <button
                className="danger"
                disabled={busyId === "reset-demo"}
                onClick={() => setResetCard(card)}
                type="button"
              >
                Reset kitchen demo
              </button>}
            {card.presence !== "server-only" &&
              <button
                className="danger"
                onClick={() => setRemoveCard(card)}
                type="button"
              >
                Remove from this device
              </button>}
          </div>
        </article>;
      })}
      {filtered.length === 0 && <p className={styles.empty}>
        {cards.length === 0 && catalogLoading
          ? "Loading workspaces..."
          : "No workspaces match this search."}
      </p>}
    </section>

    {hasMore && <div className={styles.more}>
      <p>More authorized server workspaces are available.</p>
      <button
        disabled={catalogLoading || !online}
        onClick={() => void run(
          "more",
          onLoadMore,
          "Could not load more workspaces",
        )}
        type="button"
      >
        Load more
      </button>
    </div>}

    <ModalDialog
      description={removeCard
        ? <>
            <p>This removes only the local replica. It does not delete the server copy or change membership.</p>
            <p><strong>{removeCard.pending}</strong> pending and <strong>{removeCard.blocked}</strong> blocked local changes are stored on this device.</p>
            {removalWarning(removeCard) &&
              <p>{removalWarning(removeCard)}</p>}
          </>
        : undefined}
      destructive
      onClose={() => setRemoveCard(null)}
      open={Boolean(removeCard)}
      title={removeCard
        ? `Remove ${removeCard.name} from this device?`
        : "Remove workspace from this device?"}
    >
      <div className={styles.dialogActions}>
        <button
          data-dialog-initial-focus
          onClick={() => setRemoveCard(null)}
          type="button"
        >
          Cancel
        </button>
        <button
          className="danger"
          disabled={Boolean(removeCard && busyId === removeCard.id)}
          onClick={() => void confirmRemoval()}
          type="button"
        >
          Remove device copy
        </button>
      </div>
    </ModalDialog>

    <ModalDialog
      description={resetCard
        ? resetCard.access.kind === "server"
          ? "This permanently deletes this demo's server instance, removes its memberships and invite links, and discards its device changes and queued backup commands. A fresh private demo instance will open on this device. Other workspaces are not affected."
          : "This permanently discards this demo's device changes and queued backup commands. A fresh private demo instance will open on this device. Other workspaces are not affected."
        : undefined}
      destructive
      onClose={() => setResetCard(null)}
      open={Boolean(resetCard)}
      title="Reset the kitchen demo?"
    >
      <div className={styles.dialogActions}>
        <button
          data-dialog-initial-focus
          disabled={busyId === "reset-demo"}
          onClick={() => setResetCard(null)}
          type="button"
        >
          Cancel
        </button>
        <button
          className="danger"
          disabled={busyId === "reset-demo"}
          onClick={() => void confirmDemoReset()}
          type="button"
        >
          {busyId === "reset-demo"
            ? "Resetting..."
            : resetCard?.access.kind === "server"
              ? "Delete old demo and reset"
              : "Reset demo"}
        </button>
      </div>
    </ModalDialog>
  </main>;
}
