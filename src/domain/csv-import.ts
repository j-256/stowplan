import { applyCommand } from "./commands";
import {
    createEnvelope,
    createItem,
} from "./factories";
import { compactWorkspaceHistory } from "./history-retention";
import {
    SNAPSHOT_QUOTA_ORDER,
    serializedJsonBytes,
    snapshotQuotaUsage,
    type SnapshotQuotaUsage,
} from "./snapshot-quota-usage";
import type {
    Command,
    Frequency,
    ItemRecord,
    Location,
    WorkspaceState,
} from "./types";
import {
    API_QUOTAS,
    type ApiQuotaName,
} from "../shared/api-quotas";

export const CSV_IMPORT_MAX_FILE_BYTES = 4 * 1_024 * 1_024;
export const CSV_IMPORT_MAX_DATA_ROWS = API_QUOTAS.itemsPerSnapshot;
export const CSV_IMPORT_MAX_COLUMNS = 64;
export const CSV_IMPORT_MAX_CELL_CHARACTERS = 32_768;
export const CSV_IMPORT_VALUE_PREVIEW_CHARACTERS = 120;

export const CSV_ITEM_FIELDS = Object.freeze([
    "name",
    "quantity",
    "unit",
    "category",
    "description",
    "tags",
    "frequency",
] as const);

export type CsvItemField = typeof CSV_ITEM_FIELDS[number];

export type CsvItemColumnMapping = Record<CsvItemField, number | null>;

export interface CsvColumn {
    header: string;
    index: number;
}

export interface CsvDataRow {
    cells: string[];
    recordNumber: number;
}

export interface ParsedCsv {
    blankRecordCount: number;
    columns: CsvColumn[];
    headerRecordNumber: number;
    rows: CsvDataRow[];
}

export interface CsvParseLimits {
    cellCharacters: number;
    columns: number;
    dataRows: number;
    fileBytes: number;
}

export type CsvParseErrorCode =
    | "CELL_TOO_LARGE"
    | "EMPTY_FILE"
    | "FILE_TOO_LARGE"
    | "TOO_MANY_COLUMNS"
    | "TOO_MANY_ROWS"
    | "TRAILING_QUOTE_CONTENT"
    | "UNCLOSED_QUOTE"
    | "UNEXPECTED_QUOTE";

export class CsvParseError extends Error {
    readonly code: CsvParseErrorCode;
    readonly column: number;
    readonly line: number;

    constructor(
        code: CsvParseErrorCode,
        message: string,
        line: number,
        column: number,
    ) {
        super(message);
        this.name = "CsvParseError";
        this.code = code;
        this.column = column;
        this.line = line;
    }
}

export interface CsvGuessedColumns extends CsvItemColumnMapping {
    location: number | null;
}

export type CsvImportPlacement =
    | {
          locationId: string | null;
          mode: "single";
      }
    | {
          assignments: Readonly<Record<string, string>>;
          column: number | null;
          mode: "column";
      };

export interface CsvLocationMatch {
    ambiguous: boolean;
    locationId: string | null;
    matchedBy: "code" | "name" | "path" | null;
}

export interface CsvLocationValueGroup extends CsvLocationMatch {
    count: number;
    key: string;
    label: string;
    recordNumbers: number[];
}

export interface CsvImportIssue {
    code: string;
    field: CsvItemField | "location" | "row" | null;
    message: string;
    recordNumber: number | null;
    severity: "error" | "warning";
}

export interface CsvImportRowPlan {
    destinationId: string | null;
    issues: CsvImportIssue[];
    item: ItemRecord | null;
    recordNumber: number;
    source: CsvDataRow;
}

export interface CsvImportDestinationSummary {
    count: number;
    location: Location;
}

export interface CsvImportQuotaViolation {
    actual: number;
    limit: number;
    message: string;
    quota: Extract<ApiQuotaName, keyof SnapshotQuotaUsage>;
}

