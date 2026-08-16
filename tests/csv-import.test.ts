import { describe, expect, it } from "vitest";
import {
    CSV_IMPORT_MAX_CELL_CHARACTERS,
    CsvParseError,
    createEmptyState,
    createItem,
    createLocation,
    csvLocationValueGroups,
    csvValuePreview,
    emptyCsvItemMapping,
    guessCsvColumns,
    matchCsvLocation,
    parseCsv,
    planCsvImport,
    snapshotQuotaUsage,
    suggestedCsvLocationAssignments,
    type CsvImportPlacement,
    type CsvItemColumnMapping,
    type WorkspaceState,
} from "../src/domain";
import { API_QUOTAS } from "../src/shared/api-quotas";

const IMPORTED_AT = "2026-08-16T14:00:00.000Z";

function plannerState(): WorkspaceState {
    const state = createEmptyState("CSV planner", IMPORTED_AT);
    const pantry = createLocation(
        { code: "PAN", kind: "room", name: "Pantry" },
        IMPORTED_AT,
    );
    pantry.id = "loc_pantry";
    pantry.captureStatus = "in_progress";
    const pantryShelf = createLocation(
        {
            code: "PAN-1",
            kind: "shelf",
            name: "Top shelf",
            parentId: pantry.id,
        },
        IMPORTED_AT,
    );
    pantryShelf.id = "loc_pantry_shelf";
    pantryShelf.captureStatus = "counted";
    const garage = createLocation(
        { code: "GAR", kind: "room", name: "Garage" },
        IMPORTED_AT,
    );
    garage.id = "loc_garage";
    garage.captureStatus = "in_progress";
    const garageShelf = createLocation(
        {
            code: "GAR-1",
            kind: "shelf",
            name: "Top shelf",
            parentId: garage.id,
        },
        IMPORTED_AT,
    );
    garageShelf.id = "loc_garage_shelf";
    garageShelf.captureStatus = "in_progress";
    state.locations = [pantry, pantryShelf, garage, garageShelf];
    return state;
}

function rowIds(
    parsed: ReturnType<typeof parseCsv>,
): Record<number, string> {
    return Object.fromEntries(parsed.rows.map((row) => [
        row.recordNumber,
        `item_csv_${row.recordNumber}`,
    ]));
}

function plan(
    state: WorkspaceState,
    source: string,
    options: {
        mapping?: CsvItemColumnMapping;
        placement?: CsvImportPlacement;
    } = {},
) {
    const parsed = parseCsv(source);
    const guessed = guessCsvColumns(parsed);
    const mapping = options.mapping ?? {
        category: guessed.category,
        description: guessed.description,
        frequency: guessed.frequency,
        name: guessed.name,
        quantity: guessed.quantity,
        tags: guessed.tags,
        unit: guessed.unit,
    };
    return planCsvImport({
        commandId: "cmd_csv_preview",
        mapping,
        parsed,
        placement: options.placement ?? {
            locationId: state.locations[0]?.id ?? null,
            mode: "single",
        },
        rowIds: rowIds(parsed),
        state,
        timestamp: IMPORTED_AT,
    });
}

