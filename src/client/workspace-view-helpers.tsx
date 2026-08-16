"use client";

import {
  useCallback,
  useSyncExternalStore,
} from "react";
import { suggestLocationCode } from "../domain/location-code";
import {
  workspacePath,
  type WorkspaceView,
} from "../domain/app-url";
import type {
  CaptureStatus,
  Command,
  Dimensions,
  Frequency,
  ItemRecord,
  Location,
  LocationKind,
  WorkspaceState,
} from "../domain/types";
import type {
  Commit,
  FeedbackDetail,
} from "./workspace-view-types";

export const COMPLETE_CAPTURE_STATUSES = new Set<CaptureStatus>([
  "counted",
  "known_empty",
]);
export const RECERTIFIED_CAPTURE_STATUS: CaptureStatus = "counted";
export const STACKED_TOUCH_LAYOUT_QUERY =
  "(max-width: 760px), (max-height: 520px) and (pointer: coarse) and (min-width: 761px)";
export const SPACES_MIN_SIDE_BY_SIDE_WIDTH = 850;
export const DEMO_ENTRY_FOCUS_DELAY_MS = 100;
export const ITEM_EDITOR_FOCUS_RESTORE_FRAMES = 3;
export const SEARCH_BLOCKED_EVENT = "stowplan:search-blocked";
export const LOCATION_POSITION = Object.freeze({
  AFTER_PREFIX: "after:",
  FIRST: "first",
});
export const LOCATION_KINDS: readonly LocationKind[] = Object.freeze([
  "room",
  "zone",
  "area",
  "cabinet",
  "drawer",
  "shelf",
  "box",
  "bin",
  "container",
]);
export const ITEM_FREQUENCIES: readonly Frequency[] = Object.freeze([
  "daily",
  "weekly",
  "monthly",
  "rarely",
]);

const DISMISS_FEEDBACK_EVENT = "stowplan:feedback-dismiss";
const FEEDBACK_EVENT = "stowplan:feedback";
const pendingForms = new WeakSet<HTMLFormElement>();

export function useMediaQuery(query: string): boolean {
  const subscribe = useCallback((notify: () => void) => {
    const media = matchMedia(query);
    media.addEventListener("change", notify);
    return () => media.removeEventListener("change", notify);
  }, [query]);
  const snapshot = useCallback(() => matchMedia(query).matches, [query]);
  return useSyncExternalStore(subscribe, snapshot, () => false);
}

export function sortItems(items: ItemRecord[]): ItemRecord[] {
  return [...items].sort((left, right) =>
    left.order - right.order || left.createdAt.localeCompare(right.createdAt)
  );
}

export function sortLocations(locations: Location[]): Location[] {
  return [...locations].sort((left, right) =>
    left.order - right.order || left.name.localeCompare(right.name)
  );
}

export function nextOrder<T extends { order: number }>(records: T[]): number {
  return records.reduce(
    (maximum, record) => Math.max(maximum, record.order),
    -1,
  ) + 1;
}

export function movedOrder<T extends { id: string; order: number }>(
  records: T[],
  id: string,
  direction: -1 | 1,
): number | null {
  const sorted = [...records].sort((left, right) =>
    left.order - right.order || left.id.localeCompare(right.id)
  );
  const index = sorted.findIndex((record) => record.id === id);
  const destination = index + direction;
  if (index < 0 || destination < 0 || destination >= sorted.length) return null;
  if (direction < 0) {
    const target = sorted[destination];
    const before = sorted[destination - 1];
    return before ? (before.order + target.order) / 2 : target.order - 1;
  }
  const target = sorted[destination];
  const after = sorted[destination + 1];
  return after ? (target.order + after.order) / 2 : target.order + 1;
}

export function orderBefore<T extends { id: string; order: number }>(
  records: T[],
  sourceId: string,
  targetId: string,
): number | null {
  if (sourceId === targetId) return null;
  const sorted = [...records]
    .filter((record) => record.id !== sourceId)
    .sort((left, right) =>
      left.order - right.order || left.id.localeCompare(right.id)
    );
  const index = sorted.findIndex((record) => record.id === targetId);
  if (index < 0) return null;
  const target = sorted[index];
  const before = sorted[index - 1];
  return before ? (before.order + target.order) / 2 : target.order - 1;
}

export function orderAfter<T extends { id: string; order: number }>(
  records: T[],
  sourceId: string,
  targetId: string,
): number | null {
  if (sourceId === targetId) return null;
  const sorted = [...records]
    .filter((record) => record.id !== sourceId)
    .sort((left, right) =>
      left.order - right.order || left.id.localeCompare(right.id)
    );
  const index = sorted.findIndex((record) => record.id === targetId);
  if (index < 0) return null;
  const target = sorted[index];
  const after = sorted[index + 1];
  return after ? (target.order + after.order) / 2 : target.order + 1;
}

