"use client";

import {
  AlertCircle,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  FileSpreadsheet,
  FileUp,
  Info,
} from "lucide-react";
import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
} from "react";
import {
  CSV_IMPORT_MAX_FILE_BYTES,
  CSV_ITEM_FIELDS,
  CsvParseError,
  csvLocationValueGroups,
  csvValuePreview,
  emptyCsvItemMapping,
  guessCsvColumns,
  parseCsv,
  planCsvImport,
  suggestedCsvLocationAssignments,
  type CsvImportPlan,
  type CsvImportPlacement,
  type CsvItemColumnMapping,
  type CsvItemField,
  type CsvLocationValueGroup,
  type ParsedCsv,
} from "../domain/csv-import";
import {
  newId,
  nowIso,
} from "../domain/factories";
import type {
  Command,
  Location,
  WorkspaceState,
} from "../domain/types";
import { API_QUOTAS } from "../shared/api-quotas";
import { ModalDialog } from "./modal-dialog";
import styles from "./csv-import-dialog.module.css";

type ImportStage = "file" | "map" | "review";

type BulkCreateCommand = Extract<Command, { type: "item.bulkCreate" }>;

interface CsvImportDialogProps {
  commit: (command: Command) => Promise<void>;
  onImported: (count: number) => void;
  preferredLocationId?: string;
  state: WorkspaceState;
}

interface LocationOption {
  id: string;
  label: string;
}

const FIELD_LABELS: Readonly<Record<CsvItemField, string>> = Object.freeze({
  category: "Category",
  description: "Description",
  frequency: "Frequency",
  name: "Item name",
  quantity: "Quantity",
  tags: "Tags",
  unit: "Unit",
});

const BLOCKING_MAPPING_ISSUES = new Set([
  "DESTINATION_REQUIRED",
  "DUPLICATE_COLUMN_MAPPING",
  "INVALID_COLUMN",
  "LOCATION_COLUMN_REQUIRED",
  "NAME_COLUMN_REQUIRED",
  "NO_DATA_ROWS",
]);

const LOCATION_GROUP_PAGE_SIZE = 50;
const ROW_PREVIEW_LIMIT = 25;
const ERROR_PREVIEW_LIMIT = 50;

function countLabel(
  count: number,
  singular: string,
  plural = `${singular}s`,
): string {
  return `${count} ${count === 1 ? singular : plural}`;
}

function formatBytes(bytes: number): string {
  if (bytes < 1_024) return `${bytes} B`;
  if (bytes < 1_024 * 1_024) {
    return `${(bytes / 1_024).toFixed(1)} KB`;
  }
  return `${(bytes / (1_024 * 1_024)).toFixed(1)} MB`;
}

function locationPath(
  byId: ReadonlyMap<string, Location>,
  location: Location,
): string {
  const names: string[] = [];
  const seen = new Set<string>();
  let current: Location | undefined = location;
  while (current && !seen.has(current.id)) {
    seen.add(current.id);
    names.unshift(current.name);
    current = current.parentId
      ? byId.get(current.parentId)
      : undefined;
  }
  return names.join(" > ");
}

function locationOptions(locations: readonly Location[]): LocationOption[] {
  const byId = new Map(locations.map((location) => [location.id, location]));
  return locations
    .filter((location) => !location.archivedAt)
    .map((location) => {
      const path = locationPath(byId, location);
      return {
        id: location.id,
        label: `${location.code} · ${path}`,
      };
    })
    .sort((left, right) => left.label.localeCompare(right.label));
}

function csvColumnLabel(
  parsed: ParsedCsv,
  columnIndex: number,
): string {
  const column = parsed.columns[columnIndex];
  return `${csvValuePreview(column?.header ?? "") || "Unnamed column"} (column ${
    columnIndex + 1
  })`;
}

function parseProblem(error: unknown): string {
  if (error instanceof CsvParseError) {
    return `${error.message} at line ${error.line}, column ${error.column}`;
  }
  return error instanceof Error && error.message
    ? error.message
    : "This CSV file could not be read";
}

function StageIndicator({ stage }: { stage: ImportStage }) {
  const activeIndex = stage === "file" ? 0 : stage === "map" ? 1 : 2;
  const labels = ["Choose file", "Map columns", "Review import"];
  return <ol className={styles.steps} aria-label="CSV import progress">
    {labels.map((label, index) => <li
      aria-current={index === activeIndex ? "step" : undefined}
      data-active={index === activeIndex ? "true" : undefined}
      data-complete={index < activeIndex ? "true" : undefined}
      key={label}
    >
      <span aria-hidden="true">{index < activeIndex ? "✓" : index + 1}</span>
      <small>{label}</small>
    </li>)}
  </ol>;
}

