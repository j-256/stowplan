"use client";

import {
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type * as React from "react";
import {
  ChevronDown,
  ChevronRight,
  Info,
} from "lucide-react";
import {
  DEFAULT_PLAN_WEIGHTS,
  generatePlan as buildMovePlan,
} from "../domain/planner";
import {
  assessPlanReadiness,
  type PlanReadiness,
} from "../domain/planning-readiness";
import type {
  Location,
  PlanStep,
  PlanWeights,
  WorkspaceState,
} from "../domain/types";
import { ModalDialog } from "./modal-dialog";
import { locationPath } from "./workspace-hierarchy";
import {
  countLabel,
  Empty,
  perform,
  STACKED_TOUCH_LAYOUT_QUERY,
  useMediaQuery,
} from "./workspace-view-helpers";
import type {
  Commit,
  GuidanceFocus,
  GuidanceTarget,
} from "./workspace-view-types";

const planPriorityHelp: Record<
  keyof PlanWeights,
  { label: string; description: string }
> = {
  accessibility: {
    label: "Accessibility",
    description: "Score bonus = max(0, 5 − nesting depth) × frequency factor × this value × 0.25. Daily items use factor 4, weekly 3, monthly 2, and rarely used 1, so higher values pull frequently used items toward shallower spaces.",
  },
  capacity: {
    label: "Capacity",
    description: "For a measured space that fits, bonus = this value × min(3, 1 + remaining volume ÷ total volume). A measured space that is too small is always rejected, even when this is zero.",
  },
  grouping: {
    label: "Grouping",
    description: "Bonus = matching nearby records × this value, capped at four matches. A match shares an explicit item category or keep-together group. Blank and Uncategorized categories do not count as evidence that records belong together.",
  },
  moveCost: {
    label: "Move effort",
    description: "The score subtracts tree distance × this value, adds 3× this value for staying put, and requires an item move to improve by more than this value. Higher values favor one filled-container move only when none of its records scores worse at the destination.",
  },
  suitability: {
    label: "Suitability",
    description: "Every eligible space starts at 2× this value; satisfying food-safe adds 2×, avoiding warmth adds 1×, and avoiding humidity adds 1×. A space that violates a required rule is always rejected, even when this is zero.",
  },
};

function emptyPlanGuidance(readiness: PlanReadiness): string {
  if (readiness.primaryGap === "inventory") {
    return "Record at least one item so Stowplan has something to improve.";
  }
  if (readiness.primaryGap === "destinations") {
    return "Count at least two shelves, drawers, boxes, or cabinets so there is a trustworthy alternative destination.";
  }
  if (readiness.primaryGap === "count") {
    return "Finish the first-pass decision for the remaining spaces, then try again.";
  }
  if (readiness.primaryGap === "item_details") {
    return "Add categories or placement requirements to quick-captured items so Stowplan can distinguish what belongs together and where it is safe.";
  }
  if (readiness.primaryGap === "destination_details") {
    return "Review destination suitability, such as food safety, temperature, humidity, or useful tags.";
  }
  if (readiness.primaryGap === "capacity") {
    return "The arrangement may already be good. Add measurements where fit matters, or adjust the priorities.";
  }
  return "The current arrangement already scores as well as the available alternatives.";
}

function PlanningReadinessPanel({
  onOpenDetails,
  readiness,
  state,
  summaryOnly = false,
  openGuidanceTarget,
}: {
  onOpenDetails?: () => void;
  readiness: PlanReadiness;
  state: WorkspaceState;
  summaryOnly?: boolean;
  openGuidanceTarget: (
    view: GuidanceTarget["view"],
    id: string,
    focus?: GuidanceFocus,
  ) => void;
}) {
  const firstLiveLocation = state.locations.find(
    (location) => !location.archivedAt,
  )?.id ?? "";
  const headline = readiness.level === "needs_inventory"
    ? "Record inventory before trusting a plan"
    : readiness.level === "needs_destinations"
      ? "Count more possible destinations"
      : readiness.level === "ready"
        ? "Planning evidence is strong"
        : "Enough to try, with gaps to review";
  const issues: {
    action?: () => void;
    actionLabel?: string;
    detail: string;
    priority: "complete" | "optional" | "required" | "review";
    title: string;
  }[] = [];
  if (readiness.activeItemIds.length === 0) {
    issues.push({
      action: () => openGuidanceTarget("capture", firstLiveLocation),
      actionLabel: "Open Capture",
      detail: "The planner needs at least one live item record.",
      priority: "required",
      title: "Add something to organize",
    });
  }
  if (readiness.countedDestinationIds.length < 2) {
    issues.push({
      action: () => openGuidanceTarget(
        "capture",
        readiness.uncountedLocationIds[0] ?? firstLiveLocation,
      ),
      actionLabel: "Continue count",
      detail: "Shelves, drawers, boxes, bins, cabinets, and containers can receive planned moves.",
      priority: "required",
      title: "Count two possible destinations",
    });
  } else if (readiness.uncountedLocationIds.length > 0) {
    issues.push({
      action: () => openGuidanceTarget(
        "capture",
        readiness.uncountedLocationIds[0] as string,
      ),
      actionLabel: "Continue count",
      detail: "Mark each counted or known empty so missing information is not mistaken for an empty space.",
      priority: "review",
      title: `${readiness.uncountedLocationIds.length} space${readiness.uncountedLocationIds.length === 1 ? "" : "s"} still need a first-pass decision`,
    });
  }
  if (readiness.uncategorizedItemIds.length > 0) {
    issues.push({
      action: () => openGuidanceTarget(
        "inventory",
        readiness.uncategorizedItemIds[0] as string,
        "item_details",
      ),
      actionLabel: "Review an item",
      detail: "Add a category, use frequency, or placement rule where it changes the right home.",
      priority: "review",
      title: `${readiness.uncategorizedItemIds.length} item${readiness.uncategorizedItemIds.length === 1 ? "" : "s"} still use quick-capture defaults`,
    });
  }
  if (readiness.destinationsUsingDefaultsIds.length > 0) {
    issues.push({
      action: () => openGuidanceTarget(
        "spaces",
        readiness.destinationsUsingDefaultsIds[0] as string,
        "space_suitability",
      ),
      actionLabel: "Review a space",
      detail: "Review food safety, temperature, humidity, and tags only where they matter.",
      priority: "review",
      title: `${countLabel(readiness.destinationsUsingDefaultsIds.length, "counted destination")} ${readiness.destinationsUsingDefaultsIds.length === 1 ? "uses" : "use"} basic suitability defaults`,
    });
  }
  if (
    readiness.unmeasuredDestinationIds.length > 0 ||
    readiness.unmeasuredItemIds.length > 0
  ) {
    issues.push({
      action: () => readiness.unmeasuredDestinationIds.length
        ? openGuidanceTarget(
            "spaces",
            readiness.unmeasuredDestinationIds[0] as string,
            "space_capacity",
          )
        : openGuidanceTarget(
            "inventory",
            readiness.unmeasuredItemIds[0] as string,
            "item_capacity",
          ),
      actionLabel: "Review capacity",
      detail: `${readiness.unmeasuredDestinationIds.length} storage space${readiness.unmeasuredDestinationIds.length === 1 ? "" : "s"} and ${readiness.unmeasuredItemIds.length} item record${readiness.unmeasuredItemIds.length === 1 ? "" : "s"} lack dimensions. Measure only where fit is uncertain.`,
      priority: "optional",
      title: "Capacity remains partly unverified",
    });
  }
  if (issues.length === 0) {
    issues.push({
      detail: "Generate a plan and review every physical move before marking it complete.",
      priority: "complete",
      title: "No obvious evidence gaps",
    });
  }
  const renderIssue = (issue: typeof issues[number]) => <li
    data-priority={issue.priority}
    key={`${issue.priority}-${issue.title}`}
  >
    <span><strong>{issue.title}</strong><small>{issue.detail}</small></span>
    {issue.action && issue.actionLabel && <button onClick={issue.action}>{issue.actionLabel}</button>}
  </li>;
  if (summaryOnly && onOpenDetails) {
    return <button
      aria-haspopup="dialog"
      aria-label={`Review planning readiness: ${headline}`}
      className="plan-readiness-summary"
      onClick={onOpenDetails}
      type="button"
    >
      <span>
        <small>Planning readiness</small>
        <strong>{headline}</strong>
        <small>{countLabel(issues.length, "confidence check")}</small>
      </span>
      <ChevronRight aria-hidden="true" />
    </button>;
  }
  return <section className="plan-readiness" aria-label="Planning readiness">
    <header>
      <div>
        <p className="eyebrow">Planning readiness</p>
        <h3 id="plan-readiness-title">{headline}</h3>
      </div>
      <span data-level={readiness.level}>
        {countLabel(readiness.countedDestinationIds.length, "counted destination")}
      </span>
    </header>
    <p>{readiness.canGenerateUsefulPlan
      ? "You can generate a plan now. Resolving the items below will make its reasoning easier to trust."
      : "Generation stays available, but the current evidence is too thin for a useful recommendation."}</p>
    <ul>{renderIssue(issues[0] as typeof issues[number])}</ul>
    {issues.length > 1 && <details className="plan-readiness-more">
      <summary>{issues.length - 1} more way{issues.length === 2 ? "" : "s"} to improve confidence</summary>
      <ul>{issues.slice(1).map(renderIssue)}</ul>
    </details>}
  </section>;
}

export function Planner({ state, commit, openGuidanceTarget }: { state: WorkspaceState; commit: Commit; openGuidanceTarget: (view: GuidanceTarget["view"], id: string, focus?: GuidanceFocus) => void }) {
  const activePlans = state.plans.filter((plan) => plan.status === "active");
  const active = activePlans[0];
  const hasConflictingPlans = activePlans.length > 1;
  const compactLayout = useMediaQuery(STACKED_TOUCH_LAYOUT_QUERY);
  const readiness = useMemo(() => assessPlanReadiness(state), [state]);
  const [weights, setWeights] = useState<PlanWeights>({ ...DEFAULT_PLAN_WEIGHTS });
  const [name, setName] = useState("Suggested reset");
  const [message, setMessage] = useState("");
  const [nextMoveFocusRequest, setNextMoveFocusRequest] = useState(0);
  const [planOptionsOpen, setPlanOptionsOpen] = useState(false);
  const [readinessOpen, setReadinessOpen] = useState(false);
  const [stepSupportOpen, setStepSupportOpen] = useState(false);
  const [itineraryOpen, setItineraryOpen] = useState(false);
  const nextMoveAction = useRef<HTMLButtonElement | null>(null);
  const nextMoveCard = useRef<HTMLElement | null>(null);
  const itineraryTrigger = useRef<HTMLButtonElement | null>(null);
  const planOptionsTrigger = useRef<HTMLButtonElement | null>(null);
  const stepSupportTrigger = useRef<HTMLButtonElement | null>(null);
  const generate = async () => {
    const plan = buildMovePlan(state, { name, weights });
    if (!plan.steps.length) {
      setMessage("No beneficial moves were found.");
      return;
    }
    try {
      await commit({ type: "plan.create", plan });
      setMessage(`${plan.steps.length} explainable ${plan.steps.length === 1 ? "move" : "moves"} added to the new plan.`);
      setNextMoveFocusRequest((request) => request + 1);
      setPlanOptionsOpen(false);
    } catch (error) { setMessage(error instanceof Error ? error.message : "Could not create the plan"); }
  };
  const updateWeight = (key: keyof PlanWeights, value: number) => setWeights((current) => ({ ...current, [key]: value }));
  const complete = active?.steps.filter((step) => step.completedAt).length ?? 0;
  const nextStepIndex = active?.steps.findIndex((step) => !step.completedAt) ?? -1;
  const nextStep = nextStepIndex >= 0
    ? active?.steps[nextStepIndex] ?? null
    : null;
  const nextStepId = nextStep?.id ?? null;
  const pathLabel = (path: Location[]) => path.length
    ? path.map((location) => `${location.code} · ${location.name}`).join(" › ")
    : "Unknown space";
  const placeLabel = (locationId: string) => pathLabel(
    locationPath(state.locations, locationId),
  );
  const routePresentation = (sourceId: string, destinationId: string) => {
    const sourcePath = locationPath(state.locations, sourceId);
    const destinationPath = locationPath(state.locations, destinationId);
    const maxSharedDepth = Math.max(
      0,
      Math.min(sourcePath.length, destinationPath.length) - 1,
    );
    let sharedDepth = 0;
    while (
      sharedDepth < maxSharedDepth &&
      sourcePath[sharedDepth]?.id === destinationPath[sharedDepth]?.id
    ) {
      sharedDepth += 1;
    }
    const describe = (path: Location[]) => {
      const visible = path.slice(sharedDepth);
      const endpoint = visible.at(-1) ?? path.at(-1);
      return {
        context: visible.slice(0, -1)
          .map((location) => `${location.code} · ${location.name}`)
          .join(" › "),
        endpoint: endpoint
          ? `${endpoint.code} · ${endpoint.name}`
          : "Unknown space",
        full: pathLabel(path),
      };
    };
    return {
      destination: describe(destinationPath),
      source: describe(sourcePath),
    };
  };
  const subjectForStep = (step: PlanStep) => {
    const item = step.itemId
      ? state.items.find((candidate) => candidate.id === step.itemId)
      : null;
    const container = step.locationId
      ? state.locations.find((candidate) => candidate.id === step.locationId)
      : null;
    return {
      container,
      item,
      label: item
        ? `${step.quantity ?? item.quantity} ${item.unit} of ${item.name}`
        : container?.name ?? "container",
    };
  };
  const capacityIsUnverified = (step: PlanStep) => step.explanation.some(
    (reason) =>
      reason.includes("capacity is unmeasured") ||
      reason.includes("capacity cannot be verified"),
  );
  const completeStep = async (step: PlanStep) => {
    if (!active) return;
    const completesPlan = active.steps.filter(
      (candidate) => !candidate.completedAt,
    ).length === 1;
    const moved = await perform(commit, {
      type: "plan.step.complete",
      planId: active.id,
      stepId: step.id,
    });
    if (!moved) return;
    if (completesPlan) setMessage("");
    else setNextMoveFocusRequest((request) => request + 1);
  };
  useEffect(() => {
    if (!nextMoveFocusRequest || !nextStepId) return;
    let focusFrame = 0;
    const renderFrame = requestAnimationFrame(() => {
      focusFrame = requestAnimationFrame(() => {
        const card = nextMoveCard.current;
        if (!card) return;
        card.scrollIntoView({
          behavior: matchMedia("(prefers-reduced-motion: reduce)").matches
            ? "auto"
            : "smooth",
          block: "start",
        });
        card.focus({ preventScroll: true });
      });
    });
    return () => {
      cancelAnimationFrame(renderFrame);
      cancelAnimationFrame(focusFrame);
    };
  }, [nextMoveFocusRequest, nextStepId]);
  const keepNextActionVisible = (
    event: React.SyntheticEvent<HTMLDetailsElement>,
  ) => {
    if (!event.currentTarget.open) return;
    nextMoveAction.current?.scrollIntoView({
      block: "center",
      inline: "nearest",
    });
  };
  const nextSubject = nextStep ? subjectForStep(nextStep) : null;
  const nextItemId = nextSubject?.item?.id ?? null;
  const nextContainerId = nextSubject?.container?.id ?? null;
  const nextRoute = nextStep
    ? routePresentation(nextStep.sourceId, nextStep.destinationId)
    : null;
  const readinessPanel = <PlanningReadinessPanel
    openGuidanceTarget={openGuidanceTarget}
    readiness={readiness}
    state={state}
  />;
  const plannerBody = <div className="planner-hero-body">
    <div className="planner-overview">
      <p className="eyebrow">Explainable recommendations</p>
      <h2>Fewer moves, better homes.</h2>
      <div className="plan-actions">
        <button className="primary" onClick={() => void generate()}>
          {active ? "Replace with fresh plan" : "Generate move plan"}
        </button>
        {active && !hasConflictingPlans && <button onClick={() => void perform(
          commit,
          { type: "plan.status", planId: active.id, status: "discarded" },
          () => {
            setMessage("");
            setPlanOptionsOpen(false);
          },
        )}>
          Discard current plan
        </button>}
      </div>
      {message && <output className="form-message">{message}</output>}
      <p>Balance suitability, access, grouping, capacity, and move effort, including moving a whole nested box when that is simpler. Marking a step moved updates Inventory immediately; Activity can undo it.</p>
    </div>
    <details className="plan-settings">
      <summary>Plan priorities</summary>
      <label>Plan name<input autoComplete="off" name="planName" value={name} onChange={(event) => setName(event.target.value)} /></label>
      {(Object.keys(weights) as (keyof PlanWeights)[]).map((key) => {
        const help = planPriorityHelp[key];
        const tooltipId = `priority-${key}-help`;
        return <div className="plan-priority" key={key}>
          <div className="plan-priority-label">
            <label htmlFor={`priority-${key}`}>{help.label}</label>
            <span className="info-tip">
              <button type="button" aria-label={`How ${help.label.toLowerCase()} affects a plan`} aria-describedby={tooltipId}><Info /></button>
              <span id={tooltipId} role="tooltip">{help.description}</span>
            </span>
            <output htmlFor={`priority-${key}`}>{weights[key]}</output>
          </div>
          <input id={`priority-${key}`} aria-label={`${help.label} weight`} type="range" min="0" max="10" step="1" value={weights[key]} onChange={(event) => updateWeight(key, Number(event.target.value))} />
        </div>;
      })}
    </details>
    {compactLayout && active
      ? <PlanningReadinessPanel
        onOpenDetails={() => {
          setPlanOptionsOpen(false);
          setReadinessOpen(true);
        }}
        openGuidanceTarget={openGuidanceTarget}
        readiness={readiness}
        state={state}
        summaryOnly
      />
      : readinessPanel}
  </div>;
  const plannerHero = <>
    <section
      className="panel planner-hero"
      data-has-active={active ? "true" : undefined}
      data-open={!active || (!compactLayout && planOptionsOpen) ? "true" : undefined}
    >
      <button
        aria-expanded={planOptionsOpen}
        aria-haspopup={compactLayout && active ? "dialog" : undefined}
        className="planner-options-summary"
        onClick={() => setPlanOptionsOpen((open) => !open)}
        ref={planOptionsTrigger}
        type="button"
      >
        <span>
          <strong>{active ? "Plan options" : "Create a move plan"}</strong>
          <small>{active
            ? "Priorities, readiness, replace, or discard"
            : "Generate now or review the available evidence"}</small>
        </span>
        {compactLayout && active
          ? <ChevronRight aria-hidden="true" />
          : <ChevronDown aria-hidden="true" />}
      </button>
      {(!compactLayout || !active) && plannerBody}
    </section>
    {compactLayout && active && <ModalDialog
      mobileSheet="full"
      onClose={() => setPlanOptionsOpen(false)}
      open={planOptionsOpen}
      returnFocusRef={planOptionsTrigger}
      title="Plan options"
    >
      <div className="planner-sheet">{plannerBody}</div>
      <button className="planner-sheet-close" onClick={() => setPlanOptionsOpen(false)} type="button">Close</button>
    </ModalDialog>}
  </>;
  const stepSupportBody = nextStep && nextRoute ? <div className="plan-step-support-body">
    <div className="plan-review-route">
      <span><strong>From</strong><small>{nextRoute.source.full}</small></span>
      <span><strong>To</strong><small>{nextRoute.destination.full}</small></span>
    </div>
    {capacityIsUnverified(nextStep) && <em className="plan-confidence">Capacity unverified</em>}
    <p>{nextStep.explanation.join(" · ")}</p>
    <p className="plan-review-note">Review links do not move anything. Saving changed item or destination details discards this plan so the next plan uses the corrected evidence.</p>
    <div className="plan-review-actions">
      {nextItemId && <button onClick={() => openGuidanceTarget("inventory", nextItemId)}>Review item</button>}
      {nextContainerId && <button onClick={() => openGuidanceTarget("spaces", nextContainerId)}>Review container</button>}
      <button onClick={() => openGuidanceTarget("spaces", nextStep.destinationId)}>Review destination</button>
    </div>
  </div> : null;
  const itineraryList = active ? <ol className="plan-itinerary-list">{active.steps.map((step, index) => {
    const subject = subjectForStep(step);
    const status = step.completedAt
      ? "Moved"
      : index === nextStepIndex
        ? "Next"
        : "Upcoming";
    return <li data-status={status.toLowerCase()} key={step.id}>
      <b>{index + 1}</b>
      <span>
        <strong>Move {subject.label}</strong>
        <small>{placeLabel(step.sourceId)} → {placeLabel(step.destinationId)}</small>
      </span>
      <em>{status}</em>
    </li>;
  })}</ol> : null;
  return <div className="content">
    {hasConflictingPlans && <section className="panel form-message" role="alert"><h3>Resolve overlapping active plans</h3><p>This older workspace contains {activePlans.length} active plans. Generate a fresh plan to replace all of them, or discard plans until one remains before executing a move.</p>{activePlans.map((plan) => <button key={plan.id} onClick={() => void perform(commit, { type: "plan.status", planId: plan.id, status: "discarded" })}>Discard {plan.name}</button>)}</section>}
    {active && !hasConflictingPlans && nextStep && nextSubject && nextRoute ? <>
      <div className="plan-progress"><strong>{active.name}</strong><span>{complete} of {active.steps.length} complete</span></div>
      <section
        aria-label="Next move"
        className="panel plan-next-move"
        data-step-id={nextStep.id}
        ref={nextMoveCard}
        tabIndex={-1}
      >
        <header>
          <div>
            <p className="eyebrow">Next move</p>
            <h3>Move {nextSubject.label}</h3>
          </div>
          <b>Step {nextStepIndex + 1} of {active.steps.length}</b>
        </header>
        <div
          aria-label={`From ${nextRoute.source.full} to ${nextRoute.destination.full}`}
          className="plan-route"
        >
          <span>
            <small>From {nextRoute.source.context && <span className="plan-route-context">{nextRoute.source.context}</span>}</small>
            <strong className="plan-route-endpoint">{nextRoute.source.endpoint}</strong>
          </span>
          <ChevronRight aria-hidden="true" />
          <span>
            <small>To {nextRoute.destination.context && <span className="plan-route-context">{nextRoute.destination.context}</span>}</small>
            <strong className="plan-route-endpoint">{nextRoute.destination.endpoint}</strong>
          </span>
        </div>
        <button
          className="primary plan-next-action"
          data-step-state="ready"
          onClick={() => void completeStep(nextStep)}
          ref={nextMoveAction}
        >
          Mark moved
        </button>
        {compactLayout
          ? <button
            aria-expanded={stepSupportOpen}
            aria-haspopup="dialog"
            className="plan-step-support-trigger"
            onClick={() => setStepSupportOpen(true)}
            ref={stepSupportTrigger}
            type="button"
          >
            <span>Why this move and review details</span>
            <ChevronRight aria-hidden="true" />
          </button>
          : <details
            className="plan-step-support"
            onToggle={keepNextActionVisible}
          >
            <summary>Why this move and review details</summary>
            {stepSupportBody}
          </details>}
      </section>
      {compactLayout
        ? <button
          aria-expanded={itineraryOpen}
          aria-haspopup="dialog"
          className="panel plan-itinerary-trigger"
          onClick={() => setItineraryOpen(true)}
          ref={itineraryTrigger}
          type="button"
        >
          <span>Review full plan</span>
          <small>{countLabel(active.steps.length, "move")}</small>
          <ChevronRight aria-hidden="true" />
        </button>
        : <details className="panel plan-itinerary">
          <summary>Review full plan <span>{countLabel(active.steps.length, "move")}</span></summary>
          {itineraryList}
        </details>}
      {compactLayout && <ModalDialog
        mobileSheet="full"
        onClose={() => setStepSupportOpen(false)}
        open={stepSupportOpen}
        returnFocusRef={stepSupportTrigger}
        title="Why this move"
      >
        {stepSupportBody}
        <button className="planner-sheet-close" onClick={() => setStepSupportOpen(false)} type="button">Close</button>
      </ModalDialog>}
      {compactLayout && <ModalDialog
        mobileSheet="full"
        onClose={() => setItineraryOpen(false)}
        open={itineraryOpen}
        returnFocusRef={itineraryTrigger}
        title="Full plan"
      >
        {itineraryList}
        <button className="planner-sheet-close" onClick={() => setItineraryOpen(false)} type="button">Close</button>
      </ModalDialog>}
    </> : null}
    {plannerHero}
    {compactLayout && active && <ModalDialog
      mobileSheet="full"
      onClose={() => setReadinessOpen(false)}
      open={readinessOpen}
      returnFocusRef={planOptionsTrigger}
      title="Planning readiness"
    >
      {readinessPanel}
      <button className="planner-sheet-close" onClick={() => setReadinessOpen(false)} type="button">Close</button>
    </ModalDialog>}
    {(!active || hasConflictingPlans || !nextStep || !nextSubject) && <Empty title="No active plan" text={readiness.canGenerateUsefulPlan ? "There is enough evidence to try a plan. Review the readiness guidance, then generate when you are comfortable with the gaps." : emptyPlanGuidance(readiness)} />}
  </div>;
}