export interface CsvImportQuotaProjection {
    historyWillBeCompacted: boolean;
    previousUsage: SnapshotQuotaUsage;
    projectedUsage: SnapshotQuotaUsage;
    rawUsage: SnapshotQuotaUsage;
    violation: CsvImportQuotaViolation | null;
}

export interface CsvImportPlan {
    canCommit: boolean;
    command: Extract<Command, { type: "item.bulkCreate" }> | null;
    completedDestinations: Location[];
    destinations: CsvImportDestinationSummary[];
    invalidRows: CsvImportRowPlan[];
    issues: CsvImportIssue[];
    mappingIssues: CsvImportIssue[];
    parsed: ParsedCsv;
    quota: CsvImportQuotaProjection | null;
    rows: CsvImportRowPlan[];
    validRows: CsvImportRowPlan[];
}

export interface PlanCsvImportOptions {
    commandId: string;
    mapping: CsvItemColumnMapping;
    parsed: ParsedCsv;
    placement: CsvImportPlacement;
    rowIds: Readonly<Record<number, string>>;
    state: WorkspaceState;
    timestamp: string;
}

const DEFAULT_PARSE_LIMITS: Readonly<CsvParseLimits> = Object.freeze({
    cellCharacters: CSV_IMPORT_MAX_CELL_CHARACTERS,
    columns: CSV_IMPORT_MAX_COLUMNS,
    dataRows: CSV_IMPORT_MAX_DATA_ROWS,
    fileBytes: CSV_IMPORT_MAX_FILE_BYTES,
});

const HEADER_ALIASES: Readonly<Record<keyof CsvGuessedColumns, readonly string[]>> =
    Object.freeze({
        category: ["category", "group", "item category", "type"],
        description: ["description", "details", "note", "notes"],
        frequency: ["frequency", "usage", "usage frequency", "used"],
        location: [
            "container",
            "container code",
            "location",
            "location code",
            "space",
            "storage location",
        ],
        name: ["item", "item name", "name", "product", "title"],
        quantity: ["amount", "count", "qty", "quantity"],
        tags: ["keywords", "labels", "tags"],
        unit: ["measurement unit", "unit", "units", "uom"],
    });

const FREQUENCIES = new Set<Frequency>([
    "daily",
    "weekly",
    "monthly",
    "rarely",
]);

const POSITIVE_DECIMAL = /^(?:\d+(?:\.\d*)?|\.\d+)$/;

function positiveLimit(value: number, name: string): number {
    if (!Number.isSafeInteger(value) || value < 1) {
        throw new Error(`${name} must be a positive safe integer`);
    }
    return value;
}

function parseLimits(
    overrides: Partial<CsvParseLimits>,
): CsvParseLimits {
    return {
        cellCharacters: positiveLimit(
            overrides.cellCharacters ?? DEFAULT_PARSE_LIMITS.cellCharacters,
            "CSV cell limit",
        ),
        columns: positiveLimit(
            overrides.columns ?? DEFAULT_PARSE_LIMITS.columns,
            "CSV column limit",
        ),
        dataRows: positiveLimit(
            overrides.dataRows ?? DEFAULT_PARSE_LIMITS.dataRows,
            "CSV row limit",
        ),
        fileBytes: positiveLimit(
            overrides.fileBytes ?? DEFAULT_PARSE_LIMITS.fileBytes,
            "CSV file limit",
        ),
    };
}

function newlineWidth(value: string, index: number): number {
    if (value[index] === "\r" && value[index + 1] === "\n") return 2;
    return 1;
}

function isNewline(value: string): boolean {
    return value === "\r" || value === "\n";
}

