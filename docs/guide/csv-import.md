# Import inventory from CSV

Use **Inventory → Import CSV** when item records already live in a spreadsheet or another inventory tool. Stowplan reads the file on the device, lets you map its columns and destinations, and changes the workspace only after you review the result.

Create the destination spaces before importing. CSV import adds item records to active spaces; it does not create, rename, or restore spaces.

## Prepare the file

Save the sheet as a UTF-8, comma-separated CSV with a header row. The import dialog reports file, row, column, cell, and workspace limits before a commit can exceed them. Quoted fields may contain commas or line breaks, and doubled quotes inside a quoted field become one literal quote.

Only the item name column is required. These columns can be mapped:

| Item field | Accepted value |
| --- | --- |
| Item name | Non-blank text |
| Quantity | A positive decimal without grouping separators; blank becomes `1` |
| Unit | Text such as `each`, `box`, or `kg`; blank becomes `each` |
| Category | Text; blank becomes `Uncategorized` |
| Description | Free text |
| Tags | Values separated by a comma, semicolon, or pipe; quote a CSV cell that contains commas |
| Frequency | `daily`, `weekly`, `monthly`, or `rarely`; blank becomes `monthly` |

Similar-looking rows remain separate records. Import does not merge items by name, quantity, tags, or destination.

## Map columns and destinations

Stowplan guesses familiar header names, but every guess remains visible and changeable. A CSV column can map to only one item field or to the location field.

Choose **One destination** to place every valid row in the same active space. Choose **Location column** when rows name different destinations. Each distinct location value can be assigned once for every row that uses it.

Location-column values are matched first by exact space code, then by full name path, then by a unique space name. Matching ignores letter case and surrounding whitespace. An ambiguous, unknown, blank, or archived destination stays unresolved until you choose an active space or leave those rows for the invalid-row review.

## Review safely

The review separates ready rows from invalid rows and keeps the original CSV row number beside every problem. A malformed file never advances beyond file selection. If valid and invalid rows coexist, the import button stays disabled until you explicitly agree to skip the invalid rows.

Adding a record to a counted or known-empty space makes that earlier count stale. The review names every affected space and requires a separate confirmation before reopening them as in progress.

The workspace capacity preview uses the same item, history, and stored-size rules as synchronization. It refuses an import that would exceed a workspace limit and explains when older Activity detail must be compacted safely.

If another tab or collaborator changes the workspace while review is open, Stowplan refreshes the preview and invalidates earlier confirmations. Accept the refreshed review, then confirm skipped rows or reopened spaces again when applicable.

## Commit, sync, and undo

The raw CSV file is not uploaded or stored as a workspace attachment. The accepted rows become one ordinary local-first command containing normalized item records. That command commits to the device first, works without connectivity, and enters the same durable outbox and authorized synchronization path as other edits when online backup is active.

Every destination is rechecked when the command applies. A stale destination, duplicate item ID, invalid record, authorization change, or quota refusal rejects the command without importing a partial batch.

A successful import appears as one entry in **Activity**. Choose **Undo this** on that entry to remove all records created by the import and restore any space statuses changed with it. Reapply uses the same conflict checks.

For durable recovery beyond the retained Activity window, keep a [workspace backup or recovery bundle](/guide/recovery).
