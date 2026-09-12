"use client";

import { useEffect, useId, useMemo, useRef, useState, type RefObject } from "react";
import {
  emptyBulkEditDraft,
  planBulkEdit,
  type BulkEditDraft,
  type BulkEditPreview,
  type TagEdit,
  type TagEditMode,
} from "../domain/bulk-edit";
import type { Frequency, ItemConstraints, JsonValue, WorkspaceState } from "../domain/types";
import { ModalDialog } from "./modal-dialog";
import { locationPath } from "./workspace-hierarchy";
import type { Commit } from "./workspace-view-types";
import styles from "./bulk-edit-dialog.module.css";

const PREVIEW_PAGE_SIZE = 10;
const FREQUENCIES: readonly Frequency[] = ["daily", "weekly", "monthly", "rarely"];
const REQUIREMENTS = [
  { key: "avoidHumidity", label: "Avoid humidity" },
  { key: "avoidWarmth", label: "Avoid warmth" },
  { key: "foodOnly", label: "Food-safe storage" },
] as const;
const FIELD_LABELS: Readonly<Record<string, string>> = Object.freeze({
  category: "Category",
  frequency: "Usage frequency",
  tags: "Tags",
  "constraints.avoidHumidity": "Avoid humidity",
  "constraints.avoidWarmth": "Avoid warmth",
  "constraints.foodOnly": "Food-safe storage",
  "constraints.keepTogether": "Keep-together group",
  "constraints.requiredTags": "Required space tags",
});

function valueLabel(value: JsonValue | undefined): string {
  if (value === true) return "Required";
  if (value === false) return "Not required";
  if (Array.isArray(value)) return value.length ? value.join(", ") : "None";
  return value === null || value === undefined || value === "" ? "None" : String(value);
}

function reviewSignature(preview: BulkEditPreview | null): string {
  if (!preview) return "";
  return JSON.stringify({
    command: preview.command,
    expectations: preview.expectations,
    plans: preview.discardedPlanCount,
    names: preview.items.map(({ item }) => item.name),
    spaces: preview.completedLocations.map((location) => [location.id, location.code, location.name]),
  });
}

function TagControl({
  label,
  name,
  onChange,
  value,
}: {
  label: string;
  name: string;
  onChange: (value: TagEdit) => void;
  value: TagEdit;
}) {
  const needsText = value.mode !== "keep" && value.mode !== "clear";
  const hintId = useId();
  return <div className={styles.field}>
    <label>
      <span>{label}</span>
      <select
        name={`${name}Mode`}
        onChange={(event) => onChange({ ...value, mode: event.currentTarget.value as TagEditMode })}
        value={value.mode}
      >
        <option value="keep">Keep existing</option>
        <option value="add">Add tags</option>
        <option value="remove">Remove tags</option>
        <option value="replace">Replace all tags</option>
        <option value="clear">Clear all tags</option>
      </select>
    </label>
    {needsText && <div className={styles.field}><label>
      <span>{label} to {value.mode === "replace" ? "use" : value.mode}</span>
      <input
        aria-describedby={hintId}
        autoComplete="off"
        name={`${name}Text`}
        onChange={(event) => onChange({ ...value, text: event.currentTarget.value })}
        placeholder="camping, dry"
        required
        value={value.text}
      />
    </label><small id={hintId}>Separate tags with commas.</small></div>}
  </div>;
}