function ColumnSelect({
  field,
  mapping,
  onChange,
  parsed,
}: {
  field: CsvItemField;
  mapping: CsvItemColumnMapping;
  onChange: (field: CsvItemField, columnIndex: number | null) => void;
  parsed: ParsedCsv;
}) {
  const required = field === "name";
  return <label className={styles.field}>
    <span>
      {FIELD_LABELS[field]}
      {required ? <b>Required</b> : <small>Optional</small>}
    </span>
    <select
      aria-required={required}
      name={`csv${field[0]?.toLocaleUpperCase()}${field.slice(1)}Column`}
      onChange={(event) => onChange(
        field,
        event.currentTarget.value === ""
          ? null
          : Number(event.currentTarget.value),
      )}
      value={mapping[field] ?? ""}
    >
      <option value="">
        {required ? "Choose a column" : "Not imported"}
      </option>
      {parsed.columns.map((column) => <option
        key={column.index}
        value={column.index}
      >
        {csvColumnLabel(parsed, column.index)}
      </option>)}
    </select>
  </label>;
}

function LocationValueMappings({
  assignments,
  groups,
  onChange,
  options,
}: {
  assignments: Readonly<Record<string, string>>;
  groups: readonly CsvLocationValueGroup[];
  onChange: (key: string, locationId: string) => void;
  options: readonly LocationOption[];
}) {
  const [query, setQuery] = useState("");
  const [page, setPage] = useState(0);
  const filtered = useMemo(() => {
    const normalized = query.trim().toLocaleLowerCase();
    return normalized
      ? groups.filter((group) =>
          group.label.toLocaleLowerCase().includes(normalized)
        )
      : [...groups];
  }, [groups, query]);
  const pageCount = Math.max(
    1,
    Math.ceil(filtered.length / LOCATION_GROUP_PAGE_SIZE),
  );
  const safePage = Math.min(page, pageCount - 1);
  const shown = filtered.slice(
    safePage * LOCATION_GROUP_PAGE_SIZE,
    (safePage + 1) * LOCATION_GROUP_PAGE_SIZE,
  );
  const unresolved = groups.filter((group) =>
    !options.some((option) => option.id === assignments[group.key])
  ).length;

  return <section
    aria-labelledby="csv-location-values-heading"
    className={styles.locationMappings}
  >
    <header>
      <span>
        <h4 id="csv-location-values-heading">Location values</h4>
        <small>
          {unresolved
            ? `${countLabel(unresolved, "value")} still need a destination`
            : "Every value has a destination"}
        </small>
      </span>
      {groups.length > 8 && <label className={styles.valueSearch}>
        <span className={styles.srOnly}>Find a location value</span>
        <input
          autoComplete="off"
          name="csvLocationValueQuery"
          onChange={(event) => {
            setQuery(event.currentTarget.value);
            setPage(0);
          }}
          placeholder="Find location value"
          type="search"
          value={query}
        />
      </label>}
    </header>
    <div className={styles.locationValueList}>
      {shown.map((group) => {
        const assigned = assignments[group.key] ?? "";
        const autoMatched = Boolean(
          assigned &&
          assigned === group.locationId &&
          group.matchedBy,
        );
        const status = assigned
          ? autoMatched
            ? `Matched by ${group.matchedBy}`
            : "Mapped manually"
          : group.ambiguous
            ? "Ambiguous value"
            : "No automatic match";
        return <label
          className={styles.locationValue}
          data-resolved={assigned ? "true" : "false"}
          key={group.key}
        >
          <span>
            <strong>{csvValuePreview(group.label)}</strong>
            <small>
              {countLabel(group.count, "row")} · {status}
            </small>
          </span>
          <select
            aria-label={`Destination for ${csvValuePreview(group.label)}`}
            name="csvLocationAssignment"
            onChange={(event) => onChange(
              group.key,
              event.currentTarget.value,
            )}
            value={assigned}
          >
            <option value="">Choose destination</option>
            {options.map((option) => <option
              key={option.id}
              value={option.id}
            >
              {option.label}
            </option>)}
          </select>
        </label>;
      })}
      {!shown.length && <p className={styles.emptyResult}>
        No location values match this search.
      </p>}
    </div>
    {pageCount > 1 && <footer className={styles.pagination}>
      <button
        aria-label="Previous location values"
        disabled={safePage === 0}
        onClick={() => setPage(Math.max(0, safePage - 1))}
        type="button"
      >
        <ChevronLeft aria-hidden="true" /> Previous
      </button>
      <span>Page {safePage + 1} of {pageCount}</span>
      <button
        aria-label="Next location values"
        disabled={safePage >= pageCount - 1}
        onClick={() => setPage(Math.min(pageCount - 1, safePage + 1))}
        type="button"
      >
        Next <ChevronRight aria-hidden="true" />
      </button>
    </footer>}
  </section>;
}