export function splitList(value: FormDataEntryValue | null): string[] {
  return String(value ?? "").split(",").map((part) => part.trim()).filter(
    Boolean,
  );
}

export type UncontrolledFormValue = boolean | string;
export type UncontrolledFormValues = Readonly<
  Record<string, UncontrolledFormValue>
>;

export function reconcileUntouchedFormControls(
  form: HTMLFormElement | null,
  previous: UncontrolledFormValues,
  next: UncontrolledFormValues,
): void {
  if (!form) return;
  for (const [name, nextValue] of Object.entries(next)) {
    const control = form.elements.namedItem(name);
    if (
      !(control instanceof HTMLInputElement) &&
      !(control instanceof HTMLSelectElement) &&
      !(control instanceof HTMLTextAreaElement)
    ) {
      continue;
    }
    const previousValue = previous[name];
    if (
      control instanceof HTMLInputElement &&
      (control.type === "checkbox" || control.type === "radio") &&
      typeof previousValue === "boolean" &&
      typeof nextValue === "boolean"
    ) {
      if (control.checked === previousValue) control.checked = nextValue;
      continue;
    }
    if (
      typeof previousValue === "string" &&
      typeof nextValue === "string" &&
      control.value === previousValue
    ) {
      control.value = nextValue;
    }
  }
}

export function optionalDimensions(data: FormData): Dimensions | null {
  const raw = ["width", "height", "depth"].map((field) =>
    String(data.get(field) ?? "").trim()
  );
  if (raw.every((value) => value === "")) return null;
  const [width, height, depth] = raw.map(Number);
  if (
    raw.some((value) => value === "") ||
    ![width, height, depth].every((value) =>
      Number.isFinite(value) && value > 0
    )
  ) {
    throw new Error(
      "Enter positive width, height, and depth values, or clear all three dimensions.",
    );
  }
  const unit = String(data.get("dimensionUnit"));
  if (unit !== "cm" && unit !== "in") {
    throw new Error("Choose a valid dimension unit.");
  }
  return { depth, height, unit, width };
}

export function locationFormValues(
  location: Location,
): UncontrolledFormValues {
  return {
    code: location.code,
    dark: location.conditions.dark,
    depth: String(location.dimensions?.depth ?? ""),
    description: location.description,
    dimensionUnit: location.dimensions?.unit ?? "in",
    dry: location.conditions.dry,
    foodSafe: location.conditions.foodSafe,
    height: String(location.dimensions?.height ?? ""),
    humidity: location.conditions.humidity,
    kind: location.kind,
    name: location.name,
    parentId: location.parentId ?? "",
    tags: location.tags.join(", "),
    temperature: location.conditions.temperature,
    width: String(location.dimensions?.width ?? ""),
  };
}

export function itemFormValues(item: ItemRecord): UncontrolledFormValues {
  return {
    avoidHumidity: item.constraints.avoidHumidity,
    avoidWarmth: item.constraints.avoidWarmth,
    category: item.category,
    depth: String(item.dimensions?.depth ?? ""),
    description: item.description,
    dimensionUnit: item.dimensions?.unit ?? "in",
    foodOnly: item.constraints.foodOnly,
    frequency: item.frequency,
    height: String(item.dimensions?.height ?? ""),
    keepTogether: item.constraints.keepTogether ?? "",
    moveQuantity: String(item.quantity),
    name: item.name,
    quantity: String(item.quantity),
    requiredTags: item.constraints.requiredTags.join(", "),
    tags: item.tags.join(", "),
    unit: item.unit,
    width: String(item.dimensions?.width ?? ""),
  };
}

export function formatTimestamp(value: string | null): string {
  if (!value) return "Never";
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? "Unknown"
    : date.toLocaleString([], {
        dateStyle: "medium",
        timeStyle: "short",
      });
}

export function countLabel(
  count: number,
  singular: string,
  plural = `${singular}s`,
): string {
  return `${count} ${count === 1 ? singular : plural}`;
}

export function responseError(value: unknown, fallback: string): string {
  return value &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      "error" in value &&
      typeof value.error === "string"
    ? value.error
    : fallback;
}

export async function perform(
  commit: Commit,
  command: Command,
  after?: () => void,
): Promise<boolean> {
  try {
    await commit(command);
    after?.();
    return true;
  } catch (error) {
    showFeedback(
      error instanceof Error
        ? error.message
        : "That change could not be applied",
      "error",
    );
    return false;
  }
}

export function showFeedback(
  message: string,
  tone: FeedbackDetail["tone"] = "error",
): void {
  dispatchEvent(new CustomEvent<FeedbackDetail>(FEEDBACK_EVENT, {
    detail: { message, tone },
  }));
}

