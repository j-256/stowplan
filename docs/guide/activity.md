# Activity and undo

**Activity** shows meaningful workspace changes and lets you reverse mistakes without restoring an entire backup.

On a phone, choose **More → Activity**. Wider layouts keep **Activity** in the workspace sidebar.

## Read the timeline

Activity lists the newest changes first. Each entry names the affected records and meaningful fields, while whole-record creation or deletion is labeled as a record change. Stowplan's internal timestamps and version bookkeeping do not appear as user changes.

The separate **Undo and reapply log** shows each history action and the changes it targeted. Choose **Show older changes** or **Show older actions** when a retained list is longer than the first page. Viewers see the same timeline and log without editing controls.

## Undo one change

Find the change and choose **Undo this**. Stowplan reverses that selected change while leaving unrelated later work intact when it is safe to do so.

Field-aware undo can pluck an older edit from the middle of the timeline. For example, undoing an older quantity edit keeps a newer Description edit on the same item. The undo becomes a new item revision rather than rewinding Stowplan's bookkeeping.

If a newer change edited the same information, Stowplan refuses the undo instead of overwriting the newer value. Review the message and correct the workspace manually if needed.

An undone entry offers **Reapply**. This uses the same safety check, so reapplying cannot silently overwrite a later edit to the same information.

## Undo or redo a recent group

Set the number under **Changes**, then choose **Undo [number]** to reverse the latest applied changes. Choose **Redo [number]** to reapply the latest undone changes.

Use a small group when you can, then check the physical workspace before continuing. A batch stops safely if its expected values no longer match.

## What Activity can restore

Capture, item edits, moves, plan-step completion, reviewed deletion, and other workspace changes appear in Activity. A confirmed **Empty container** action removes its item records and changes its status together, so one undo restores both. Changes that create or delete an entire record remain atomic because there is no surviving record whose fields can be merged independently.

Undo and reapply are themselves recorded, which makes the sequence inspectable by collaborators.

## How long undo remains available

Undo history is bounded so a workspace can keep accepting new work. The oldest detailed entries eventually lose their undo action as the workspace reaches its history and storage limits.

Use a JSON backup when you need a durable checkpoint beyond the Activity window. See [Backup and recovery](/guide/recovery).