export function parseCsv(
    input: string,
    limitOverrides: Partial<CsvParseLimits> = {},
): ParsedCsv {
    const limits = parseLimits(limitOverrides);
    const inputBytes = new TextEncoder().encode(input).byteLength;
    if (inputBytes > limits.fileBytes) {
        throw new CsvParseError(
            "FILE_TOO_LARGE",
            `CSV file exceeds the ${limits.fileBytes}-byte limit`,
            1,
            1,
        );
    }
    const value = input.startsWith("\ufeff") ? input.slice(1) : input;
    let afterQuote = false;
    let blankRecordCount = 0;
    let column = 1;
    let field = "";
    let fieldWasQuoted = false;
    let header: CsvDataRow | null = null;
    let inQuotes = false;
    let index = 0;
    let line = 1;
    let recordNumber = 1;
    let row: string[] = [];
    const rows: CsvDataRow[] = [];

    const append = (character: string) => {
        field += character;
        if (field.length > limits.cellCharacters) {
            throw new CsvParseError(
                "CELL_TOO_LARGE",
                `CSV cell exceeds the ${limits.cellCharacters}-character limit`,
                line,
                column,
            );
        }
    };
    const finishField = () => {
        if (row.length >= limits.columns) {
            throw new CsvParseError(
                "TOO_MANY_COLUMNS",
                `CSV record exceeds the ${limits.columns}-column limit`,
                line,
                column,
            );
        }
        row.push(field);
        field = "";
        fieldWasQuoted = false;
        afterQuote = false;
    };
    const finishRecord = () => {
        finishField();
        const record: CsvDataRow = { cells: row, recordNumber };
        const blank = record.cells.every((cell) => !cell.trim());
        if (blank) {
            blankRecordCount += 1;
        } else if (!header) {
            header = record;
        } else {
            rows.push(record);
            if (rows.length > limits.dataRows) {
                throw new CsvParseError(
                    "TOO_MANY_ROWS",
                    `CSV file exceeds the ${limits.dataRows}-row limit`,
                    line,
                    column,
                );
            }
        }
        row = [];
        recordNumber += 1;
    };
    const advanceNewline = (width: number) => {
        index += width;
        line += 1;
        column = 1;
    };

    while (index < value.length) {
        const character = value[index]!;
        if (inQuotes) {
            if (character === '"') {
                if (value[index + 1] === '"') {
                    append('"');
                    index += 2;
                    column += 2;
                } else {
                    inQuotes = false;
                    afterQuote = true;
                    index += 1;
                    column += 1;
                }
                continue;
            }
            if (isNewline(character)) {
                append("\n");
                advanceNewline(newlineWidth(value, index));
                continue;
            }
            append(character);
            index += 1;
            column += 1;
            continue;
        }

        if (afterQuote) {
            if (character === " " || character === "\t") {
                index += 1;
                column += 1;
                continue;
            }
            if (character === ",") {
                finishField();
                index += 1;
                column += 1;
                continue;
            }
            if (isNewline(character)) {
                finishRecord();
                advanceNewline(newlineWidth(value, index));
                continue;
            }
            throw new CsvParseError(
                "TRAILING_QUOTE_CONTENT",
                "CSV field has content after its closing quote",
                line,
                column,
            );
        }

        if (character === '"') {
            if (field.length > 0) {
                throw new CsvParseError(
                    "UNEXPECTED_QUOTE",
                    "CSV quote must begin a field",
                    line,
                    column,
                );
            }
            inQuotes = true;
            fieldWasQuoted = true;
            index += 1;
            column += 1;
            continue;
        }
        if (character === ",") {
            finishField();
            index += 1;
            column += 1;
            continue;
        }
        if (isNewline(character)) {
            finishRecord();
            advanceNewline(newlineWidth(value, index));
            continue;
        }
        append(character);
        index += 1;
        column += 1;
    }

    if (inQuotes) {
        throw new CsvParseError(
            "UNCLOSED_QUOTE",
            "CSV field has an unclosed quote",
            line,
            column,
        );
    }
    if (row.length || field.length || fieldWasQuoted || afterQuote) {
        finishRecord();
    }
    if (!header) {
        throw new CsvParseError(
            "EMPTY_FILE",
            "CSV file needs a non-blank header record",
            line,
            column,
        );
    }
    const parsedHeader = header as CsvDataRow;
    return {
        blankRecordCount,
        columns: parsedHeader.cells.map((cell, columnIndex) => ({
            header: cell.trim(),
            index: columnIndex,
        })),
        headerRecordNumber: parsedHeader.recordNumber,
        rows,
    };
}