describe("CSV parsing", () => {
    it("handles a BOM, quotes, escaped quotes, embedded newlines, and blanks", () => {
        const parsed = parseCsv(
            '\ufeffName,Description,Qty\r\n' +
            '"Rice, brown","Line 1\r\nLine 2",2\r\n' +
            '"He said ""hello""",,1\r\n' +
            "\r\n",
        );

        expect(parsed.columns).toEqual([
            { header: "Name", index: 0 },
            { header: "Description", index: 1 },
            { header: "Qty", index: 2 },
        ]);
        expect(parsed.rows).toEqual([
            {
                cells: ["Rice, brown", "Line 1\nLine 2", "2"],
                recordNumber: 2,
            },
            {
                cells: ['He said "hello"', "", "1"],
                recordNumber: 3,
            },
        ]);
        expect(parsed.blankRecordCount).toBe(1);
    });

    it("ignores leading blank records and accepts CR line endings", () => {
        const parsed = parseCsv("\r\rname\rRice\rBeans");
        expect(parsed.headerRecordNumber).toBe(3);
        expect(parsed.rows.map((row) => row.recordNumber)).toEqual([4, 5]);
        expect(parsed.blankRecordCount).toBe(2);
    });

    it("retains duplicate and blank headers by stable column index", () => {
        const parsed = parseCsv("name,name,,quantity\nRice,Long grain,,2");
        expect(parsed.columns).toEqual([
            { header: "name", index: 0 },
            { header: "name", index: 1 },
            { header: "", index: 2 },
            { header: "quantity", index: 3 },
        ]);
        expect(csvValuePreview(`  ${"x".repeat(130)}  `)).toBe(
            `${"x".repeat(117)}...`,
        );
    });

    it("reports malformed quote placement with source coordinates", () => {
        expect(() => parseCsv('name\nbad"quote')).toThrowError(
            expect.objectContaining({
                code: "UNEXPECTED_QUOTE",
                column: 4,
                line: 2,
            }),
        );
        expect(() => parseCsv('name\n"unclosed')).toThrowError(
            expect.objectContaining({ code: "UNCLOSED_QUOTE" }),
        );
        expect(() => parseCsv('name\n"closed"oops')).toThrowError(
            expect.objectContaining({ code: "TRAILING_QUOTE_CONTENT" }),
        );
    });

    it("enforces configurable byte, row, column, and cell bounds", () => {
        expect(() => parseCsv("name", { fileBytes: 3 })).toThrowError(
            expect.objectContaining({ code: "FILE_TOO_LARGE" }),
        );
        expect(() => parseCsv("a,b,c\n1,2,3", { columns: 2 })).toThrowError(
            expect.objectContaining({ code: "TOO_MANY_COLUMNS" }),
        );
        expect(() => parseCsv("name\na\nb", { dataRows: 1 })).toThrowError(
            expect.objectContaining({ code: "TOO_MANY_ROWS" }),
        );
        expect(() => parseCsv("name\nlong", { cellCharacters: 3 })).toThrowError(
            expect.objectContaining({ code: "CELL_TOO_LARGE" }),
        );
        expect(() => parseCsv("\n\r\n")).toThrow(CsvParseError);
    });
});

describe("CSV mapping", () => {
    it("guesses common item and placement headers without reusing columns", () => {
        const parsed = parseCsv(
            "Product,Qty,UOM,Notes,Labels,Usage Frequency,Storage Location,Group\n" +
            "Rice,2,bag,Dry,staple,weekly,PAN-1,Food",
        );

        expect(guessCsvColumns(parsed)).toEqual({
            category: 7,
            description: 3,
            frequency: 5,
            location: 6,
            name: 0,
            quantity: 1,
            tags: 4,
            unit: 2,
        });
    });

    it("matches active locations by code, full path, or unique name", () => {
        const state = plannerState();
        expect(matchCsvLocation("pan-1", state.locations)).toEqual({
            ambiguous: false,
            locationId: "loc_pantry_shelf",
            matchedBy: "code",
        });
        expect(matchCsvLocation(
            "Pantry > Top shelf",
            state.locations,
        )).toEqual({
            ambiguous: false,
            locationId: "loc_pantry_shelf",
            matchedBy: "path",
        });
        expect(matchCsvLocation("Top shelf", state.locations)).toEqual({
            ambiguous: true,
            locationId: null,
            matchedBy: null,
        });
        expect(matchCsvLocation("Pantry", state.locations)).toEqual({
            ambiguous: false,
            locationId: "loc_pantry",
            matchedBy: "path",
        });
        state.locations[0]!.archivedAt = IMPORTED_AT;
        expect(matchCsvLocation("PAN", state.locations).locationId).toBeNull();
    });

    it("groups normalized source values and suggests only safe matches", () => {
        const state = plannerState();
        const parsed = parseCsv(
            "name,location\nRice,PAN-1\nBeans, pan-1 \nTea,Top shelf\nSalt,",
        );
        const groups = csvLocationValueGroups(parsed, 1, state.locations);

        expect(groups.map((group) => ({
            ambiguous: group.ambiguous,
            count: group.count,
            key: group.key,
            locationId: group.locationId,
        }))).toEqual([
            {
                ambiguous: false,
                count: 2,
                key: "pan-1",
                locationId: "loc_pantry_shelf",
            },
            {
                ambiguous: true,
                count: 1,
                key: "top shelf",
                locationId: null,
            },
            {
                ambiguous: false,
                count: 1,
                key: "",
                locationId: null,
            },
        ]);
        expect(suggestedCsvLocationAssignments(groups)).toEqual({
            "pan-1": "loc_pantry_shelf",
        });
    });
});