function FileStage({
  activeLocationCount,
  error,
  onCancel,
  onFile,
  reading,
}: {
  activeLocationCount: number;
  error: string;
  onCancel: () => void;
  onFile: (event: ChangeEvent<HTMLInputElement>) => void;
  reading: boolean;
}) {
  return <div className={styles.stageBody}>
    <div className={styles.localNotice}>
      <FileSpreadsheet aria-hidden="true" />
      <span>
        <strong>Parsed only on this device</strong>
        <small>
          The raw file is never uploaded. Nothing changes until the final
          import button.
        </small>
      </span>
    </div>
    {!activeLocationCount && <div className={styles.alert} data-tone="warning">
      <AlertCircle aria-hidden="true" />
      <span>
        <strong>Create a space first</strong>
        <small>
          Inventory rows need at least one active destination before they can
          be imported.
        </small>
      </span>
    </div>}
    <label className={styles.filePicker}>
      <FileUp aria-hidden="true" />
      <span>
        <strong>{reading ? "Reading CSV..." : "Choose CSV file"}</strong>
        <small>
          UTF-8, comma-separated, up to {formatBytes(
            CSV_IMPORT_MAX_FILE_BYTES,
          )}
        </small>
      </span>
      <input
        accept=".csv,text/csv"
        disabled={reading}
        name="csvFile"
        onChange={onFile}
        type="file"
      />
    </label>
    {error && <div className={styles.alert} data-tone="danger" role="alert">
      <AlertCircle aria-hidden="true" />
      <span>
        <strong>CSV could not be opened</strong>
        <small>{error}</small>
      </span>
    </div>}
    <section className={styles.formatHelp}>
      <h4>What can be mapped</h4>
      <p>
        Item name is required. Quantity, unit, category, description, tags,
        frequency, and location are optional columns. Quoted commas and line
        breaks are supported.
      </p>
    </section>
    <div className={styles.actions}>
      <button onClick={onCancel} type="button">Cancel</button>
    </div>
  </div>;
}