function normalizedWords(value: string): string {
    return value
        .trim()
        .toLocaleLowerCase()
        .replace(/[^a-z0-9]+/g, " ")
        .trim();
}

export function emptyCsvItemMapping(): CsvItemColumnMapping {
    return {
        category: null,
        description: null,
        frequency: null,
        name: null,
        quantity: null,
        tags: null,
        unit: null,
    };
}

export function guessCsvColumns(parsed: ParsedCsv): CsvGuessedColumns {
    const guessed: CsvGuessedColumns = {
        ...emptyCsvItemMapping(),
        location: null,
    };
    const used = new Set<number>();
    for (const field of [...CSV_ITEM_FIELDS, "location"] as const) {
        const aliases = new Set(HEADER_ALIASES[field]);
        const column = parsed.columns.find((candidate) =>
            !used.has(candidate.index) &&
            aliases.has(normalizedWords(candidate.header))
        );
        if (!column) continue;
        guessed[field] = column.index;
        used.add(column.index);
    }
    return guessed;
}

export function csvLocationValueKey(value: string): string {
    return value.trim().toLocaleLowerCase().replace(/\s+/g, " ");
}

export function csvValuePreview(
    value: string,
    maximumCharacters = CSV_IMPORT_VALUE_PREVIEW_CHARACTERS,
): string {
    const normalized = value.trim().replace(/\s+/g, " ");
    if (normalized.length <= maximumCharacters) return normalized;
    return `${normalized.slice(0, maximumCharacters - 3)}...`;
}

function normalizedPath(value: string): string {
    return csvLocationValueKey(value)
        .replace(/\s*(?:›|>|\/|\\)\s*/g, "/");
}

function activeLocations(locations: readonly Location[]): Location[] {
    return locations.filter((location) => !location.archivedAt);
}

function locationNamePath(
    locations: readonly Location[],
    location: Location,
): string {
    const byId = new Map(locations.map((candidate) => [
        candidate.id,
        candidate,
    ]));
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
    return names.join("/");
}

function uniqueLocationMatch(
    matches: readonly Location[],
    matchedBy: Exclude<CsvLocationMatch["matchedBy"], null>,
): CsvLocationMatch | null {
    if (!matches.length) return null;
    if (matches.length > 1) {
        return { ambiguous: true, locationId: null, matchedBy: null };
    }
    return {
        ambiguous: false,
        locationId: matches[0]!.id,
        matchedBy,
    };
}

export function matchCsvLocation(
    value: string,
    locations: readonly Location[],
): CsvLocationMatch {
    const normalized = csvLocationValueKey(value);
    if (!normalized) {
        return { ambiguous: false, locationId: null, matchedBy: null };
    }
    const active = activeLocations(locations);
    const byCode = uniqueLocationMatch(
        active.filter((location) =>
            csvLocationValueKey(location.code) === normalized
        ),
        "code",
    );
    if (byCode) return byCode;
    const path = normalizedPath(value);
    const byPath = uniqueLocationMatch(
        active.filter((location) =>
            normalizedPath(locationNamePath(active, location)) === path
        ),
        "path",
    );
    if (byPath) return byPath;
    const byName = uniqueLocationMatch(
        active.filter((location) =>
            csvLocationValueKey(location.name) === normalized
        ),
        "name",
    );
    return byName ?? {
        ambiguous: false,
        locationId: null,
        matchedBy: null,
    };
}

