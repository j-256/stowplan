"use client";

import {
  useEffect,
  useRef,
  useState,
} from "react";
import {
  ChevronDown,
  Home,
} from "lucide-react";
import {
  WORKSPACE_LIST_PATH,
  workspacePath,
} from "../domain/app-url";
import type {
  ThemePreference,
  WorkspaceState,
} from "../domain/types";
import { ActivityHistory } from "./activity-history";
import {
  SOURCE_REPOSITORY_URL,
  USER_GUIDE_URL,
} from "./external-links";
import {
  followAppLink,
  perform,
  showFeedback,
  submitForm,
} from "./workspace-view-helpers";
import type { Commit } from "./workspace-view-types";

export function History({ state, commit }: { state: WorkspaceState; commit: Commit }) {
  return <ActivityHistory
    onCommand={(command) => perform(commit, command)}
    state={state}
  />;
}
export function Preferences({ state, commit, theme, setTheme, openMenu, returnTo, serverBacked }: { state: WorkspaceState; commit: Commit; theme: ThemePreference; setTheme: (theme: ThemePreference) => void; openMenu: () => void; returnTo: string; serverBacked: boolean }) {
  const [backupToolsOpen, setBackupToolsOpen] = useState(false);
  const [helpToolsOpen, setHelpToolsOpen] = useState(false);
  const workspaceNameBaseline = useRef({
    id: state.workspace.id,
    name: state.workspace.name,
  });
  const [workspaceNameDraft, setWorkspaceNameDraft] = useState(
    state.workspace.name,
  );
  useEffect(() => {
    const previous = workspaceNameBaseline.current;
    workspaceNameBaseline.current = {
      id: state.workspace.id,
      name: state.workspace.name,
    };
    setWorkspaceNameDraft((current) =>
      previous.id !== state.workspace.id || current === previous.name
        ? state.workspace.name
        : current
    );
  }, [state.workspace.id, state.workspace.name]);
  const download = () => {
    let url: string | null = null;
    try {
      const anchor = document.createElement("a");
      url = URL.createObjectURL(
        new Blob(
          [JSON.stringify(state, null, 2)],
          { type: "application/json" },
        ),
      );
      anchor.href = url;
      anchor.download = `stowplan-${state.workspace.id}.json`;
      anchor.click();
    } catch (error) {
      showFeedback(
        `Could not export this workspace: ${
          error instanceof Error ? error.message : "browser download failed"
        }`,
      );
    } finally {
      if (url) URL.revokeObjectURL(url);
    }
  };
  return <div className="content settings">
    <section className="panel">
      <h2>Workspace</h2>
      <form className="workspace-rename" onSubmit={(event) => submitForm(event, (data) => perform(commit, { type: "workspace.rename", name: String(data.get("workspaceName")) }), false)}>
        <label>Workspace name<input required maxLength={80} name="workspaceName" value={workspaceNameDraft} onChange={(event) => setWorkspaceNameDraft(event.currentTarget.value)} /></label>
        <button>Rename workspace</button>
      </form>
      <p className="muted settings-workspace-help">Switch workspaces, inspect backup status, or manage device copies.</p>
      <a className="settings-workspaces-link" href={WORKSPACE_LIST_PATH} onClick={(event) => followAppLink(event, openMenu)}><Home /> Workspaces and backup status</a>
      {serverBacked && <a href={workspacePath({ view: "access", workspaceId: state.workspace.id, workspaceLabel: state.workspace.name })}>Workspace access</a>}
      <h2>Appearance</h2>
      <div className="segments">{(["system", "light", "dark"] as const).map((entry) => <button aria-pressed={theme === entry} data-active={theme === entry} key={entry} onClick={() => setTheme(entry)}>{entry}</button>)}</div>
      <div className="settings-disclosure" data-open={backupToolsOpen ? "true" : undefined}>
        <button
          aria-expanded={backupToolsOpen}
          className="settings-disclosure-trigger"
          onClick={() => setBackupToolsOpen((open) => !open)}
          type="button"
        >
          <span><strong>Backup & recovery</strong><small>Export, restore, and print labels</small></span>
          <ChevronDown aria-hidden="true" />
        </button>
        <div className="settings-disclosure-body">
          <h2>Backup & recovery</h2>
          <p className="muted">Export a complete portable snapshot. Imports are validated and previewed before replacement.</p>
          <button onClick={download}>Export JSON backup</button>
          <a href="/recovery">Review sync issues or restore a backup</a>
          <a href="/labels">Print text and QR labels</a>
        </div>
      </div>
    </section>
    <section className="panel">
      <h2>Account & server backup</h2>
      <a href={`/account?workspace=${encodeURIComponent(state.workspace.id)}&returnTo=${encodeURIComponent(returnTo)}`}>Sign in or review this account</a>
      <div className="settings-disclosure" data-open={helpToolsOpen ? "true" : undefined}>
        <button
          aria-expanded={helpToolsOpen}
          className="settings-disclosure-trigger"
          onClick={() => setHelpToolsOpen((open) => !open)}
          type="button"
        >
          <span><strong>Help & source</strong><small>Guides, repository, and license</small></span>
          <ChevronDown aria-hidden="true" />
        </button>
        <div className="settings-disclosure-body">
          <h2>Help & source</h2>
          <a target="_blank" rel="noreferrer" href={USER_GUIDE_URL}>Open full user guide</a>
          <a href="/docs/">Read the offline quick guide</a>
          <a target="_blank" rel="noreferrer" href={SOURCE_REPOSITORY_URL}>View source repository</a>
          <p className="license">A Strange Lasers project<br />AGPL-3.0-only<br />Copyright © 2026 James Klein (j-256)</p>
        </div>
      </div>
    </section>
  </div>;
}
