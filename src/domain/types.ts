export const SCHEMA_VERSION = 1;

export type JsonPrimitive = boolean | number | string | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

export type CaptureStatus = "counted" | "in_progress" | "known_empty" | "uncounted";
export type Frequency = "daily" | "weekly" | "monthly" | "rarely";
export type LocationKind =
    | "area"
    | "bin"
    | "box"
    | "cabinet"
    | "container"
    | "drawer"
    | "room"
    | "shelf"
    | "zone";
export type ThemePreference = "dark" | "light" | "system";

export interface Dimensions {
    depth: number;
    height: number;
    unit: "cm" | "in";
    width: number;
}

export interface LocationConditions {
    dark: boolean;
    dry: boolean;
    foodSafe: boolean;
    humidity: "dry" | "normal" | "humid";
    temperature: "cold" | "cool" | "normal" | "warm";
}

export interface ItemConstraints {
    avoidHumidity: boolean;
    avoidWarmth: boolean;
    foodOnly: boolean;
    keepTogether: string | null;
    requiredTags: string[];
}

export interface Workspace {
    createdAt: string;
    id: string;
    name: string;
    revision: number;
    updatedAt: string;
}

export interface Location {
    archivedAt: string | null;
    captureStatus: CaptureStatus;
    code: string;
    conditions: LocationConditions;
    createdAt: string;
    description: string;
    dimensions: Dimensions | null;
    id: string;
    kind: LocationKind;
    name: string;
    order: number;
    parentId: string | null;
    tags: string[];
    updatedAt: string;
}

export interface ItemRecord {
    archivedAt: string | null;
    category: string;
    constraints: ItemConstraints;
    createdAt: string;
    dimensions: Dimensions | null;
    frequency: Frequency;
    id: string;
    locationId: string;
    name: string;
    notes: string;
    order: number;
    quantity: number;
    tags: string[];
    unit: string;
    updatedAt: string;
    version: number;
}

export interface PlanWeights {
    accessibility: number;
    capacity: number;
    grouping: number;
    moveCost: number;
    suitability: number;
}

export interface PlanStep {
    completedAt: string | null;
    destinationId: string;
    explanation: string[];
    id: string;
    itemId: string | null;
    locationId: string | null;
    quantity: number | null;
    score: number;
    sourceId: string;
    type: "item" | "location";
}

export interface MovePlan {
    createdAt: string;
    id: string;
    name: string;
    status: "active" | "completed" | "discarded";
    steps: PlanStep[];
    weights: PlanWeights;
}

export type PatchTarget = "item" | "location" | "plan" | "workspace";

export interface FieldPatch {
    after: JsonValue | undefined;
    before: JsonValue | undefined;
    id: string;
    path: string;
    target: PatchTarget;
}

export interface FieldExpectation {
    id: string;
    path: string;
    target: PatchTarget;
    value: JsonValue;
}

export interface ActivityRecord {
    actorId: string;
    commandId: string;
    id: string;
    label: string;
    patches: FieldPatch[];
    status: "applied" | "undone";
    subjectIds: string[];
    timestamp: string;
    undoneAt: string | null;
}

export interface AuditEvent {
    actorId: string;
    id: string;
    label: string;
    targetActivityIds: string[];
    timestamp: string;
    type: "batch_redo" | "batch_undo" | "reapply" | "undo";
}

export interface WorkspaceState {
    activities: ActivityRecord[];
    audit: AuditEvent[];
    items: ItemRecord[];
    locations: Location[];
    plans: MovePlan[];
    schemaVersion: typeof SCHEMA_VERSION;
    workspace: Workspace;
}

export interface CommandEnvelope<T extends Command = Command> {
    actorId: string;
    baseRevision: number;
    command: T;
    deviceId: string;
    id: string;
    expectations: FieldExpectation[];
    timestamp: string;
    workspaceId: string;
}

export type Command =
    | { type: "workspace.rename"; name: string }
    | { type: "location.create"; location: Location }
    | { type: "location.update"; id: string; changes: Partial<Omit<Location, "id" | "createdAt">> }
    | { type: "location.move"; id: string; parentId: string | null; order?: number }
    | { type: "location.reorder"; id: string; order: number }
    | { type: "location.archive"; id: string; archived: boolean }
    | {
          type: "location.delete";
          id: string;
          descendantIds: string[];
          itemIds: string[];
      }
    | { type: "capture.empty"; id: string; itemIds: string[] }
    | { type: "capture.status"; id: string; status: CaptureStatus }
    | { type: "item.create"; item: ItemRecord }
    | { type: "item.update"; id: string; changes: Partial<Omit<ItemRecord, "id" | "createdAt">> }
    | { type: "item.reorder"; id: string; order: number }
    | { type: "item.delete"; id: string }
    | {
          type: "item.move";
          destinationId: string;
          id: string;
          quantity: number;
      }
    | {
          type: "item.bulkMove";
          destinationId: string;
          itemIds: string[];
      }
    | { type: "plan.create"; plan: MovePlan }
    | { type: "plan.step.complete"; planId: string; stepId: string }
    | { type: "plan.status"; planId: string; status: MovePlan["status"] }
    | { type: "history.undo"; activityId: string }
    | { type: "history.reapply"; activityId: string }
    | { type: "history.batchUndo"; count: number }
    | { type: "history.batchRedo"; count: number };

export interface CommandResult {
    activity: ActivityRecord | null;
    audit: AuditEvent | null;
    state: WorkspaceState;
}

export interface ValidationIssue {
    code: string;
    message: string;
    path: string;
    severity: "error" | "warning";
}

export interface ImportPreview {
    incoming: { items: number; locations: number; plans: number };
    issues: ValidationIssue[];
    replacing: { items: number; locations: number; plans: number };
    valid: boolean;
}

export interface SyncConflict {
    commandId: string;
    current: JsonValue | undefined;
    expected: JsonValue | undefined;
    field: string;
    id: string;
    message: string;
    target: PatchTarget;
}

export interface SyncReceipt {
    commandId: string;
    revision: number;
    status: "applied" | "duplicate" | "rejected";
    conflicts?: SyncConflict[];
    message?: string;
}

export interface SyncResponse {
    receipts: SyncReceipt[];
    snapshot: WorkspaceState;
}