function MappingStage({
  assignments,
  blockingIssues,
  fileName,
  groups,
  locationColumn,
  mapping,
  onAssignmentChange,
  onBack,
  onColumnChange,
  onLocationColumnChange,
  onPlacementModeChange,
  onReview,
  onSingleLocationChange,
  options,
  parsed,
  placementMode,
  singleLocationId,
}: {
  assignments: Readonly<Record<string, string>>;
  blockingIssues: readonly string[];
  fileName: string;
  groups: readonly CsvLocationValueGroup[];
  locationColumn: number | null;
  mapping: CsvItemColumnMapping;
  onAssignmentChange: (key: string, locationId: string) => void;
  onBack: () => void;
  onColumnChange: (field: CsvItemField, columnIndex: number | null) => void;
  onLocationColumnChange: (columnIndex: number | null) => void;
  onPlacementModeChange: (mode: CsvImportPlacement["mode"]) => void;
  onReview: () => void;
  onSingleLocationChange: (locationId: string) => void;
  options: readonly LocationOption[];
  parsed: ParsedCsv;
  placementMode: CsvImportPlacement["mode"];
  singleLocationId: string;
}) {
  const placementName = useId();
  return <div className={styles.stageBody}>
    <div className={styles.fileSummary}>
      <FileSpreadsheet aria-hidden="true" />
      <span>
        <strong>{csvValuePreview(fileName)}</strong>
        <small>
          {countLabel(parsed.rows.length, "data row")} · {countLabel(
            parsed.columns.length,
            "column",
          )}
          {parsed.blankRecordCount
            ? ` · ${countLabel(parsed.blankRecordCount, "blank row")} ignored`
            : ""}
        </small>
      </span>
    </div>
    <section aria-labelledby="csv-item-columns-heading">
      <header className={styles.sectionHeading}>
        <h4 id="csv-item-columns-heading">Item columns</h4>
        <small>Review every guess before continuing.</small>
      </header>
      <div className={styles.mappingGrid}>
        {CSV_ITEM_FIELDS.map((field) => <ColumnSelect
          field={field}
          key={field}
          mapping={mapping}
          onChange={onColumnChange}
          parsed={parsed}
        />)}
      </div>
    </section>
    <fieldset className={styles.placement}>
      <legend>Place imported rows</legend>
      <div className={styles.modeChoices}>
        <label>
          <input
            checked={placementMode === "single"}
            name={placementName}
            onChange={() => onPlacementModeChange("single")}
            type="radio"
          />
          <span>
            <strong>One destination</strong>
            <small>Put every valid row in the same space.</small>
          </span>
        </label>
        <label>
          <input
            checked={placementMode === "column"}
            name={placementName}
            onChange={() => onPlacementModeChange("column")}
            type="radio"
          />
          <span>
            <strong>Location column</strong>
            <small>Resolve each distinct CSV value to a space.</small>
          </span>
        </label>
      </div>
      {placementMode === "single"
        ? <label className={styles.field}>
          <span>Destination <b>Required</b></span>
          <select
            name="csvSingleLocation"
            onChange={(event) => onSingleLocationChange(
              event.currentTarget.value,
            )}
            value={singleLocationId}
          >
            <option value="">Choose destination</option>
            {options.map((option) => <option
              key={option.id}
              value={option.id}
            >
              {option.label}
            </option>)}
          </select>
        </label>
        : <>
          <label className={styles.field}>
            <span>Location column <b>Required</b></span>
            <select
              name="csvLocationColumn"
              onChange={(event) => onLocationColumnChange(
                event.currentTarget.value === ""
                  ? null
                  : Number(event.currentTarget.value),
              )}
              value={locationColumn ?? ""}
            >
              <option value="">Choose a column</option>
              {parsed.columns.map((column) => <option
                key={column.index}
                value={column.index}
              >
                {csvColumnLabel(parsed, column.index)}
              </option>)}
            </select>
          </label>
          {locationColumn !== null && <LocationValueMappings
            assignments={assignments}
            groups={groups}
            key={locationColumn}
            onChange={onAssignmentChange}
            options={options}
          />}
        </>}
    </fieldset>
    {blockingIssues.length > 0 && <div
      className={styles.alert}
      data-tone="danger"
      role="alert"
    >
      <AlertCircle aria-hidden="true" />
      <span>
        <strong>Finish the mapping</strong>
        <small>{blockingIssues.join(" ")}</small>
      </span>
    </div>}
    <div className={styles.actions}>
      <button onClick={onBack} type="button">
        <ChevronLeft aria-hidden="true" /> Choose another file
      </button>
      <button
        className={styles.primary}
        disabled={blockingIssues.length > 0}
        onClick={onReview}
        type="button"
      >
        Review rows <ChevronRight aria-hidden="true" />
      </button>
    </div>
  </div>;
}