export function csvLocationValueGroups(
    parsed: ParsedCsv,
    columnIndex: number,
    locations: readonly Location[],
): CsvLocationValueGroup[] {
    if (
        !Number.isInteger(columnIndex) ||
        columnIndex < 0 ||
        columnIndex >= parsed.columns.length
    ) {
        return [];
    }
    const groups = new Map<string, {
        count: number;
        label: string;
        recordNumbers: number[];
    }>();
    for (const row of parsed.rows) {
        const raw = row.cells[columnIndex] ?? "";
        const key = csvLocationValueKey(raw);
        const group = groups.get(key);
        if (group) {
            group.count += 1;
            group.recordNumbers.push(row.recordNumber);
        } else {
            groups.set(key, {
                count: 1,
                label: raw.trim() || "Blank location",
                recordNumbers: [row.recordNumber],
            });
        }
    }
    return [...groups.entries()].map(([key, group]) => ({
        ...group,
        ...matchCsvLocation(key ? group.label : "", locations),
        key,
    }));
}

export function suggestedCsvLocationAssignments(
    groups: readonly CsvLocationValueGroup[],
): Record<string, string> {
    return Object.fromEntries(groups.flatMap((group) =>
        group.locationId ? [[group.key, group.locationId]] : []
    ));
}

function issue(
    code: string,
    message: string,
    options: {
        field?: CsvImportIssue["field"];
        recordNumber?: number | null;
        severity?: CsvImportIssue["severity"];
    } = {},
): CsvImportIssue {
    return {
        code,
        field: options.field ?? null,
        message,
        recordNumber: options.recordNumber ?? null,
        severity: options.severity ?? "error",
    };
}

function validColumnIndex(
    value: number | null,
    parsed: ParsedCsv,
): value is number {
    return value !== null &&
        Number.isInteger(value) &&
        value >= 0 &&
        value < parsed.columns.length;
}

function mappingIssues(
    parsed: ParsedCsv,
    mapping: CsvItemColumnMapping,
    placement: CsvImportPlacement,
    state: WorkspaceState,
): CsvImportIssue[] {
    const issues: CsvImportIssue[] = [];
    if (!parsed.rows.length) {
        issues.push(issue(
            "NO_DATA_ROWS",
            "CSV file has no non-blank item rows",
            { field: "row" },
        ));
    }
    for (const field of CSV_ITEM_FIELDS) {
        const columnIndex = mapping[field];
        if (field === "name" && columnIndex === null) {
            issues.push(issue(
                "NAME_COLUMN_REQUIRED",
                "Choose the CSV column containing item names",
                { field },
            ));
        } else if (
            columnIndex !== null &&
            !validColumnIndex(columnIndex, parsed)
        ) {
            issues.push(issue(
                "INVALID_COLUMN",
                `Choose an available CSV column for ${field}`,
                { field },
            ));
        }
    }
    if (placement.mode === "single") {
        const location = state.locations.find((candidate) =>
            candidate.id === placement.locationId &&
            !candidate.archivedAt
        );
        if (!location) {
            issues.push(issue(
                "DESTINATION_REQUIRED",
                "Choose an active destination for imported rows",
                { field: "location" },
            ));
        }
    } else if (!validColumnIndex(placement.column, parsed)) {
        issues.push(issue(
            "LOCATION_COLUMN_REQUIRED",
            "Choose the CSV column containing location values",
            { field: "location" },
        ));
    }
    const mapped: Array<{
        field: CsvItemField | "location";
        index: number;
    }> = CSV_ITEM_FIELDS.flatMap((field) =>
        validColumnIndex(mapping[field], parsed)
            ? [{ field, index: mapping[field] as number }]
            : []
    );
    if (
        placement.mode === "column" &&
        validColumnIndex(placement.column, parsed)
    ) {
        mapped.push({ field: "location", index: placement.column });
    }
    const byIndex = new Map<number, string[]>();
    for (const entry of mapped) {
        const fields = byIndex.get(entry.index) ?? [];
        fields.push(entry.field);
        byIndex.set(entry.index, fields);
    }
    for (const [columnIndex, fields] of byIndex) {
        if (fields.length < 2) continue;
        const column = parsed.columns[columnIndex];
        issues.push(issue(
            "DUPLICATE_COLUMN_MAPPING",
            `${csvValuePreview(column?.header ?? "") || `Column ${columnIndex + 1}`} is mapped to ${
                fields.join(" and ")
            }`,
            { field: fields[0] as CsvImportIssue["field"] },
        ));
    }
    return issues;
}