export function BulkEditDialog({
  commit,
  itemIds,
  onClose,
  onSaved,
  returnFocusRef,
  state,
}: {
  commit: Commit;
  itemIds: readonly string[];
  onClose: () => void;
  onSaved: (count: number) => void;
  returnFocusRef: RefObject<HTMLButtonElement | null>;
  state: WorkspaceState;
}) {
  const [draft, setDraft] = useState(emptyBulkEditDraft);
  const [reviewed, setReviewed] = useState<BulkEditPreview | null>(null);
  const [reopenConfirmed, setReopenConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [page, setPage] = useState(0);
  const busyRef = useRef(false);
  const stageHeading = useRef<HTMLHeadingElement>(null);
  const result = useMemo(() => {
    try {
      return { preview: planBulkEdit(state, itemIds, draft), error: "" };
    } catch (failure) {
      return { preview: null, error: failure instanceof Error ? failure.message : "The edit could not be prepared" };
    }
  }, [draft, itemIds, state]);
  const stale = reviewed !== null && reviewSignature(reviewed) !== reviewSignature(result.preview);
  const stage = reviewed ? "review" : "edit";
  const pageCount = Math.max(1, Math.ceil((reviewed?.items.length ?? 0) / PREVIEW_PAGE_SIZE));
  const safePage = Math.min(page, pageCount - 1);
  const visibleItems = reviewed?.items.slice(safePage * PREVIEW_PAGE_SIZE, (safePage + 1) * PREVIEW_PAGE_SIZE) ?? [];
  const canSave = reviewed?.command && !stale && !result.error && !busy &&
    (reviewed.completedLocations.length === 0 || reopenConfirmed);

  useEffect(() => {
    const frame = requestAnimationFrame(() => stageHeading.current?.focus({ preventScroll: true }));
    return () => cancelAnimationFrame(frame);
  }, [stage]);

  const updateDraft = (changes: Partial<BulkEditDraft>) => {
    setDraft((current) => ({ ...current, ...changes }));
    setError("");
  };
  const setConstraint = <K extends keyof Omit<ItemConstraints, "requiredTags">>(key: K, value: ItemConstraints[K] | undefined) => {
    setDraft((current) => {
      const constraints = { ...current.constraints };
      if (value === undefined) delete constraints[key];
      else constraints[key] = value;
      return { ...current, constraints };
    });
    setError("");
  };
  const review = () => {
    if (!result.preview?.command || busyRef.current) return;
    setReviewed(result.preview);
    setReopenConfirmed(false);
    setPage(0);
    setError("");
  };
  const save = async () => {
    if (!canSave || !reviewed?.command || busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setError("");
    try {
      await commit(reviewed.command, reviewed.expectations);
      onSaved(reviewed.items.length);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "The changes could not be saved");
      setReopenConfirmed(false);
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  };
  const close = () => { if (!busyRef.current) onClose(); };
  const groupMode = draft.constraints.keepTogether === undefined
    ? "keep" : draft.constraints.keepTogether === null ? "clear" : "set";

  return <ModalDialog
    busy={busy}
    description={`${itemIds.length} selected item${itemIds.length === 1 ? "" : "s"}. Changes are saved together and can be undone from Activity.`}
    mobileSheet="content"
    onClose={close}
    open
    returnFocusRef={returnFocusRef}
    title="Edit selected items"
  >
    <div className={styles.body}>
      <h3 data-dialog-initial-focus ref={stageHeading} tabIndex={-1}>
        {reviewed ? "Review changes" : "Choose shared changes"}
      </h3>
      {(error || result.error) && <p className={styles.alert} role="alert">{error || result.error}</p>}
      {!reviewed ? <form onSubmit={(event) => { event.preventDefault(); review(); }}>
        <p className={styles.hint}>Only the fields you choose will change. Each item keeps its other details.</p>
        <div className={styles.fields}>
          <div className={styles.field}>
            <label className={styles.check}>
              <input
                checked={draft.category !== null}
                name="bulkChangeCategory"
                onChange={(event) => updateDraft({ category: event.currentTarget.checked ? "" : null })}
                type="checkbox"
              /> Change category
            </label>
            {draft.category !== null && <label>
              <span>Category</span>
              <input
                autoComplete="off"
                name="bulkCategory"
                onChange={(event) => updateDraft({ category: event.currentTarget.value })}
                placeholder="Camping equipment"
                required
                value={draft.category}
              />
            </label>}
          </div>
          <label className={styles.field}>
            <span>Usage frequency</span>
            <select name="bulkFrequency" onChange={(event) => updateDraft({ frequency: event.currentTarget.value as Frequency || null })} value={draft.frequency ?? ""}>
              <option value="">Keep existing</option>
              {FREQUENCIES.map((frequency) => <option key={frequency} value={frequency}>{frequency[0]!.toUpperCase() + frequency.slice(1)}</option>)}
            </select>
          </label>
          <TagControl label="Tags" name="bulkTags" onChange={(tags) => updateDraft({ tags })} value={draft.tags} />
        </div>
        <details className={styles.requirements}>
          <summary>Placement requirements</summary>
          <div className={styles.fields}>
            {REQUIREMENTS.map(({ key, label }) => <label className={styles.field} key={key}>
              <span>{label}</span>
              <select
                name={`bulk${key}`}
                onChange={(event) => setConstraint(key, event.currentTarget.value === "" ? undefined : event.currentTarget.value === "true")}
                value={draft.constraints[key] === undefined ? "" : String(draft.constraints[key])}
              >
                <option value="">Keep existing</option>
                <option value="true">Required</option>
                <option value="false">Not required</option>
              </select>
            </label>)}
            <div className={styles.field}>
              <label>
                <span>Keep-together group</span>
                <select
                  name="bulkGroupMode"
                  onChange={(event) => setConstraint("keepTogether", event.currentTarget.value === "keep" ? undefined : event.currentTarget.value === "clear" ? null : "")}
                  value={groupMode}
                >
                  <option value="keep">Keep existing</option>
                  <option value="set">Set group</option>
                  <option value="clear">Clear group</option>
                </select>
              </label>
              {groupMode === "set" && <label>
                <span>Group name</span>
                <input autoComplete="off" name="bulkGroup" onChange={(event) => setConstraint("keepTogether", event.currentTarget.value)} required value={draft.constraints.keepTogether ?? ""} />
              </label>}
            </div>
            <TagControl label="Required space tags" name="bulkRequiredTags" onChange={(requiredTags) => updateDraft({ requiredTags })} value={draft.requiredTags} />
          </div>
        </details>
        {!result.error && !result.preview?.command && <p className={styles.hint} role="status">No selected items would change. Choose a field to edit.</p>}
        <footer className={styles.actions}>
          <button onClick={close} type="button">Cancel</button>
          <button className="primary" disabled={!result.preview?.command} type="submit">Review changes</button>
        </footer>
      </form> : <>
        {stale && <div className={styles.alert} role="status">
          <p>The selected items or affected spaces changed. Refresh the preview before saving.</p>
          <button disabled={!result.preview?.command || busy} onClick={review} type="button">Refresh review</button>
        </div>}
        <p>
          <strong>{reviewed.items.length} item{reviewed.items.length === 1 ? "" : "s"} will change.</strong>
          {reviewed.unchangedCount > 0 && ` ${reviewed.unchangedCount} already match and will stay unchanged.`}
        </p>
        <div aria-label="Item changes" className={styles.preview}>
          {visibleItems.map(({ item, patches }) => <article key={item.id}>
            <h4>{item.name}</h4>
            <p className={styles.hint}>{locationPath(state.locations, item.locationId).map((location) => `${location.code} · ${location.name}`).join(" > ")}</p>
            <dl>{patches.map((patch) => <div key={patch.path}>
              <dt>{FIELD_LABELS[patch.path] ?? patch.path}</dt>
              <dd><span><small>Before</small><span>{valueLabel(patch.before)}</span></span><span><small>After</small><strong>{valueLabel(patch.after)}</strong></span></dd>
            </div>)}</dl>
          </article>)}
        </div>
        {pageCount > 1 && <nav aria-label="Preview pages" className={styles.actions}>
          <button disabled={safePage === 0} onClick={() => setPage(safePage - 1)} type="button">Previous items</button>
          <span>Page {safePage + 1} of {pageCount}</span>
          <button disabled={safePage === pageCount - 1} onClick={() => setPage(safePage + 1)} type="button">Next items</button>
        </nav>}
        {reviewed.completedLocations.length > 0 && <section className={styles.reopen}>
          <h4>Reopen completed spaces</h4>
          <p>These edits change the details recorded in completed spaces. Check their contents before marking them counted again.</p>
          <ul>{reviewed.completedLocations.map((location) => <li key={location.id}>{location.code} · {location.name}</li>)}</ul>
          <label className={styles.check}>
            <input
              checked={!stale && reopenConfirmed}
              disabled={stale || busy}
              name="bulkReopenConfirmed"
              onChange={(event) => setReopenConfirmed(event.currentTarget.checked)}
              type="checkbox"
            /> Reopen {reviewed.completedLocations.length} completed space{reviewed.completedLocations.length === 1 ? "" : "s"} with these edits
          </label>
        </section>}
        {reviewed.discardedPlanCount > 0 && <p className={styles.hint}>Affected move plans will be discarded so they can be regenerated with the updated details.</p>}
        <footer className={styles.actions}>
          <button disabled={busy} onClick={() => { setReviewed(null); setError(""); }} type="button">Back to editing</button>
          <button disabled={busy} onClick={close} type="button">Cancel</button>
          <button className="primary" disabled={!canSave} onClick={() => void save()} type="button">
            {busy ? "Saving..." : `Save ${reviewed.items.length} item${reviewed.items.length === 1 ? "" : "s"}`}
          </button>
        </footer>
      </>}
    </div>
  </ModalDialog>;
}