function ReviewStage({
  busy,
  locations,
  mapping,
  onBack,
  onCancel,
  onImport,
  onReviewRefresh,
  onReopenConfirmation,
  onSkipConfirmation,
  options,
  plan,
  reopenConfirmed,
  reviewStale,
  skipConfirmed,
  submitError,
}: {
  busy: boolean;
  locations: readonly Location[];
  mapping: CsvItemColumnMapping;
  onBack: () => void;
  onCancel: () => void;
  onImport: () => void;
  onReviewRefresh: () => void;
  onReopenConfirmation: (confirmed: boolean) => void;
  onSkipConfirmation: (confirmed: boolean) => void;
  options: readonly LocationOption[];
  plan: CsvImportPlan;
  reopenConfirmed: boolean;
  reviewStale: boolean;
  skipConfirmed: boolean;
  submitError: string;
}) {
  const locationById = new Map(locations.map((location) => [
    location.id,
    location,
  ]));
  const locationLabels = new Map(options.map((option) => [
    option.id,
    option.label,
  ]));
  const previewRows = plan.rows.slice(0, ROW_PREVIEW_LIMIT);
  const invalidPreview = plan.invalidRows.slice(0, ERROR_PREVIEW_LIMIT);
  const globalErrors = plan.mappingIssues.filter((candidate) =>
    candidate.severity === "error"
  );
  const needsSkipConfirmation = plan.invalidRows.length > 0;
  const needsReopenConfirmation = plan.completedDestinations.length > 0;
  const ready = !reviewStale && plan.canCommit &&
    (!needsSkipConfirmation || skipConfirmed) &&
    (!needsReopenConfirmation || reopenConfirmed) &&
    Boolean(plan.command);

  return <div className={styles.stageBody}>
    {reviewStale && <section className={styles.reviewRefresh} role="status">
      <Info aria-hidden="true" />
      <span>
        <strong>The workspace changed while this review was open</strong>
        <small>
          Counts and destinations were refreshed. Accept the refreshed review
          before confirming any skipped rows or reopened spaces again.
        </small>
      </span>
      <button onClick={onReviewRefresh} type="button">
        Accept refreshed review
      </button>
    </section>}
    <div className={styles.reviewSummary}>
      <span data-tone="ready">
        <strong>{plan.validRows.length}</strong>
        <small>Ready</small>
      </span>
      <span data-tone={plan.invalidRows.length ? "warning" : "ready"}>
        <strong>{plan.invalidRows.length}</strong>
        <small>Invalid</small>
      </span>
      <span>
        <strong>{plan.destinations.length}</strong>
        <small>Destinations</small>
      </span>
    </div>
    {globalErrors.length > 0 && <div
      className={styles.alert}
      data-tone="danger"
      role="alert"
    >
      <AlertCircle aria-hidden="true" />
      <span>
        <strong>Import is not ready</strong>
        <small>{globalErrors.map((candidate) =>
          candidate.message
        ).join(" ")}</small>
      </span>
    </div>}
    {plan.quota && <section className={styles.quota}>
      <header>
        <h4>Workspace capacity</h4>
        <small>Projected after safe history compaction</small>
      </header>
      <div>
        <span>
          <strong>
            {plan.quota.projectedUsage.itemsPerSnapshot.toLocaleString()}
            {" / "}
            {API_QUOTAS.itemsPerSnapshot.toLocaleString()}
          </strong>
          <small>Item records</small>
        </span>
        <span>
          <strong>
            {formatBytes(plan.quota.projectedUsage.storedSnapshotBytes)}
            {" / "}
            {formatBytes(API_QUOTAS.storedSnapshotBytes)}
          </strong>
          <small>Stored snapshot</small>
        </span>
      </div>
    </section>}
    {plan.quota?.violation && <div
      className={styles.alert}
      data-tone="danger"
      role="alert"
    >
      <AlertCircle aria-hidden="true" />
      <span>
        <strong>Workspace limit reached</strong>
        <small>{plan.quota.violation.message}.</small>
      </span>
    </div>}
    {plan.quota?.historyWillBeCompacted && !plan.quota.violation && <div
      className={styles.alert}
      data-tone="info"
    >
      <Info aria-hidden="true" />
      <span>
        <strong>Some older Activity detail will retire online</strong>
        <small>
          The new import remains one undoable Activity entry. Older compacted
          command receipts still prevent duplicate sync application.
        </small>
      </span>
    </div>}
    {plan.completedDestinations.length > 0 && <section
      className={styles.confirmation}
      data-tone="warning"
    >
      <header>
        <AlertCircle aria-hidden="true" />
        <span>
          <strong>Completed spaces will reopen</strong>
          <small>
            Adding records changes the confirmed contents of these spaces.
          </small>
        </span>
      </header>
      <ul>
        {plan.completedDestinations.map((location) => <li key={location.id}>
          <strong>{location.code} · {location.name}</strong>
          <span>{location.captureStatus.replace("_", " ")} → in progress</span>
        </li>)}
      </ul>
      <label>
        <input
          checked={!reviewStale && reopenConfirmed}
          name="csvReopenCompleted"
          onChange={(event) => onReopenConfirmation(
            event.currentTarget.checked,
          )}
          type="checkbox"
        />
        <span>
          Reopen {countLabel(
            plan.completedDestinations.length,
            "completed space",
          )} as part of this import
        </span>
      </label>
    </section>}
    <section className={styles.destinations}>
      <header>
        <h4>Destinations</h4>
        <small>Similar-looking rows remain separate item records.</small>
      </header>
      <ul>
        {plan.destinations.map((destination) => <li
          key={destination.location.id}
        >
          <span>
            <strong>
              {destination.location.code} · {destination.location.name}
            </strong>
            <small>{locationPath(locationById, destination.location)}</small>
          </span>
          <b>{countLabel(destination.count, "record")}</b>
        </li>)}
      </ul>
    </section>
    <section aria-labelledby="csv-row-preview-heading">
      <header className={styles.sectionHeading}>
        <h4 id="csv-row-preview-heading">Row preview</h4>
        <small>
          Showing {previewRows.length} of {plan.rows.length} non-blank rows
        </small>
      </header>
      <div
        aria-label="CSV row preview table"
        className={styles.tableWrap}
        role="region"
        tabIndex={0}
      >
        <table>
          <thead>
            <tr>
              <th scope="col">CSV row</th>
              <th scope="col">Item</th>
              <th scope="col">Quantity</th>
              <th scope="col">Destination</th>
              <th scope="col">Result</th>
            </tr>
          </thead>
          <tbody>
            {previewRows.map((row) => <tr
              data-valid={row.item ? "true" : "false"}
              key={row.recordNumber}
            >
              <th scope="row">{row.recordNumber}</th>
              <td>{csvValuePreview(
                row.item?.name ??
                  row.source.cells[mapping.name ?? -1] ??
                  "",
              ) || "Blank"}</td>
              <td>{row.item?.quantity ?? (
                csvValuePreview(
                  row.source.cells[mapping.quantity ?? -1] ?? "",
                ) || "Default"
              )}</td>
              <td>{row.destinationId
                ? csvValuePreview(
                  locationLabels.get(row.destinationId) ?? "Unknown space",
                )
                : "Unresolved"}</td>
              <td>{row.item
                ? <span className={styles.readyText}>
                  <CheckCircle2 aria-hidden="true" /> Ready
                </span>
                : row.issues.map((candidate) => candidate.message).join("; ")}
              </td>
            </tr>)}
          </tbody>
        </table>
      </div>
    </section>
    {invalidPreview.length > 0 && <section className={styles.invalidRows}>
      <header>
        <h4>Rows that will not be imported</h4>
        <small>
          Review the source row numbers and reasons before choosing to skip.
        </small>
      </header>
      <ul>
        {invalidPreview.map((row) => <li key={row.recordNumber}>
          <strong>Row {row.recordNumber}</strong>
          <span>{row.issues.map((candidate) =>
            candidate.message
          ).join("; ")}</span>
        </li>)}
      </ul>
      {plan.invalidRows.length > invalidPreview.length && <p>
        {countLabel(
          plan.invalidRows.length - invalidPreview.length,
          "additional invalid row",
        )} are summarized but not rendered here.
      </p>}
      <label className={styles.acknowledgement}>
        <input
          checked={!reviewStale && skipConfirmed}
          name="csvSkipInvalid"
          onChange={(event) => onSkipConfirmation(
            event.currentTarget.checked,
          )}
          type="checkbox"
        />
        <span>
          Skip these {countLabel(plan.invalidRows.length, "invalid row")}
          {" "}and import only the ready records
        </span>
      </label>
    </section>}
    {submitError && <div className={styles.alert} data-tone="danger" role="alert">
      <AlertCircle aria-hidden="true" />
      <span>
        <strong>Import was not committed</strong>
        <small>{submitError}</small>
      </span>
    </div>}
    <div className={styles.actions} data-three="true">
      <button disabled={busy} onClick={onBack} type="button">
        <ChevronLeft aria-hidden="true" /> Back to mapping
      </button>
      <button disabled={busy} onClick={onCancel} type="button">Cancel</button>
      <button
        className={styles.primary}
        disabled={!ready || busy}
        onClick={onImport}
        type="button"
      >
        {busy
          ? "Importing..."
          : `Import ${countLabel(plan.validRows.length, "item record")}`}
      </button>
    </div>
  </div>;
}