function rowCell(
    row: CsvDataRow,
    columnIndex: number | null,
): string {
    return columnIndex === null ? "" : row.cells[columnIndex] ?? "";
}

function parseQuantity(value: string): number | null {
    const normalized = value.trim();
    if (!normalized) return 1;
    if (!POSITIVE_DECIMAL.test(normalized)) return null;
    const quantity = Number(normalized);
    return Number.isFinite(quantity) && quantity > 0 ? quantity : null;
}

function parseFrequency(value: string): Frequency | null {
    const normalized = value.trim().toLocaleLowerCase();
    if (!normalized) return "monthly";
    return FREQUENCIES.has(normalized as Frequency)
        ? normalized as Frequency
        : null;
}

function parseTags(value: string): string[] {
    const seen = new Set<string>();
    const tags: string[] = [];
    for (const candidate of value.split(/[|;,]/)) {
        const tag = candidate.trim();
        const key = tag.toLocaleLowerCase();
        if (!tag || seen.has(key)) continue;
        seen.add(key);
        tags.push(tag);
    }
    return tags;
}

function rowDestination(
    row: CsvDataRow,
    placement: CsvImportPlacement,
    state: WorkspaceState,
): { issue: CsvImportIssue | null; locationId: string | null } {
    if (placement.mode === "single") {
        const location = state.locations.find((candidate) =>
            candidate.id === placement.locationId &&
            !candidate.archivedAt
        );
        return { issue: null, locationId: location?.id ?? null };
    }
    if (placement.column === null) {
        return { issue: null, locationId: null };
    }
    const value = rowCell(row, placement.column);
    const key = csvLocationValueKey(value);
    const locationId = placement.assignments[key];
    const location = state.locations.find((candidate) =>
        candidate.id === locationId &&
        !candidate.archivedAt
    );
    if (location) return { issue: null, locationId: location.id };
    return {
        issue: issue(
            "UNRESOLVED_LOCATION",
            value.trim()
                ? `Choose a destination for location value "${csvValuePreview(value)}"`
                : "Choose a destination for blank location values",
            {
                field: "location",
                recordNumber: row.recordNumber,
            },
        ),
        locationId: null,
    };
}

function nextItemOrders(state: WorkspaceState): Map<string, number> {
    const orders = new Map<string, number>();
    for (const item of state.items) {
        if (item.archivedAt) continue;
        orders.set(
            item.locationId,
            Math.max(orders.get(item.locationId) ?? 0, item.order + 1),
        );
    }
    return orders;
}

