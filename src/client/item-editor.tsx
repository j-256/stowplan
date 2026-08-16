"use client";

import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import {
  CheckCircle2,
  RotateCcw,
  Trash2,
  X,
} from "lucide-react";
import {
  DEFAULT_ITEM_CATEGORY,
  DEFAULT_ITEM_FREQUENCY,
  DEFAULT_ITEM_UNIT,
} from "../domain/factories";
import type {
  Frequency,
  ItemRecord,
  WorkspaceState,
} from "../domain/types";
import { flattenLocationTree, locationPath } from "./workspace-hierarchy";
import {
  COMPLETE_CAPTURE_STATUSES,
  ITEM_EDITOR_FOCUS_RESTORE_FRAMES,
  ITEM_FREQUENCIES,
  itemFormValues,
  optionalDimensions,
  perform,
  RECERTIFIED_CAPTURE_STATUS,
  reconcileUntouchedFormControls,
  splitList,
  submitForm,
} from "./workspace-view-helpers";
import type {
  Commit,
  GuidanceFocus,
} from "./workspace-view-types";

export function ItemEditor({ item, state, commit, close, focus }: { item: ItemRecord; state: WorkspaceState; commit: Commit; close: () => void; focus?: GuidanceFocus }) {
  const [message, setMessage] = useState("");
  const [recertificationReady, setRecertificationReady] = useState(false);
  const [recertifying, setRecertifying] = useState(false);
  const [reopenedLocationId, setReopenedLocationId] = useState<string | null>(
    null,
  );
  const dialog = useRef<HTMLElement | null>(null);
  const itemForm = useRef<HTMLFormElement | null>(null);
  const moveForm = useRef<HTMLFormElement | null>(null);
  const formBaseline = useRef({
    id: item.id,
    values: itemFormValues(item),
  });
  const closeRef = useRef(close);
  const initialFocus = useRef(focus);
  const recertificationPrompt = useRef<HTMLElement | null>(null);
  const destinationOptions = flattenLocationTree(state.locations.filter((location) => !location.archivedAt && location.id !== item.locationId));
  const currentLocation = locationPath(state.locations, item.locationId);
  const currentLocationLabel = currentLocation.length ? currentLocation.map((location) => location.name).join(" › ") : "Unplaced";
  const currentLocationRecord = state.locations.find(
    (location) => location.id === item.locationId,
  );
  const captureComplete = Boolean(
    currentLocationRecord &&
    COMPLETE_CAPTURE_STATUSES.has(currentLocationRecord.captureStatus),
  );
  const reopenedLocation = reopenedLocationId
    ? state.locations.find((location) => location.id === reopenedLocationId)
    : null;
  const hasPlacementRules = item.constraints.foodOnly || item.constraints.avoidWarmth || item.constraints.avoidHumidity || Boolean(item.constraints.keepTogether) || item.constraints.requiredTags.length > 0;
  const hasOrganizationDetails =
    item.category !== DEFAULT_ITEM_CATEGORY ||
    item.frequency !== DEFAULT_ITEM_FREQUENCY ||
    item.tags.length > 0 ||
    item.unit !== DEFAULT_ITEM_UNIT;
  useLayoutEffect(() => {
    const previous = formBaseline.current;
    const next = itemFormValues(item);
    formBaseline.current = { id: item.id, values: next };
    if (previous.id !== item.id) {
      itemForm.current?.reset();
      moveForm.current?.reset();
      return;
    }
    reconcileUntouchedFormControls(itemForm.current, previous.values, next);
    reconcileUntouchedFormControls(moveForm.current, previous.values, next);
  }, [item]);
  useEffect(() => { closeRef.current = close; }, [close]);
  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const previousBodyOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const focusables = () => [...(dialog.current?.querySelectorAll<HTMLElement>("button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), summary, a[href]") ?? [])].filter((element) => element.getClientRects().length > 0);
    const keyboard = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        closeRef.current();
        return;
      }
      if (event.key !== "Tab") return;
      const available = focusables();
      if (!available.length) return;
      const currentIndex = available.indexOf(document.activeElement as HTMLElement);
      const nextIndex = event.shiftKey
        ? (currentIndex <= 0 ? available.length - 1 : currentIndex - 1)
        : (currentIndex < 0 || currentIndex === available.length - 1 ? 0 : currentIndex + 1);
      event.preventDefault();
      available[nextIndex]?.focus();
    };
    const frame = requestAnimationFrame(() => {
      if (captureComplete) {
        dialog.current
          ?.querySelector<HTMLButtonElement>("[data-reopen-capture]")
          ?.focus();
        return;
      }
      const requestedFocus = initialFocus.current;
      const coarsePointer = matchMedia("(pointer: coarse)").matches;
      if (requestedFocus === "item_details") {
        const section = dialog.current?.querySelector<HTMLDetailsElement>(
          '[data-guidance-section="item_details"]',
        );
        if (section) section.open = true;
        section?.scrollIntoView({ block: "start" });
        if (coarsePointer) section?.querySelector<HTMLElement>("summary")?.focus({ preventScroll: true });
        else section?.querySelector<HTMLInputElement>('input[name="category"]')?.focus({ preventScroll: true });
        return;
      }
      if (requestedFocus === "item_capacity") {
        const section = dialog.current?.querySelector<HTMLDetailsElement>(
          '[data-guidance-section="item_capacity"]',
        );
        if (section) section.open = true;
        section?.scrollIntoView({ block: "start" });
        if (coarsePointer) section?.querySelector<HTMLElement>("summary")?.focus({ preventScroll: true });
        else section?.querySelector<HTMLInputElement>('input[name="width"]')?.focus({ preventScroll: true });
        return;
      }
      if (coarsePointer) dialog.current?.focus();
      else dialog.current?.querySelector<HTMLInputElement>('input[name="name"]')?.focus();
    });
    addEventListener("keydown", keyboard);
    return () => {
      cancelAnimationFrame(frame);
      removeEventListener("keydown", keyboard);
      document.body.style.overflow = previousBodyOverflow;
      setTimeout(() => {
        let remainingFrames = ITEM_EDITOR_FOCUS_RESTORE_FRAMES;
        const restoreFocus = () => {
          if (remainingFrames > 0) {
            remainingFrames -= 1;
            requestAnimationFrame(restoreFocus);
            return;
          }
          if (document.querySelector("[aria-modal='true'][role='dialog']")) {
            return;
          }
          const focusTarget = previous?.isConnected
            ? previous
            : document.querySelector<HTMLElement>("main");
          focusTarget?.focus({ preventScroll: true });
        };
        requestAnimationFrame(restoreFocus);
      }, 0);
    };
  }, [captureComplete]);
  useEffect(() => {
    if (!recertificationReady) return;
    const frame = requestAnimationFrame(() => {
      recertificationPrompt.current?.scrollIntoView({
        behavior: matchMedia("(prefers-reduced-motion: reduce)").matches
          ? "auto"
          : "smooth",
        block: "nearest",
      });
      recertificationPrompt.current
        ?.querySelector<HTMLButtonElement>("button")
        ?.focus({ preventScroll: true });
    });
    return () => cancelAnimationFrame(frame);
  }, [recertificationReady]);
  const save = async (data: FormData) => {
    try {
      const dimensions = optionalDimensions(data);
      await commit({ type: "item.update", id: item.id, changes: {
        name: String(data.get("name")), quantity: Number(data.get("quantity")), unit: String(data.get("unit")), category: String(data.get("category")), frequency: String(data.get("frequency")) as Frequency,
        tags: splitList(data.get("tags")), description: String(data.get("description")), dimensions,
        constraints: { avoidHumidity: data.get("avoidHumidity") === "on", avoidWarmth: data.get("avoidWarmth") === "on", foodOnly: data.get("foodOnly") === "on", keepTogether: String(data.get("keepTogether")).trim() || null, requiredTags: splitList(data.get("requiredTags")) },
      } });
      setMessage("Saved on this device.");
      if (reopenedLocationId) setRecertificationReady(true);
      return true;
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Could not save item");
      return false;
    }
  };
  const move = async (data: FormData) => {
    try {
      const destinationId = String(data.get("destination"));
      const destination = state.locations.find(
        (location) => location.id === destinationId,
      );
      await commit({ type: "item.move", id: item.id, destinationId, quantity: Number(data.get("moveQuantity")) });
      if (reopenedLocationId) {
        setMessage(`Moved to ${destination?.name ?? "the selected space"}.`);
        setRecertificationReady(true);
      } else {
        close();
      }
      return true;
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Could not move item");
      return false;
    }
  };
  const reopenCapture = async () => {
    if (!currentLocationRecord) return;
    const locationId = currentLocationRecord.id;
    const reopened = await perform(commit, {
      type: "capture.status",
      id: locationId,
      status: "in_progress",
    });
    if (!reopened) return;
    setReopenedLocationId(locationId);
    requestAnimationFrame(() => {
      requestAnimationFrame(() =>
        dialog.current?.querySelector<HTMLInputElement>('input[name="name"]')
          ?.focus()
      );
    });
  };
  const recertifyCapture = async () => {
    if (!reopenedLocation || recertifying) return;
    setRecertifying(true);
    const recertified = await perform(commit, {
      type: "capture.status",
      id: reopenedLocation.id,
      status: RECERTIFIED_CAPTURE_STATUS,
    });
    setRecertifying(false);
    if (recertified) close();
  };
  if (captureComplete && currentLocationRecord) {
    return <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) close(); }}>
      <section ref={dialog} tabIndex={-1} className="modal item-editor-modal item-editor-locked" role="dialog" aria-modal="true" aria-labelledby="item-editor-title">
        <header className="item-editor-header">
          <div><p className="eyebrow">Item details</p><h2 id="item-editor-title">Review item</h2><p>{item.name}</p></div>
          <button className="icon" aria-label="Close item editor" onClick={close}><X /></button>
        </header>
        <div className="item-editor-context" aria-label="Current item summary">
          <span><small>Amount</small><strong>{item.quantity} {item.unit}</strong></span>
          <span><small>Stored in</small><strong>{currentLocationLabel}</strong></span>
        </div>
        <div className="capture-locked capture-locked-action" role="status">
          <CheckCircle2 />
          <span><strong>{currentLocationRecord.name} is read-only</strong><small>Reopen capture to edit or move this record, then mark the space counted again here.</small></span>
          <button type="button" data-reopen-capture onClick={() => void reopenCapture()}><RotateCcw /> Reopen capture</button>
        </div>
      </section>
    </div>;
  }
  return <div
    className="modal-backdrop"
    onMouseDown={(event) => {
      if (event.target === event.currentTarget) close();
    }}
  >
    <section
      ref={dialog}
      tabIndex={-1}
      className="modal item-editor-modal"
      role="dialog"
      aria-modal="true"
      aria-labelledby="item-editor-title"
    >
      <header className="item-editor-header">
        <div>
          <p className="eyebrow">Item details</p>
          <h2 id="item-editor-title">Edit item</h2>
          <p>{item.name}</p>
        </div>
        <button className="icon" aria-label="Close item editor" onClick={close}>
          <X />
        </button>
      </header>
      <div className="item-editor-context" aria-label="Current item summary">
        <span><small>Amount</small><strong>{item.quantity} {item.unit}</strong></span>
        <span><small>Stored in</small><strong>{currentLocationLabel}</strong></span>
      </div>
      <div className="item-editor-layout">
        <form
          ref={itemForm}
          onSubmit={(event) => submitForm(event, save, false)}
          className="item-editor-form"
        >
          <section className="item-section item-essential">
            <div className="item-section-heading">
              <b>1</b>
              <span>
                <strong>What is it?</strong>
                <small>Name, quantity, and a searchable description.</small>
              </span>
            </div>
            <div className="item-core-grid">
              <label className="item-name-field">
                Item name
                <input
                  autoComplete="off"
                  required
                  name="name"
                  defaultValue={item.name}
                />
              </label>
              <label>
                Quantity
                <input
                  required
                  name="quantity"
                  type="number"
                  min="0.01"
                  step="any"
                  defaultValue={item.quantity}
                />
              </label>
              <label className="item-description-field">
                Description
                <textarea
                  name="description"
                  defaultValue={item.description}
                  placeholder="Color, condition, or other identifying details"
                />
              </label>
            </div>
          </section>
          <details
            className="item-advanced"
            data-guidance-section="item_details"
          >
            <summary>
              <span>
                <strong>More item details</strong>
                <small>Unit, category, frequency, and search tags.</small>
              </span>
              <b>{hasOrganizationDetails ? "Configured" : "Optional"}</b>
            </summary>
            <div className="item-advanced-body">
              <div className="item-organize-grid">
                <label>
                  Unit
                  <input required name="unit" defaultValue={item.unit} />
                </label>
                <label>
                  Category
                  <input
                    name="category"
                    defaultValue={item.category}
                    placeholder="e.g. Baking"
                  />
                </label>
                <label>
                  How often is it used?
                  <select name="frequency" defaultValue={item.frequency}>
                    {ITEM_FREQUENCIES.map((frequency) =>
                      <option key={frequency}>{frequency}</option>
                    )}
                  </select>
                </label>
                <label className="wide">
                  Search tags
                  <input
                    name="tags"
                    defaultValue={item.tags.join(", ")}
                    placeholder="washable, seasonal, breakfast"
                  />
                  <small>Separate tags with commas.</small>
                </label>
              </div>
            </div>
          </details>
          <details className="item-advanced">
            <summary>
              <span>
                <strong>Placement requirements</strong>
                <small>Only add rules that affect where this item can safely live.</small>
              </span>
              <b>{hasPlacementRules ? "Configured" : "Optional"}</b>
            </summary>
            <div className="item-advanced-body">
              <div className="constraint-grid">
                <label>
                  <input
                    type="checkbox"
                    name="foodOnly"
                    defaultChecked={item.constraints.foodOnly}
                  />
                  <span><strong>Food-safe only</strong><small>Keep it out of unsuitable spaces.</small></span>
                </label>
                <label>
                  <input
                    type="checkbox"
                    name="avoidWarmth"
                    defaultChecked={item.constraints.avoidWarmth}
                  />
                  <span><strong>Avoid warmth</strong><small>Exclude warm cabinets or zones.</small></span>
                </label>
                <label>
                  <input
                    type="checkbox"
                    name="avoidHumidity"
                    defaultChecked={item.constraints.avoidHumidity}
                  />
                  <span><strong>Avoid humidity</strong><small>Prefer dry storage.</small></span>
                </label>
              </div>
              <div className="item-organize-grid">
                <label>
                  Keep-together group
                  <input
                    name="keepTogether"
                    defaultValue={item.constraints.keepTogether ?? ""}
                    placeholder="e.g. Coffee station"
                  />
                </label>
                <label>
                  Required location tags
                  <input
                    name="requiredTags"
                    defaultValue={item.constraints.requiredTags.join(", ")}
                    placeholder="cool, dark"
                  />
                </label>
              </div>
            </div>
          </details>
          <details
            className="item-advanced"
            data-guidance-section="item_capacity"
          >
            <summary>
              <span>
                <strong>Exact dimensions</strong>
                <small>Useful when Stowplan needs to reason about capacity.</small>
              </span>
              <b>{item.dimensions ? "Measured" : "Optional"}</b>
            </summary>
            <div className="item-advanced-body">
              <div className="dimension-grid">
                <label>Width<input name="width" type="number" min="0.01" step="any" defaultValue={item.dimensions?.width} /></label>
                <label>Height<input name="height" type="number" min="0.01" step="any" defaultValue={item.dimensions?.height} /></label>
                <label>Depth<input name="depth" type="number" min="0.01" step="any" defaultValue={item.dimensions?.depth} /></label>
                <label>Unit<select name="dimensionUnit" defaultValue={item.dimensions?.unit ?? "in"}><option>in</option><option>cm</option></select></label>
              </div>
            </div>
          </details>
          <footer className="item-save-bar">
            <span>
              <strong>Changes stay on this device first.</strong>
              <small>Server backup follows when available.</small>
            </span>
            <button className="primary">Save item</button>
          </footer>
        </form>
        <aside className="item-editor-rail">
          <form
            ref={moveForm}
            onSubmit={(event) => submitForm(event, move, false)}
            className="move-card"
          >
            <p className="eyebrow">Placement</p>
            <h3>Move all or part</h3>
            <p>Currently in <strong>{currentLocationLabel}</strong>.</p>
            <label>
              How many?
              <input
                required
                name="moveQuantity"
                type="number"
                min="0.01"
                max={item.quantity}
                step="any"
                defaultValue={item.quantity}
              />
            </label>
            <label>
              Move to
              <select required name="destination" defaultValue="">
                <option value="" disabled>Choose a space…</option>
                {destinationOptions.map(({ depth, location }) =>
                  <option key={location.id} value={location.id}>
                    {`${"  ".repeat(depth)}${depth ? "↳ " : ""}${location.code} · ${location.name}`}
                  </option>
                )}
              </select>
            </label>
            <button>Move quantity</button>
            <small>Moving fewer than {item.quantity} creates a separate record at the destination.</small>
          </form>
          <details className="item-danger">
            <summary>More actions</summary>
            <button
              type="button"
              className="danger"
              onClick={() => {
                if (confirm(`Delete ${item.name}? You can undo this from Activity.`)) {
                  void perform(
                    commit,
                    { type: "item.delete", id: item.id },
                    close,
                  );
                }
              }}
            >
              <Trash2 /> Delete item record
            </button>
            <small>Deletion is recorded in Activity and can be undone.</small>
          </details>
        </aside>
      </div>
      {recertificationReady && reopenedLocation && <section
        aria-live="polite"
        className="item-recertification"
        ref={recertificationPrompt}
      >
        <CheckCircle2 aria-hidden="true" />
        <span>
          <strong>{reopenedLocation.name} needs a fresh count</strong>
          <small>Confirm the physical contents now match this edited record.</small>
        </span>
        <button
          className="primary"
          disabled={recertifying}
          onClick={() => void recertifyCapture()}
          type="button"
        >
          {recertifying ? "Marking counted..." : "Mark counted again"}
        </button>
      </section>}
      {message && <output className="form-message item-editor-message">{message}</output>}
    </section>
  </div>;
}