describe("CSV import planning", () => {
    it("prepares factory defaults and mapped fields in source order", () => {
        const state = plannerState();
        const result = plan(
            state,
            "Item,Qty,UOM,Category,Notes,Labels,Usage\n" +
            'Rice,2.5,bag,Staples,"Brown rice","dry; staple; DRY",weekly\n' +
            "Beans,,,,,,",
        );

        expect(result.canCommit).toBe(true);
        expect(result.invalidRows).toEqual([]);
        expect(result.command?.items).toEqual([
            expect.objectContaining({
                category: "Staples",
                description: "Brown rice",
                frequency: "weekly",
                id: "item_csv_2",
                locationId: "loc_pantry",
                name: "Rice",
                order: 0,
                quantity: 2.5,
                tags: ["dry", "staple"],
                unit: "bag",
            }),
            expect.objectContaining({
                category: "Uncategorized",
                description: "",
                frequency: "monthly",
                id: "item_csv_3",
                locationId: "loc_pantry",
                name: "Beans",
                order: 1,
                quantity: 1,
                tags: [],
                unit: "each",
            }),
        ]);
        expect(result.destinations).toEqual([{
            count: 2,
            location: state.locations[0],
        }]);
        expect(result.quota?.violation).toBeNull();
    });

    it("keeps valid rows while explaining every skipped row", () => {
        const state = plannerState();
        const parsed = parseCsv(
            "name,quantity,frequency,location\n" +
            "Rice,2,monthly,PAN-1\n" +
            "Bad frequency,1,yearly,GAR-1\n" +
            "Bad quantity,-1,weekly,Unknown\n" +
            ",1,daily,GAR-1",
        );
        const guessed = guessCsvColumns(parsed);
        const groups = csvLocationValueGroups(
            parsed,
            guessed.location!,
            state.locations,
        );
        const result = planCsvImport({
            commandId: "cmd_csv_partial",
            mapping: {
                category: null,
                description: null,
                frequency: guessed.frequency,
                name: guessed.name,
                quantity: guessed.quantity,
                tags: null,
                unit: null,
            },
            parsed,
            placement: {
                assignments: suggestedCsvLocationAssignments(groups),
                column: guessed.location,
                mode: "column",
            },
            rowIds: rowIds(parsed),
            state,
            timestamp: IMPORTED_AT,
        });

        expect(result.canCommit).toBe(true);
        expect(result.validRows.map((row) => row.recordNumber)).toEqual([2]);
        expect(result.invalidRows.map((row) => row.recordNumber)).toEqual([
            3,
            4,
            5,
        ]);
        expect(result.issues.map((candidate) => candidate.code)).toEqual(
            expect.arrayContaining([
                "INVALID_FREQUENCY",
                "INVALID_QUANTITY",
                "NAME_REQUIRED",
                "UNRESOLVED_LOCATION",
            ]),
        );
        expect(result.command).toMatchObject({
            reopenCompletedParents: true,
            type: "item.bulkCreate",
        });
        expect(result.completedDestinations.map((location) =>
            location.id
        )).toEqual(["loc_pantry_shelf"]);
    });

    it("blocks duplicate mappings and rows with unrepresented extra cells", () => {
        const state = plannerState();
        const parsed = parseCsv("name,quantity\nRice,2,ignored");
        const mapping = emptyCsvItemMapping();
        mapping.name = 0;
        mapping.unit = 0;
        const duplicate = planCsvImport({
            commandId: "cmd_csv_duplicate_mapping",
            mapping,
            parsed,
            placement: { locationId: "loc_pantry", mode: "single" },
            rowIds: rowIds(parsed),
            state,
            timestamp: IMPORTED_AT,
        });
        expect(duplicate.canCommit).toBe(false);
        expect(duplicate.mappingIssues).toEqual(
            expect.arrayContaining([
                expect.objectContaining({ code: "DUPLICATE_COLUMN_MAPPING" }),
            ]),
        );

        mapping.unit = null;
        const extra = planCsvImport({
            commandId: "cmd_csv_extra_cell",
            mapping,
            parsed,
            placement: { locationId: "loc_pantry", mode: "single" },
            rowIds: rowIds(parsed),
            state,
            timestamp: IMPORTED_AT,
        });
        expect(extra.canCommit).toBe(false);
        expect(extra.issues).toEqual(expect.arrayContaining([
            expect.objectContaining({ code: "EXTRA_COLUMNS" }),
            expect.objectContaining({ code: "NO_VALID_ROWS" }),
        ]));
    });

    it("blocks imports that exceed item capacity", () => {
        const state = plannerState();
        const template = createItem({
            locationId: "loc_pantry",
            name: "Stored",
        }, IMPORTED_AT);
        state.items = Array.from(
            { length: API_QUOTAS.itemsPerSnapshot },
            (_, index) => ({
                ...template,
                constraints: {
                    ...template.constraints,
                    requiredTags: [],
                },
                id: `item_stored_${index}`,
                order: index,
            }),
        );

        const result = plan(state, "name\nOne more");
        expect(result.canCommit).toBe(false);
        expect(result.quota?.violation).toMatchObject({
            actual: API_QUOTAS.itemsPerSnapshot + 1,
            limit: API_QUOTAS.itemsPerSnapshot,
            quota: "itemsPerSnapshot",
        });
    });

    it("protects the import while retiring older history under byte pressure", () => {
        const state = plannerState();
        state.activities = [{
            actorId: "older-user",
            commandId: "cmd_older",
            id: "activity_older",
            label: "",
            patches: [],
            status: "applied",
            subjectIds: [state.workspace.id],
            timestamp: IMPORTED_AT,
            undoneAt: null,
        }];
        const baseBytes = snapshotQuotaUsage(state).storedSnapshotBytes;
        state.activities[0]!.label = "x".repeat(
            API_QUOTAS.storedSnapshotBytes - baseBytes - 300,
        );
        expect(snapshotQuotaUsage(state).storedSnapshotBytes).toBeLessThan(
            API_QUOTAS.storedSnapshotBytes,
        );

        const result = plan(state, "name\nRice");
        expect(result.canCommit).toBe(true);
        expect(result.quota?.historyWillBeCompacted).toBe(true);
        expect(result.quota?.rawUsage.activitiesPerSnapshot).toBe(2);
        expect(result.quota?.projectedUsage.activitiesPerSnapshot).toBe(1);
        expect(result.quota?.violation).toBeNull();
    });

    it("blocks a protected import that cannot fit the snapshot byte limit", () => {
        const state = plannerState();
        const description = "x".repeat(
            CSV_IMPORT_MAX_CELL_CHARACTERS - 32,
        );
        const dataRows = Array.from({ length: 32 }, (_, index) =>
            `Item ${index},${description}`
        );
        const result = plan(
            state,
            ["name,description", ...dataRows].join("\n"),
        );

        expect(result.canCommit).toBe(false);
        expect(result.quota?.violation).toMatchObject({
            limit: API_QUOTAS.storedSnapshotBytes,
            quota: "storedSnapshotBytes",
        });
    });
});