function planRows(
    options: PlanCsvImportOptions,
    globalIssues: readonly CsvImportIssue[],
): CsvImportRowPlan[] {
    const {
        mapping,
        parsed,
        placement,
        rowIds,
        state,
        timestamp,
    } = options;
    const existingIds = new Set(state.items.map((item) => item.id));
    const preparedIds = new Set<string>();
    const orders = nextItemOrders(state);
    const placementUnavailable = globalIssues.some((candidate) =>
        candidate.field === "location" && candidate.severity === "error"
    );
    return parsed.rows.map((row) => {
        const issues: CsvImportIssue[] = [];
        if (row.cells.length > parsed.columns.length) {
            issues.push(issue(
                "EXTRA_COLUMNS",
                `Row has ${row.cells.length} values but the header has ${
                    parsed.columns.length
                }`,
                { field: "row", recordNumber: row.recordNumber },
            ));
        }
        const name = rowCell(row, mapping.name).trim();
        if (!name && mapping.name !== null) {
            issues.push(issue(
                "NAME_REQUIRED",
                "Item name is blank",
                { field: "name", recordNumber: row.recordNumber },
            ));
        }
        const quantity = parseQuantity(rowCell(row, mapping.quantity));
        if (quantity === null) {
            issues.push(issue(
                "INVALID_QUANTITY",
                "Quantity must be a positive decimal without grouping separators",
                { field: "quantity", recordNumber: row.recordNumber },
            ));
        }
        const frequency = parseFrequency(rowCell(row, mapping.frequency));
        if (frequency === null) {
            issues.push(issue(
                "INVALID_FREQUENCY",
                "Frequency must be daily, weekly, monthly, or rarely",
                { field: "frequency", recordNumber: row.recordNumber },
            ));
        }
        const destination = placementUnavailable
            ? { issue: null, locationId: null }
            : rowDestination(row, placement, state);
        if (destination.issue) issues.push(destination.issue);
        const id = rowIds[row.recordNumber]?.trim() ?? "";
        if (!id) {
            issues.push(issue(
                "ITEM_ID_REQUIRED",
                "A stable item ID could not be prepared for this row",
                { field: "row", recordNumber: row.recordNumber },
            ));
        } else if (existingIds.has(id) || preparedIds.has(id)) {
            issues.push(issue(
                "ITEM_ID_COLLISION",
                "A prepared item ID is not unique",
                { field: "row", recordNumber: row.recordNumber },
            ));
        }
        if (id) preparedIds.add(id);

        let item: ItemRecord | null = null;
        if (
            !globalIssues.some((candidate) => candidate.severity === "error") &&
            !issues.some((candidate) => candidate.severity === "error") &&
            quantity !== null &&
            frequency !== null &&
            destination.locationId
        ) {
            const unit = rowCell(row, mapping.unit).trim();
            const category = rowCell(row, mapping.category).trim();
            item = createItem({
                ...(category ? { category } : {}),
                description: rowCell(row, mapping.description),
                locationId: destination.locationId,
                name,
                order: orders.get(destination.locationId) ?? 0,
                quantity,
                ...(unit ? { unit } : {}),
            }, timestamp);
            item.id = id;
            item.frequency = frequency;
            item.tags = parseTags(rowCell(row, mapping.tags));
            orders.set(destination.locationId, item.order + 1);
        }
        return {
            destinationId: destination.locationId,
            issues,
            item,
            recordNumber: row.recordNumber,
            source: row,
        };
    });
}

const HISTORY_LIMITS = Object.freeze({
    activities: API_QUOTAS.activitiesPerSnapshot,
    activityPatches: API_QUOTAS.activityPatchesPerSnapshot,
    auditEvents: API_QUOTAS.auditEventsPerSnapshot,
    commandReceipts: API_QUOTAS.commandReceiptsPerSnapshot,
    serializedBytes: API_QUOTAS.storedSnapshotBytes,
});

function quotaViolationMessage(
    quota: keyof SnapshotQuotaUsage,
    actual: number,
    limit: number,
): string {
    if (quota === "itemsPerSnapshot") {
        return `Import would create ${actual} item records, above the workspace limit of ${limit}`;
    }
    if (quota === "storedSnapshotBytes") {
        return "Import would exceed the workspace storage-size limit even after older history is compacted";
    }
    if (quota === "activityPatchesPerSnapshot") {
        return "Import would exceed the workspace Activity detail limit";
    }
    return `Import would exceed the ${quota} workspace limit`;
}

