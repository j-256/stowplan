# Getting started

Stowplan’s first job is to help you finish a trustworthy first pass. You do **not** need a perfect taxonomy or cabinet plan before beginning.

1. Open Stowplan on the phone you will carry while organizing.
2. Choose **Start my workspace**, or use the kitchen demo to learn without entering real data.
3. Attach a physical label to the first room, cabinet, drawer, box, or bin. Enter the same short code in Stowplan.
4. Open that location and record each distinct thing as `quantity + unit + name`.
5. Add any nested boxes or bins before leaving the current location.
6. Choose **Mark counted & next**. Use **Known empty** only after physically checking the space.

The distinction between *uncounted* and *known empty* matters: plans must never assume an unopened box has free capacity.

## Link to a workspace view

An open workspace uses a path that starts with `/workspaces/WORKSPACE_ID` and ends in `/capture`, `/spaces`, `/inventory`, `/plan`, `/activity`, or `/settings`. Capture and Spaces include the selected space, while Inventory includes a container filter or open item editor. Reloading the page or using browser back and forward restores that context.

Choose **Share this view** to use the device share sheet or copy the exact address. Anyone who already has access to the workspace can open that address on another device; Stowplan asks them to sign in when necessary and returns them to the same view. To grant short guest access, open **Settings → Sign in, sync, or create a guest link to this view** and send the one-time confirmation URL. Workspace URLs contain opaque record IDs rather than inventory names, searches, or unsaved form text.

## A practical coding scheme

Use short codes your label gun can print: `GAR-01`, `GAR-01-A`, `KIT-C03`, `KIT-D02`. Codes are searchable identifiers; names can stay friendly and change later.

## Phone ergonomics

The bottom navigation, 44-pixel targets, single-column capture form, sticky completion controls, safe-area spacing, and keyboard-friendly item loop are the primary interface. Desktop adds room for the location tree and structured inspector without changing the workflow.

## Return to the main menu

Choose the house icon in the page header, or open **Settings → Open workspace menu**. The home screen lists every workspace stored on this device. Each card shows the last local edit, the last successful online backup, pending and blocked counts, and the actual changes waiting to upload. From there you can continue, switch, start another workspace, or open the kitchen demo.

**Remove from this device** is deliberately literal. If a server copy exists, it remains available to reopen; the confirmation names the last backup. If the workspace was never backed up, the confirmation warns that the device holds the only copy. Any unsynced changes are counted before removal.

When the kitchen demo is active, the main menu also shows **Reset kitchen demo**. Reset requires confirmation, discards only that demo’s changes and queued backup commands, and creates a fresh demo. It does not touch any other workspace on the device.
