import { applyCommand, readPatchValue } from "../domain/commands";
import { DomainError } from "../domain/errors";
import { createEnvelope } from "../domain/factories";
import type {
  Command, CommandAuthorizationBasis, FieldExpectation, FieldPatch,
  JsonValue, PatchTarget, WorkspaceState,
} from "../domain/types";
import type { LocalReplica, OutboxEntry } from "./local-replica";

export type RecoveryFieldChoice = "device" | "server";

export interface RecoveryReviewField {
  key: string;
  target: PatchTarget;
  id: string;
  path: string;
  before: JsonValue | undefined;
  device: JsonValue | undefined;
  server: JsonValue | undefined;
  conflict: boolean;
}

export interface RecoveryReviewDecision {
  commandId: string;
  action: "apply" | "skip";
  choices?: Record<string, RecoveryFieldChoice>;
  acceptContext?: boolean;
}

export interface RecoveryReviewStep {
  entry: OutboxEntry;
  index: number;
  kind: "fields" | "command";
  fields: RecoveryReviewField[];
  context: RecoveryReviewField[];
}

export interface RecoveryReviewOptions {
  accountId?: string;
  actorId?: string;
  authorization?: CommandAuthorizationBasis;
  createCommandId?: () => string;
  timestamp?: string;
}

export interface RecoveryReviewProjection {
  acceptedCommandIds: string[];
  skippedCommandIds: string[];
  next: RecoveryReviewStep | null;
  outbox: OutboxEntry[];
  state: WorkspaceState;
}

const LEAF_GROUPS = new Set(["constraints", "conditions"]);
const STRUCTURAL_LOCATION_FIELDS = new Set(["parentId", "order"]);
const UNSAFE_KEYS = new Set(["__proto__", "constructor", "prototype"]);

function record(value: unknown): value is Record<string, JsonValue> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function sameValue(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (Array.isArray(left)) {
    return Array.isArray(right) && left.length === right.length &&
      left.every((value, index) => sameValue(value, right[index]));
  }
  if (!record(left) || !record(right)) return false;
  const keys = Object.keys(left);
  return keys.length === Object.keys(right).length && keys.every((key) =>
    Object.hasOwn(right, key) && sameValue(left[key], right[key]));
}

function nestedValue(value: JsonValue | undefined, path: string): JsonValue | undefined {
  if (!path) return value;
  let current = value;
  for (const key of path.split(".")) {
    if (UNSAFE_KEYS.has(key)) throw new DomainError("INVALID_PATCH", "A reviewed field has an unsafe path");
    current = record(current) && Object.hasOwn(current, key) ? current[key] : undefined;
  }
  return current;
}

export function recoveryFieldKey(target: PatchTarget, id: string, path: string): string {
  return JSON.stringify([target, id, path]);
}

export function recoveryCommandWasApplied(state: WorkspaceState, commandId: string): boolean {
  return state.commandReceipts?.includes(commandId) ||
    state.activities.some((activity) => activity.commandId === commandId) ||
    state.audit.some((event) => event.id === `audit_${commandId}`);
}

function expectedValue(expectations: FieldExpectation[], target: PatchTarget, id: string, path: string) {
  const expectation = expectations.find((candidate) => candidate.target === target && candidate.id === id && candidate.path === path) ??
    expectations.find((candidate) => candidate.target === target && candidate.id === id &&
      (!candidate.path || path.startsWith(`${candidate.path}.`)));
  return {
    known: expectation !== undefined,
    value: expectation ? nestedValue(expectation.value, expectation.path ? path.slice(expectation.path.length).replace(/^\./u, "") : path) : undefined,
  };
}

function editablePatches(entry: OutboxEntry): Pick<FieldPatch, "target" | "id" | "path" | "after">[] | null {
  const command = entry.envelope.command;
  if (command.type === "workspace.rename") {
    return [{ target: "workspace", id: entry.envelope.workspaceId, path: "name", after: command.name }];
  }
  const changesFor = (target: "item" | "location", id: string, changes: object) =>
    Object.entries(changes).flatMap(([path, value]) => {
      if (UNSAFE_KEYS.has(path) || path.includes(".")) {
        throw new DomainError("INVALID_CHANGES", "The queued change contains an unsupported field");
      }
      return LEAF_GROUPS.has(path) && record(value)
        ? Object.entries(value).map(([key, after]) => {
            if (UNSAFE_KEYS.has(key) || key.includes(".")) throw new DomainError("INVALID_CHANGES", "The queued change contains an unsupported field");
            return { target, id, path: `${path}.${key}`, after };
          })
        : [{ target, id, path, after: value as JsonValue }];
    });
  if (command.type === "item.update") return changesFor("item", command.id, command.changes);
  if (command.type === "location.update" && !Object.keys(command.changes).some((key) => STRUCTURAL_LOCATION_FIELDS.has(key))) {
    return changesFor("location", command.id, command.changes);
  }
  if (command.type === "item.bulkUpdate") {
    return command.updates.flatMap(({ id, changes }) => changesFor("item", id, changes));
  }
  return null;
}