export function CsvImportDialog({
  commit,
  onImported,
  preferredLocationId,
  state,
}: CsvImportDialogProps) {
  const [open, setOpen] = useState(false);
  const [stage, setStage] = useState<ImportStage>("file");
  const [parsed, setParsed] = useState<ParsedCsv | null>(null);
  const [fileName, setFileName] = useState("");
  const [mapping, setMapping] = useState<CsvItemColumnMapping>(
    emptyCsvItemMapping,
  );
  const [placementMode, setPlacementMode] =
    useState<CsvImportPlacement["mode"]>("single");
  const [singleLocationId, setSingleLocationId] = useState("");
  const [locationColumn, setLocationColumn] = useState<number | null>(null);
  const [assignments, setAssignments] = useState<Record<string, string>>({});
  const [rowIds, setRowIds] = useState<Record<number, string>>({});
  const [preparedAt, setPreparedAt] = useState("");
  const [previewCommandId, setPreviewCommandId] = useState("");
  const [fileError, setFileError] = useState("");
  const [reading, setReading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [skipConfirmed, setSkipConfirmed] = useState(false);
  const [reopenConfirmed, setReopenConfirmed] = useState(false);
  const [submitError, setSubmitError] = useState("");
  const [reviewedSignature, setReviewedSignature] = useState<string | null>(
    null,
  );
  const triggerRef = useRef<HTMLButtonElement>(null);
  const stageHeadingRef = useRef<HTMLHeadingElement>(null);
  const readSequence = useRef(0);
  const busyRef = useRef(false);
  const options = useMemo(
    () => locationOptions(state.locations),
    [state.locations],
  );
  const groups = useMemo(() =>
    parsed && locationColumn !== null
      ? csvLocationValueGroups(parsed, locationColumn, state.locations)
      : [],
  [locationColumn, parsed, state.locations]);
  const placement = useMemo<CsvImportPlacement>(() =>
    placementMode === "single"
      ? { locationId: singleLocationId || null, mode: "single" }
      : { assignments, column: locationColumn, mode: "column" },
  [assignments, locationColumn, placementMode, singleLocationId]);
  const plan = useMemo(() =>
    parsed && preparedAt && previewCommandId
      ? planCsvImport({
          commandId: previewCommandId,
          mapping,
          parsed,
          placement,
          rowIds,
          state,
          timestamp: preparedAt,
        })
      : null,
  [
    mapping,
    parsed,
    placement,
    preparedAt,
    previewCommandId,
    rowIds,
    state,
  ]);
  const blockingIssues = plan?.mappingIssues.filter((candidate) =>
    BLOCKING_MAPPING_ISSUES.has(candidate.code)
  ).map((candidate) => candidate.message) ?? [];
  const reviewSignature = useMemo(() => {
    if (!plan) return "";
    return JSON.stringify({
      completed: plan.completedDestinations.map((location) => [
        location.id,
        location.captureStatus,
      ]),
      invalid: plan.invalidRows.map((row) => [
        row.recordNumber,
        row.issues.map((candidate) => candidate.code),
      ]),
      items: plan.command?.items.map((item) => [
        item.id,
        item.locationId,
        item.order,
      ]) ?? [],
      quota: plan.quota?.violation,
      revision: state.workspace.revision,
    });
  }, [plan, state.workspace.revision]);
  const reviewStale = stage === "review" &&
    reviewedSignature !== null &&
    Boolean(reviewSignature) &&
    reviewSignature !== reviewedSignature;

  useEffect(() => {
    if (!open) return;
    const frame = requestAnimationFrame(() => {
      stageHeadingRef.current?.focus({ preventScroll: true });
    });
    return () => cancelAnimationFrame(frame);
  }, [open, stage]);

  const resetImport = () => {
    readSequence.current += 1;
    setStage("file");
    setParsed(null);
    setFileName("");
    setMapping(emptyCsvItemMapping());
    setPlacementMode("single");
    setSingleLocationId("");
    setLocationColumn(null);
    setAssignments({});
    setRowIds({});
    setPreparedAt("");
    setPreviewCommandId("");
    setFileError("");
    setReading(false);
    setSkipConfirmed(false);
    setReopenConfirmed(false);
    setSubmitError("");
    setReviewedSignature(null);
  };

  const close = () => {
    if (busyRef.current) return;
    setOpen(false);
    resetImport();
  };

  const openDialog = () => {
    resetImport();
    setOpen(true);
  };

  const chooseFile = async (event: ChangeEvent<HTMLInputElement>) => {
    const input = event.currentTarget;
    const file = input.files?.[0];
    input.value = "";
    if (!file) return;
    const sequence = ++readSequence.current;
    setReading(true);
    setFileError("");
    try {
      if (file.size > CSV_IMPORT_MAX_FILE_BYTES) {
        throw new Error(
          `Choose a CSV no larger than ${formatBytes(
            CSV_IMPORT_MAX_FILE_BYTES,
          )}`,
        );
      }
      const bytes = await file.arrayBuffer();
      if (sequence !== readSequence.current) return;
      if (bytes.byteLength > CSV_IMPORT_MAX_FILE_BYTES) {
        throw new Error(
          `Choose a CSV no larger than ${formatBytes(
            CSV_IMPORT_MAX_FILE_BYTES,
          )}`,
        );
      }
      let text: string;
      try {
        text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      } catch {
        throw new Error("Choose a CSV saved as valid UTF-8 text");
      }
      const nextParsed = parseCsv(text);
      const guessed = guessCsvColumns(nextParsed);
      const nextMapping: CsvItemColumnMapping = {
        category: guessed.category,
        description: guessed.description,
        frequency: guessed.frequency,
        name: guessed.name,
        quantity: guessed.quantity,
        tags: guessed.tags,
        unit: guessed.unit,
      };
      const preferred = options.find((option) =>
        option.id === preferredLocationId
      )?.id ?? options[0]?.id ?? "";
      const nextGroups = guessed.location === null
        ? []
        : csvLocationValueGroups(
            nextParsed,
            guessed.location,
            state.locations,
          );
      setParsed(nextParsed);
      setFileName(file.name);
      setMapping(nextMapping);
      setPlacementMode(guessed.location === null ? "single" : "column");
      setSingleLocationId(preferred);
      setLocationColumn(guessed.location);
      setAssignments(suggestedCsvLocationAssignments(nextGroups));
      setRowIds(Object.fromEntries(nextParsed.rows.map((row) => [
        row.recordNumber,
        newId("item"),
      ])));
      setPreparedAt(nowIso());
      setPreviewCommandId(newId("cmd"));
      setSkipConfirmed(false);
      setReopenConfirmed(false);
      setSubmitError("");
      setReviewedSignature(null);
      setStage("map");
    } catch (error) {
      if (sequence === readSequence.current) {
        setFileError(parseProblem(error));
      }
    } finally {
      if (sequence === readSequence.current) setReading(false);
    }
  };

  const changeLocationColumn = (columnIndex: number | null) => {
    setLocationColumn(columnIndex);
    setAssignments(
      parsed && columnIndex !== null
        ? suggestedCsvLocationAssignments(
            csvLocationValueGroups(parsed, columnIndex, state.locations),
          )
        : {},
    );
  };

  const review = () => {
    if (!plan || blockingIssues.length) return;
    setSkipConfirmed(false);
    setReopenConfirmed(false);
    setSubmitError("");
    setReviewedSignature(reviewSignature);
    setStage("review");
  };

  const importRows = async () => {
    const command = plan?.command as BulkCreateCommand | null;
    const ready = Boolean(
      plan?.canCommit &&
      command &&
      !reviewStale &&
      (!plan.invalidRows.length || skipConfirmed) &&
      (!plan.completedDestinations.length || reopenConfirmed),
    );
    if (!ready || !command || busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setSubmitError("");
    try {
      await commit(command);
      const count = command.items.length;
      setOpen(false);
      resetImport();
      onImported(count);
    } catch (error) {
      setSubmitError(
        error instanceof Error && error.message
          ? error.message
          : "The import could not be committed",
      );
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  };

  const stageTitle = stage === "file"
    ? "Choose a CSV file"
    : stage === "map"
      ? "Map inventory columns"
      : "Review and commit";

  return <>
    <button
      className={styles.trigger}
      onClick={openDialog}
      ref={triggerRef}
      type="button"
    >
      <FileUp aria-hidden="true" />
      <span>Import CSV</span>
    </button>
    <ModalDialog
      busy={busy || reading}
      description={<p>
        Add item records without replacing existing inventory. The final
        import is one local-first, undoable Activity change.
      </p>}
      mobileSheet="full"
      onClose={close}
      open={open}
      returnFocusRef={triggerRef}
      title="Import inventory from CSV"
    >
      <StageIndicator stage={stage} />
      <header className={styles.stageHeading}>
        <p>Step {stage === "file" ? 1 : stage === "map" ? 2 : 3} of 3</p>
        <h3 ref={stageHeadingRef} tabIndex={-1}>{stageTitle}</h3>
      </header>
      {stage === "file" && <FileStage
        activeLocationCount={options.length}
        error={fileError}
        onCancel={close}
        onFile={(event) => void chooseFile(event)}
        reading={reading}
      />}
      {stage === "map" && parsed && <MappingStage
        assignments={assignments}
        blockingIssues={blockingIssues}
        fileName={fileName}
        groups={groups}
        locationColumn={locationColumn}
        mapping={mapping}
        onAssignmentChange={(key, locationId) => setAssignments((current) => ({
          ...current,
          [key]: locationId,
        }))}
        onBack={resetImport}
        onColumnChange={(field, columnIndex) => setMapping((current) => ({
          ...current,
          [field]: columnIndex,
        }))}
        onLocationColumnChange={changeLocationColumn}
        onPlacementModeChange={setPlacementMode}
        onReview={review}
        onSingleLocationChange={setSingleLocationId}
        options={options}
        parsed={parsed}
        placementMode={placementMode}
        singleLocationId={singleLocationId}
      />}
      {stage === "review" && plan && <ReviewStage
        busy={busy}
        locations={state.locations}
        mapping={mapping}
        onBack={() => {
          setStage("map");
          setReviewedSignature(null);
        }}
        onCancel={close}
        onImport={() => void importRows()}
        onReviewRefresh={() => {
          setReviewedSignature(reviewSignature);
          setSkipConfirmed(false);
          setReopenConfirmed(false);
          setSubmitError("");
        }}
        onReopenConfirmation={setReopenConfirmed}
        onSkipConfirmation={setSkipConfirmed}
        options={options}
        plan={plan}
        reopenConfirmed={reopenConfirmed}
        reviewStale={reviewStale}
        skipConfirmed={skipConfirmed}
        submitError={submitError}
      />}
    </ModalDialog>
  </>;
}
