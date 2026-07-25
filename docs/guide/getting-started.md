# Getting started

Stowplan's first job is to help you finish a trustworthy first pass. You do **not** need a perfect taxonomy or cabinet plan before beginning.

1. Open Stowplan on the phone you will carry while organizing.
2. Choose **Start my workspace**, or use the kitchen demo to learn without entering real data.
3. Attach a physical label to the first room, cabinet, drawer, box, or bin. Enter the same short code in Stowplan.
4. Open that location and record each distinct thing as `quantity + unit + name`.
5. Add any nested boxes or bins before leaving the current location.
6. Choose **Counted & next**. Use **Known empty & next** only after physically checking the space.

The distinction between *uncounted* and *known empty* matters: plans must never assume an unopened box has free capacity.

**Known empty & next** records only the observation that a checked space is already empty; it never removes item records. If records remain, Stowplan opens a non-destructive review that names them and makes no change. Close that review before using the separately labeled **Empty container** action. Use that destructive action only after the physical items are no longer there. Its own confirmation names every affected record, removes them, and marks the space known empty as one history action, so a single **Undo** restores the records and the earlier capture status. A space with nested spaces cannot be marked empty; Stowplan leaves it unchanged and explains why. Membership and item contents are read-only after a space is counted or marked known empty, including from Spaces and Inventory. Choose **Reopen capture** before changing them. It returns to in progress when it contains items or nested spaces, and to uncounted when it is empty. Sibling display-order changes remain available because they do not change membership. Reparenting a space from Capture or Spaces names every affected completed parent and requires confirmation before reopening those parents and applying the move atomically.

## Link to a workspace view

An open workspace uses a path that starts with `/workspaces/READABLE-NAME@WORKSPACE-ID` and ends in `/capture`, `/spaces`, `/inventory`, `/plan`, `/activity`, or `/settings`. Capture and Spaces include the selected space, while Inventory includes a container filter or open item editor. Reloading the page or using browser back and forward restores that context.

Choose **Share this view** to use the device share sheet or copy the exact address. Anyone who already has access to the workspace can open that address on another device; Stowplan asks them to sign in when necessary and returns them to the same view. To grant short guest access, open **Settings → Sign in, sync, or create a guest link to this view** and send the one-time confirmation URL. Workspace URLs pair readable workspace, space, and item slugs with stable record IDs, so links remain understandable without breaking when something is renamed. Searches and unsaved form text stay out of the URL.

## A practical coding scheme

Use short codes your label gun can print: `GAR-01`, `GAR-01-A`, `KIT-C03`, `KIT-D02`. Codes are searchable identifiers; names can stay friendly and change later.

## Phone ergonomics

The bottom navigation, 44-pixel targets, single-column capture form, sticky completion controls, safe-area spacing, and keyboard-friendly item loop are the primary interface. Capture and Spaces stack their panes on a phone and provide direct controls to jump between them. Capture lets you expand or collapse hierarchy branches, and selecting a container exposes a compact **Move** control. In Spaces, selecting a tree row exposes **Earlier**, **Later**, **Edit details**, and **Move** beside the active context. Both Move dialogs choose a parent and exact sibling position. On a wider screen, collapse the left navigation to icons when you want more working room. Capture and Spaces can switch between stacked and side-by-side panes, and their divider can be dragged or moved with the arrow keys.

Press **Command-K** on macOS or **Control-K** elsewhere to search workspace views, spaces, and items. The jump menu opens the matching view and preserves meaningful workspace context in the address.

## Return to the main menu

Choose the house icon in the page header, or open **Settings → Open workspace menu**. The home screen lists every workspace stored on this device. Each card shows the last local edit, the last successful online backup, pending and blocked counts, and the actual changes waiting to upload. From there you can continue, switch, start another workspace, or open the kitchen demo.

**Remove from this device** is deliberately literal. If a server copy exists, it remains available to reopen; the confirmation names the last backup. If the workspace was never backed up, the confirmation warns that the device holds the only copy. Any unsynced changes are counted before removal.

When the kitchen demo is active, the main menu also shows **Reset kitchen demo**. Reset requires confirmation, discards only that demo's changes and queued backup commands, and creates a fresh demo. It does not touch any other workspace on the device.