function reviewStep(replica: LocalReplica, state: WorkspaceState, entry: OutboxEntry, index: number): RecoveryReviewStep {
  const patches = editablePatches(entry);
  const fields: RecoveryReviewField[] = [];
  for (const patch of patches ?? replica.state.activities.find((activity) => activity.commandId === entry.envelope.id)?.patches ?? []) {
    const expected = patches
      ? expectedValue(entry.envelope.expectations, patch.target, patch.id, patch.path)
      : { known: true, value: (patch as FieldPatch).before };
    if (patches && expected.known && sameValue(expected.value, patch.after)) continue;
    const server = readPatchValue(state, patch.target, patch.id, patch.path);
    fields.push({
      ...patch,
      key: recoveryFieldKey(patch.target, patch.id, patch.path),
      before: expected.value,
      device: patch.after,
      server,
      conflict: !sameValue(server, patch.after) && (!expected.known || !sameValue(server, expected.value)),
    });
  }
  const context = entry.envelope.expectations.flatMap((expectation) => {
    const covered = patches?.some((patch) => patch.target === expectation.target && patch.id === expectation.id &&
      (patch.path === expectation.path || patch.path.startsWith(`${expectation.path}.`)));
    const server = readPatchValue(state, expectation.target, expectation.id, expectation.path);
    if (covered || sameValue(server, expectation.value)) return [];
    return [{
      key: recoveryFieldKey(expectation.target, expectation.id, expectation.path),
      target: expectation.target, id: expectation.id, path: expectation.path,
      before: expectation.value, device: expectation.value, server, conflict: true,
    }];
  });
  return { entry, index, kind: patches === null ? "command" : "fields", fields, context };
}

function chosenCommand(state: WorkspaceState, step: RecoveryReviewStep, decision: RecoveryReviewDecision): Command | null {
  const original = step.entry.envelope.command;
  if (original.type.startsWith("history.")) {
    throw new DomainError("REVIEW_HISTORY", "Review this history action in Activity. Keep the recovery bundle; this action cannot safely be retargeted to newer history.");
  }
  const choices = decision.choices ?? {};
  if (Object.entries(choices).some(([key, value]) =>
    !step.fields.some((field) => field.key === key) || !["device", "server"].includes(value))) {
    throw new DomainError("REVIEW_CHOICES", "The field choices no longer match this change. Review it again.");
  }
  if (step.kind === "fields" && step.fields.some((field) => field.conflict && !choices[field.key])) {
    throw new DomainError("REVIEW_CHOICES_REQUIRED", "Choose a value for each conflicting field.");
  }
  const selected = step.fields.filter((field) => choices[field.key] !== "server" && !sameValue(field.device, field.server));
  if (step.kind === "fields" && selected.length === 0) return null;
  if (step.context.length && !decision.acceptContext) {
    throw new DomainError("REVIEW_CONTEXT_REQUIRED", "Confirm the changed online context before reapplying this change.");
  }
  if (step.kind === "command") return structuredClone(original);

  const byRecord = new Map<string, Record<string, JsonValue>>();
  for (const field of selected) {
    const changes = byRecord.get(field.id) ?? {};
    const [group, leaf] = field.path.split(".");
    if (leaf) {
      if (!LEAF_GROUPS.has(group) || UNSAFE_KEYS.has(leaf)) {
        throw new DomainError("INVALID_CHANGES", "A reviewed field cannot be changed safely");
      }
      const currentGroup = readPatchValue(state, field.target, field.id, group);
      const merged = changes[group] ?? (record(currentGroup) ? structuredClone(currentGroup) : {});
      if (!record(merged) || field.device === undefined) throw new DomainError("INVALID_CHANGES", "The reviewed field is unavailable");
      merged[leaf] = structuredClone(field.device);
      changes[group] = merged;
    } else {
      if (UNSAFE_KEYS.has(group) || field.device === undefined) throw new DomainError("INVALID_CHANGES", "The reviewed field is unavailable");
      changes[group] = structuredClone(field.device);
    }
    byRecord.set(field.id, changes);
  }
  if (original.type === "workspace.rename") return { type: "workspace.rename", name: String(byRecord.get(state.workspace.id)?.name) };
  if (original.type === "item.update" || original.type === "location.update") {
    return { ...original, changes: byRecord.get(original.id)! } as Command;
  }
  if (original.type === "item.bulkUpdate") {
    const updates = original.updates.filter(({ id }) => byRecord.has(id)).map(({ id }) => {
      const changes = byRecord.get(id)!;
      if (changes.constraints && record(changes.constraints)) {
        const selectedConstraints = selected.filter((field) => field.id === id && field.path.startsWith("constraints."));
        changes.constraints = Object.fromEntries(selectedConstraints.map((field) => [field.path.slice("constraints.".length), field.device!])) as JsonValue;
      }
      return { id, changes };
    });
    return { ...original, updates } as Command;
  }
  throw new DomainError("REVIEW_COMMAND", "This change needs a new review");
}