function projectQuota(
    state: WorkspaceState,
    command: Extract<Command, { type: "item.bulkCreate" }>,
    commandId: string,
    timestamp: string,
): CsvImportQuotaProjection {
    const result = applyCommand(
        state,
        createEnvelope(state, command, {
            actorId: "csv-import-preview",
            deviceId: "csv-import-preview",
            id: commandId,
            timestamp,
        }),
    );
    const rawUsage = snapshotQuotaUsage(result.state);
    const compacted = compactWorkspaceHistory(
        result.state,
        HISTORY_LIMITS,
        {
            activityIds: result.activity ? [result.activity.id] : [],
        },
    );
    const previousUsage = snapshotQuotaUsage(state);
    const projectedUsage = snapshotQuotaUsage(compacted);
    const quota = SNAPSHOT_QUOTA_ORDER.find((candidate) =>
        projectedUsage[candidate] > API_QUOTAS[candidate] &&
        projectedUsage[candidate] > previousUsage[candidate]
    );
    const violation = quota
        ? {
            actual: projectedUsage[quota],
            limit: API_QUOTAS[quota],
            message: quotaViolationMessage(
                quota,
                projectedUsage[quota],
                API_QUOTAS[quota],
            ),
            quota,
        }
        : null;
    return {
        historyWillBeCompacted:
            serializedJsonBytes(result.state) !== serializedJsonBytes(compacted),
        previousUsage,
        projectedUsage,
        rawUsage,
        violation,
    };
}

export function planCsvImport(
    options: PlanCsvImportOptions,
): CsvImportPlan {
    const globalIssues = mappingIssues(
        options.parsed,
        options.mapping,
        options.placement,
        options.state,
    );
    const rows = planRows(options, globalIssues);
    const validRows = rows.filter((row): row is CsvImportRowPlan & {
        item: ItemRecord;
    } => Boolean(row.item));
    const invalidRows = rows.filter((row) => !row.item);
    if (!validRows.length && !globalIssues.some((candidate) =>
        candidate.code === "NO_DATA_ROWS"
    )) {
        globalIssues.push(issue(
            "NO_VALID_ROWS",
            "No CSV rows are ready to import",
            { field: "row" },
        ));
    }
    const destinationIds = [...new Set(validRows.map((row) =>
        row.item.locationId
    ))];
    const completedDestinations = options.state.locations.filter((location) =>
        destinationIds.includes(location.id) &&
        !location.archivedAt &&
        (location.captureStatus === "counted" ||
            location.captureStatus === "known_empty")
    );
    const command = validRows.length &&
            !globalIssues.some((candidate) => candidate.severity === "error")
        ? {
            type: "item.bulkCreate" as const,
            items: validRows.map((row) => row.item),
            ...(completedDestinations.length
                ? { reopenCompletedParents: true }
                : {}),
        }
        : null;
    let quota: CsvImportQuotaProjection | null = null;
    if (command) {
        try {
            quota = projectQuota(
                options.state,
                command,
                options.commandId,
                options.timestamp,
            );
        } catch (error) {
            globalIssues.push(issue(
                "IMPORT_PREVIEW_FAILED",
                error instanceof Error
                    ? error.message
                    : "Import preview could not be prepared",
                { field: "row" },
            ));
        }
    }
    const destinationCounts = new Map<string, number>();
    for (const row of validRows) {
        destinationCounts.set(
            row.item.locationId,
            (destinationCounts.get(row.item.locationId) ?? 0) + 1,
        );
    }
    const destinations = options.state.locations.flatMap((location) => {
        const count = destinationCounts.get(location.id);
        return count ? [{ count, location }] : [];
    });
    const issues = [
        ...globalIssues,
        ...rows.flatMap((row) => row.issues),
    ];
    return {
        canCommit: Boolean(
            command &&
            !globalIssues.some((candidate) => candidate.severity === "error") &&
            !quota?.violation
        ),
        command,
        completedDestinations,
        destinations,
        invalidRows,
        issues,
        mappingIssues: globalIssues,
        parsed: options.parsed,
        quota,
        rows,
        validRows,
    };
}