export function dismissFeedback(): void {
  dispatchEvent(new Event(DISMISS_FEEDBACK_EVENT));
}

export function followAppLink(
  event: React.MouseEvent<HTMLAnchorElement>,
  navigate: () => void,
): void {
  if (
    event.button !== 0 ||
    event.metaKey ||
    event.ctrlKey ||
    event.shiftKey ||
    event.altKey
  ) return;
  event.preventDefault();
  navigate();
}

export function stateWorkspacePath(
  state: WorkspaceState,
  {
    itemId = null,
    locationId = null,
    view,
  }: {
    itemId?: string | null;
    locationId?: string | null;
    view: WorkspaceView;
  },
): string {
  const item = itemId
    ? state.items.find((candidate) => candidate.id === itemId)
    : undefined;
  const location = locationId
    ? state.locations.find((candidate) => candidate.id === locationId)
    : undefined;
  return workspacePath({
    itemId,
    itemLabel: item?.name,
    locationId,
    locationLabel: location
      ? `${location.code} ${location.name}`
      : undefined,
    view,
    workspaceId: state.workspace.id,
    workspaceLabel: state.workspace.name,
  });
}

export function submitForm(
  event: React.FormEvent<HTMLFormElement>,
  action: (data: FormData) => Promise<boolean>,
  resetOnSuccess = true,
  focusAfterSuccess?: string,
): void {
  event.preventDefault();
  const form = event.currentTarget;
  if (pendingForms.has(form)) return;
  const data = new FormData(form);
  const submitControls = [
    ...form.querySelectorAll<HTMLButtonElement | HTMLInputElement>(
      'button:not([type]), button[type="submit"], input[type="submit"]',
    ),
  ];
  const activeSubmitControl = submitControls.find(
    (control) => control === document.activeElement,
  ) ?? null;
  const disabledBefore = submitControls.map((control) => control.disabled);
  pendingForms.add(form);
  form.setAttribute("aria-busy", "true");
  submitControls.forEach((control) => {
    control.disabled = true;
  });
  void Promise.resolve().then(() => action(data)).then((saved) => {
    if (saved && resetOnSuccess && form.isConnected) {
      form.reset();
      if (focusAfterSuccess) {
        form.querySelector<HTMLElement>(focusAfterSuccess)?.focus();
      }
    }
  }).catch((error) => {
    showFeedback(
      error instanceof Error
        ? error.message
        : "That change could not be applied",
    );
  }).finally(() => {
    pendingForms.delete(form);
    if (!form.isConnected) return;
    form.removeAttribute("aria-busy");
    submitControls.forEach((control, index) => {
      control.disabled = disabledBefore[index] ?? false;
    });
    if (
      activeSubmitControl?.isConnected &&
      document.activeElement === document.body
    ) {
      activeSubmitControl.focus();
    }
  });
}

function updateSuggestedLocationCode(
  form: HTMLFormElement | null,
  existingCodes: readonly string[],
): void {
  if (!form) return;
  const code = form.elements.namedItem("code");
  const kind = form.elements.namedItem("kind");
  const name = form.elements.namedItem("name");
  if (
    !(code instanceof HTMLInputElement) ||
    !(kind instanceof HTMLSelectElement) ||
    !(name instanceof HTMLInputElement)
  ) {
    return;
  }
  if (code.dataset.userEdited === "true" && code.value.trim()) return;
  code.value = suggestLocationCode(
    name.value,
    kind.value as LocationKind,
    existingCodes,
  );
}

export function LocationCreateFields({
  defaultKind,
  existingCodes,
  kindLabel,
  namePlaceholder,
}: {
  defaultKind: LocationKind;
  existingCodes: readonly string[];
  kindLabel: string;
  namePlaceholder: string;
}) {
  const update = (
    event: React.FormEvent<HTMLInputElement | HTMLSelectElement>,
  ) => updateSuggestedLocationCode(event.currentTarget.form, existingCodes);
  return <>
    <div className="form-pair">
      <input
        required
        name="code"
        aria-label="Short ID"
        autoComplete="off"
        placeholder="Suggested Short ID"
        autoCapitalize="characters"
        onInput={(event) => {
          event.currentTarget.dataset.userEdited = "true";
        }}
      />
      <select
        name="kind"
        aria-label={kindLabel}
        defaultValue={defaultKind}
        onChange={update}
      >
        {LOCATION_KINDS.map((kind) => <option key={kind}>{kind}</option>)}
      </select>
    </div>
    <input
      required
      name="name"
      aria-label="Friendly name"
      autoComplete="off"
      placeholder={namePlaceholder}
      onInput={update}
    />
  </>;
}

export function Empty({ title, text }: { title: string; text: string }) {
  return <div className="empty"><b>□</b><h3>{title}</h3><p>{text}</p></div>;
}