export function applyRecoveryReviewDecision(
  state: WorkspaceState,
  step: RecoveryReviewStep,
  decision: RecoveryReviewDecision,
  options: RecoveryReviewOptions = {},
): { state: WorkspaceState; entry: OutboxEntry | null } {
  if (decision.commandId !== step.entry.envelope.id || !["apply", "skip"].includes(decision.action)) {
    throw new DomainError("REVIEW_ORDER", "Review queued changes in their original order.");
  }
  if (decision.action === "skip") return { state, entry: null };
  const command = chosenCommand(state, step, decision);
  if (!command) return { state, entry: null };
  let id = options.createCommandId?.() ?? `review_${step.entry.envelope.id}`;
  if (!options.createCommandId) {
    while (recoveryCommandWasApplied(state, id)) id = `review_${id}`;
  }
  if (recoveryCommandWasApplied(state, id)) throw new DomainError("REVIEW_ID", "The new change identifier is already in use. Try the review again.");
  const envelope = createEnvelope(state, command, {
    id,
    timestamp: options.timestamp ?? step.entry.envelope.timestamp,
    actorId: options.actorId ?? step.entry.envelope.actorId,
    deviceId: step.entry.envelope.deviceId,
    authorization: options.authorization,
  });
  try {
    const next = applyCommand(state, envelope).state;
    return { state: next, entry: { accountId: options.accountId ?? step.entry.accountId, envelope, status: "pending" } };
  } catch (error) {
    if (error instanceof DomainError && error.code === "NO_CHANGES") return { state, entry: null };
    throw error;
  }
}

export function projectRecoveryReview(
  replica: LocalReplica,
  server: WorkspaceState,
  decisions: readonly RecoveryReviewDecision[],
  options: RecoveryReviewOptions = {},
): RecoveryReviewProjection {
  if (replica.state.workspace.id !== server.workspace.id) {
    throw new DomainError("WRONG_WORKSPACE", "The reviewed copies belong to different workspaces");
  }
  const result: RecoveryReviewProjection = {
    acceptedCommandIds: [], skippedCommandIds: [], next: null,
    outbox: [], state: structuredClone(server),
  };
  let decisionIndex = 0;
  const ids = new Set<string>();
  for (const [index, entry] of replica.outbox.entries()) {
    if (entry.envelope.workspaceId !== server.workspace.id || ids.has(entry.envelope.id)) {
      throw new DomainError("REVIEW_QUEUE", "The device queue has inconsistent identifiers. Keep its recovery bundle.");
    }
    ids.add(entry.envelope.id);
    if (recoveryCommandWasApplied(server, entry.envelope.id)) {
      result.acceptedCommandIds.push(entry.envelope.id);
      continue;
    }
    const step = reviewStep(replica, result.state, entry, index);
    const decision = decisions[decisionIndex];
    if (!decision) { result.next = step; return result; }
    const applied = applyRecoveryReviewDecision(result.state, step, decision, options);
    result.state = applied.state;
    if (applied.entry) result.outbox.push(applied.entry);
    else result.skippedCommandIds.push(entry.envelope.id);
    decisionIndex += 1;
  }
  if (decisionIndex !== decisions.length) {
    throw new DomainError("REVIEW_ORDER", "The queue changed after review. Review its original order again.");
  }
  return result;
}
