"use client";

import { ArrowLeft, ArrowRight, Check, CheckCircle2, Cloud, Info, ShieldCheck, SkipForward, Smartphone, TriangleAlert, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { DomainError } from "../domain/errors";
import type { JsonValue, WorkspaceState } from "../domain/types";
import { ModalDialog } from "./modal-dialog";
import { recoveryCommandLabel } from "./recovery-permissions";
import type { LocalReplica } from "./local-replica";
import {
  applyRecoveryReviewDecision, projectRecoveryReview, recoveryCommandWasApplied,
  type RecoveryFieldChoice, type RecoveryReviewDecision, type RecoveryReviewField,
} from "./conflict-review";
import styles from "./conflict-review.module.css";

const FIELD_PAGE_SIZE = 12;
const HIDDEN_RECORD_FIELDS = new Set(["id", "createdAt", "updatedAt", "version"]);
const FIELD_LABELS: Readonly<Record<string, string>> = Object.freeze({
  "": "Record", name: "Name", description: "Description", category: "Category", frequency: "Use frequency",
  locationId: "Space", parentId: "Parent space", captureStatus: "Capture status", archivedAt: "Archive status",
  "constraints.avoidHumidity": "Avoid humidity", "constraints.avoidWarmth": "Avoid warmth",
  "constraints.foodOnly": "Food-safe storage", "constraints.keepTogether": "Keep together",
  "constraints.requiredTags": "Required space tags", "conditions.foodSafe": "Food-safe space",
  "conditions.dark": "Dark storage", "conditions.dry": "Dry storage", "conditions.humidity": "Humidity",
  "conditions.temperature": "Temperature", version: "Item revision", revision: "Workspace revision",
  sourceId: "From", destinationId: "To", itemId: "Item",
});

function fieldLabel(path: string): string {
  return FIELD_LABELS[path] ?? FIELD_LABELS[path.split(".").at(-1) ?? ""] ?? path.replace(/([a-z])([A-Z])/gu, "$1 $2").replaceAll(".", " ").replace(/^./u, (letter) => letter.toUpperCase());
}

function valueLabel(value: JsonValue | undefined, field: RecoveryReviewField, state: WorkspaceState): string {
  if (value === undefined) return "Unavailable";
  if (value === null || value === "") return "None";
  if (typeof value === "boolean") return value ? "Yes" : "No";
  if (Array.isArray(value)) return value.length === 0 ? "None" : value.every((entry) => typeof entry === "string") ? value.join(", ") : `${value.length} entries`;
  if (typeof value === "object") {
    if (typeof value.name === "string") return value.name;
    if (value.width && value.height && value.depth) return `${value.width} × ${value.height} × ${value.depth} ${value.unit}`;
    if (typeof value.destinationId === "string") {
      const subject = state.items.find((item) => item.id === value.itemId)?.name ?? state.locations.find((location) => location.id === value.locationId)?.name ?? "Move";
      return `${subject} → ${state.locations.find((location) => location.id === value.destinationId)?.name ?? "Unavailable space"}`;
    }
    return `${Object.keys(value).length} fields`;
  }
  const leaf = field.path.split(".").at(-1);
  if (["locationId", "parentId", "sourceId", "destinationId"].includes(leaf ?? "")) {
    const location = state.locations.find((candidate) => candidate.id === value);
    return location ? `${location.code} · ${location.name}` : "Unavailable space";
  }
  if (leaf === "itemId") return state.items.find((item) => item.id === value)?.name ?? "Unavailable item";
  return field.path === "captureStatus" ? String(value).replaceAll("_", " ") : String(value);
}

function subjectLabel(field: RecoveryReviewField, state: WorkspaceState): string {
  if (field.target === "workspace") return "Workspace";
  return (field.target === "item" ? state.items : field.target === "location" ? state.locations : state.plans)
    .find((record) => record.id === field.id)?.name ?? "Unavailable record";
}

function Value({ value, field, state, compact = false }: { value: JsonValue | undefined; field: RecoveryReviewField; state: WorkspaceState; compact?: boolean }) {
  const [limit, setLimit] = useState(FIELD_PAGE_SIZE);
  const entries = !compact && value !== null && typeof value === "object" &&
    (!Array.isArray(value) || value.some((entry) => typeof entry === "object"))
    ? Object.entries(value).filter(([key]) => !HIDDEN_RECORD_FIELDS.has(key)) : [];
  return <><span className={styles.value}>{valueLabel(value, field, state)}</span>{entries.length > 0 && <details><summary>Show details</summary><dl className={styles.valueDetails}>{entries.slice(0, limit).map(([key, entry]) => <div key={key}><dt>{Array.isArray(value) ? `Entry ${Number(key) + 1}` : fieldLabel(key)}</dt><dd><Value value={entry} field={{ ...field, path: field.path ? `${field.path}.${key}` : key }} state={state} /></dd></div>)}</dl>{entries.length > limit && <button onClick={() => setLimit(limit + FIELD_PAGE_SIZE)} type="button">Show more details ({entries.length - limit})</button>}</details>}</>;
}

function FieldCard({ field, state, choice, onChoice }: {
  field: RecoveryReviewField; state: WorkspaceState; choice?: RecoveryFieldChoice;
  onChoice: (choice: RecoveryFieldChoice) => void;
}) {
  const subject = subjectLabel(field, state);
  return <fieldset className={styles.field}>
    <legend><strong>{subject ?? "Unavailable record"}</strong><span>{fieldLabel(field.path)}</span></legend>
    <div className={styles.choices}>
      {(["device", "server"] as const).map((side) => <label key={side} className={styles.choice} data-side={side} data-selected={choice === side}>
        <span className={styles.choiceTitle}>{side === "device" ? <Smartphone aria-hidden="true" /> : <Cloud aria-hidden="true" />}{side === "device" ? "Use device" : "Keep online"}<input aria-label={`${side === "device" ? "Use device" : "Keep online"}: ${valueLabel(field[side], field, state)}`} checked={choice === side} name={`review-${field.key}`} onChange={() => onChoice(side)} type="radio" value={side} /></span>
        <Value compact value={field[side]} field={field} state={state} />
      </label>)}
    </div>
    <details className={styles.before}><summary>Before this device edit</summary><Value value={field.before} field={field} state={state} /></details>
  </fieldset>;
}

export function ConflictReviewDialog({ replica, server, busy, error, onClose, onSave }: {
  replica: LocalReplica; server: WorkspaceState; busy: boolean; error: string;
  onClose: () => void; onSave: (decisions: RecoveryReviewDecision[]) => Promise<void>;
}) {
  const [decisions, setDecisions] = useState<RecoveryReviewDecision[]>([]);
  const [choices, setChoices] = useState<Record<string, RecoveryFieldChoice>>({});
  const [acceptContext, setAcceptContext] = useState(false);
  const [limit, setLimit] = useState(FIELD_PAGE_SIZE);
  const heading = useRef<HTMLHeadingElement>(null);
  const reviewed = useMemo(() => {
    try { return { projection: projectRecoveryReview(replica, server, decisions), error: "" }; }
    catch (problem) { return { projection: null, error: problem instanceof Error ? problem.message : "This queue could not be reviewed. Keep its recovery bundle." }; }
  }, [replica, server, decisions]);
  const projection = reviewed.projection;
  const step = projection?.next;
  const decision: RecoveryReviewDecision | null = step ? { commandId: step.entry.envelope.id, action: "apply", choices, acceptContext } : null;
  let preview: ReturnType<typeof applyRecoveryReviewDecision> | null = null;
  let issue = "";
  let needsChoice = false;
  if (step && projection && decision) {
    try { preview = applyRecoveryReviewDecision(projection.state, step, decision); }
    catch (problem) {
      needsChoice = problem instanceof DomainError && ["REVIEW_CHOICES_REQUIRED", "REVIEW_CONTEXT_REQUIRED"].includes(problem.code);
      issue = problem instanceof Error ? problem.message : "This change could not be reapplied.";
    }
  }
  const total = replica.outbox.filter((entry) => !recoveryCommandWasApplied(server, entry.envelope.id)).length;
  const resetStep = () => { setChoices({}); setAcceptContext(false); setLimit(FIELD_PAGE_SIZE); };
  const advance = (next: RecoveryReviewDecision) => { setDecisions([...decisions, next]); resetStep(); };
  useEffect(() => { heading.current?.focus(); }, [step?.entry.envelope.id]);
  const conflictFields = step?.fields.filter((field) => field.conflict) ?? [];
  const readyFields = step?.fields.filter((field) => !field.conflict) ?? [];
  const shownFields = step?.kind === "fields" ? conflictFields : step?.fields ?? [];
  return <ModalDialog busy={busy} mobileSheet="full" onClose={onClose} open title="Review queued changes">
    <div className={styles.review} aria-busy={busy}>
      <div className={styles.progress}><span><ShieldCheck aria-hidden="true" />Copy saved</span><span>{decisions.length} of {total} reviewed</span><button aria-label="Cancel review" disabled={busy} onClick={onClose} type="button"><X aria-hidden="true" />Cancel</button></div>
      <progress aria-label="Queued changes reviewed" max={Math.max(total, 1)} value={step ? decisions.length : total || 1} />
      {(error || reviewed.error) && <div className={styles.problem} role="alert"><TriangleAlert aria-hidden="true" /><span>{error || reviewed.error}</span></div>}
      {step && projection && <>
        <header className={styles.stepHeading}>
          <span className={styles.badge} data-conflict={conflictFields.length > 0}><Info aria-hidden="true" />{step.kind === "command" ? "Review whole change" : conflictFields.length ? `${conflictFields.length} ${conflictFields.length === 1 ? "field needs" : "fields need"} a choice` : "Ready to reapply"}</span>
          <h3 ref={heading} tabIndex={-1}>{recoveryCommandLabel(replica, step.entry)}</h3>
          <p>Online values include choices you already reviewed.</p>
        </header>
        <div className={styles.fields}>
          {shownFields.slice(0, limit).map((field) => step.kind === "fields"
            ? <FieldCard key={field.key} field={field} state={projection.state} choice={choices[field.key]} onChoice={(choice) => setChoices({ ...choices, [field.key]: choice })} />
            : <div className={styles.operationField} key={field.key}><strong>{fieldLabel(field.path)}</strong><div><small><Cloud aria-hidden="true" />Online</small><Value value={field.server} field={field} state={projection.state} /></div><div><small><Smartphone aria-hidden="true" />Device intent</small><Value value={field.device} field={field} state={replica.state} /></div></div>)}
          {shownFields.length > limit && <button onClick={() => setLimit(limit + FIELD_PAGE_SIZE)} type="button">Show more fields ({shownFields.length - limit})</button>}
        </div>
        {step.kind === "fields" && readyFields.length > 0 && <details className={styles.readyFields} open={conflictFields.length === 0}>
          <summary><CheckCircle2 aria-hidden="true" />{readyFields.length} {readyFields.length === 1 ? "field ready" : "fields ready"}</summary>
          {readyFields.slice(0, limit).map((field) => <label key={field.key}><input aria-label={`Reapply ${fieldLabel(field.path)} for ${subjectLabel(field, projection.state)}`} checked={choices[field.key] !== "server"} name={`ready-${field.key}`} onChange={(event) => setChoices({ ...choices, [field.key]: event.target.checked ? "device" : "server" })} type="checkbox" value={field.key} /><span><strong>{subjectLabel(field, projection.state)} · {fieldLabel(field.path)}</strong><span className={styles.readyValues}><Value compact value={field.server} field={field} state={projection.state} /><ArrowRight aria-label="changes to" /><Value compact value={field.device} field={field} state={projection.state} /></span></span></label>)}
          {readyFields.length > limit && <button onClick={() => setLimit(limit + FIELD_PAGE_SIZE)} type="button">Show more ready fields ({readyFields.length - limit})</button>}
        </details>}
        {step.context.length > 0 && <div className={styles.context}>
          <details><summary><TriangleAlert aria-hidden="true" />Online context changed</summary>{step.context.slice(0, limit).map((field) => <div key={field.key}><strong>{fieldLabel(field.path)}</strong><div className={styles.contextValues}><div><small>Expected</small><Value value={field.before} field={field} state={replica.state} /></div><div><small>Online</small><Value value={field.server} field={field} state={projection.state} /></div></div></div>)}{step.context.length > limit && <button onClick={() => setLimit(limit + FIELD_PAGE_SIZE)} type="button">Show more context ({step.context.length - limit})</button>}</details>
          <label><input checked={acceptContext} name="acceptRecoveryContext" onChange={(event) => setAcceptContext(event.target.checked)} type="checkbox" />I reviewed this context and want to reapply the change.</label>
        </div>}
        <details className={styles.diagnostics}><summary>Change details</summary><p>{new Date(step.entry.envelope.timestamp).toLocaleString()}</p>{step.entry.error && <p>{step.entry.error}</p>}<small>{step.entry.envelope.command.type} · {step.entry.envelope.id}</small></details>
        {issue && <p className={needsChoice ? styles.hint : styles.problem} role={needsChoice ? "status" : "alert"}>{needsChoice ? <Info aria-hidden="true" /> : <TriangleAlert aria-hidden="true" />}{issue}{!needsChoice && " Skip this change only if you want to keep the online result, or cancel to keep the device queue."}</p>}
        {preview && !preview.entry && <p className={styles.hint}><Cloud aria-hidden="true" />Your choices keep this change as it is online.</p>}
        <footer className={styles.footer}>
          <button disabled={busy || decisions.length === 0} onClick={() => { setDecisions(decisions.slice(0, -1)); resetStep(); }} type="button"><ArrowLeft aria-hidden="true" />Back</button>
          <button disabled={busy} onClick={() => advance({ commandId: step.entry.envelope.id, action: "skip" })} type="button"><SkipForward aria-hidden="true" />Skip change</button>
          <button className="primary" disabled={busy || !preview || !decision} onClick={() => { if (decision && preview) advance(decision); }} type="button">Continue<ArrowRight aria-hidden="true" /></button>
        </footer>
      </>}
      {projection && !step && <>
        <header className={styles.stepHeading}><CheckCircle2 className={styles.successIcon} aria-hidden="true" /><h3 ref={heading} tabIndex={-1}>Ready to save your choices</h3><p>The device will use this reviewed result. Reapplied changes will wait for normal online backup.</p></header>
        <div className={styles.totals}><span><Smartphone aria-hidden="true" /><b>{projection.outbox.length}</b>to reapply</span><span><Cloud aria-hidden="true" /><b>{projection.skippedCommandIds.length}</b>kept online</span><span><Check aria-hidden="true" /><b>{projection.acceptedCommandIds.length}</b>already backed up</span></div>
        <details className={styles.diagnostics}><summary>Review included and skipped changes</summary>{replica.outbox.slice(0, limit).map((entry) => <p key={entry.envelope.id}><strong>{recoveryCommandLabel(replica, entry)}</strong><small>{projection.acceptedCommandIds.includes(entry.envelope.id) ? "Already backed up" : projection.skippedCommandIds.includes(entry.envelope.id) ? "Keep online; do not reapply" : "Reapply reviewed fields"}</small></p>)}{replica.outbox.length > limit && <button onClick={() => setLimit(limit + FIELD_PAGE_SIZE)} type="button">Show more reviewed changes ({replica.outbox.length - limit})</button>}</details>
        <footer className={styles.footer}><button disabled={busy || decisions.length === 0} onClick={() => { setDecisions(decisions.slice(0, -1)); resetStep(); }} type="button"><ArrowLeft aria-hidden="true" />Back</button><button disabled={busy} onClick={onClose} type="button">Cancel</button><button className="primary" disabled={busy} onClick={() => void onSave(decisions)} type="button"><ShieldCheck aria-hidden="true" />{busy ? "Checking copies..." : "Save reviewed choices"}</button></footer>
      </>}
    </div>
  </ModalDialog>;
}
