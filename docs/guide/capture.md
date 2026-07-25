# Fast capture

Capture is container-first. Select a location, then repeat:

1. Enter quantity (decimals are supported).
2. Choose or type the unit.
3. Enter the item name.
4. Press **Save & add next**.

The command is durable on the device before the network is contacted. Closing the tab or losing service does not erase accepted rows. Once the queue grows, use **Jump by code or name** to reach the physical label in your hand without scrolling.

Tap an existing row to edit every structured attribute, move all or part of its quantity, or delete the record with confirmation. Drag the visible handle to reorder rows inside the current container; the handle supports pointer and touch input, while the adjacent up/down controls provide the keyboard and assistive-technology fallback. A mouse drag keeps the source muted and highlights the exact before-or-after destination until you release it. Item names wrap at compact desktop widths so the identity remains readable while the reorder controls stay available.

After a space is marked **Counted** or **Known empty**, its recorded membership and item contents become read-only in Capture, Spaces, and Inventory. Choose **Reopen capture** before adding or removing a nested container or before adding, editing, moving, or deleting an item. You can still change sibling display order because that does not change membership, edit the space's own label and suitability details, or add an unrelated top-level space. Moving a nested space to a different parent remains available from Capture and Spaces without reopening first. Stowplan names every affected completed parent and asks for confirmation before reopening those parents and completing the move as one history action. This keeps completion markers trustworthy instead of allowing later content changes to leave a completed space with unreviewed contents.

## Nested containers

Use **Add space** while looking at the parent. It nests there by default; check **Add as another top-level space** for another room, storage area, or other root. Enter the friendly name first and Stowplan suggests a unique Short ID that you can edit before saving. A Short ID you type yourself is never replaced when the name or type changes. Every new container can have its own label and capture status. Moving that physical container later can replace many item-by-item plan steps.

The capture queue is itself a hierarchy, and the breadcrumb above the active container shows exactly where you are. Expand or collapse branches to keep the queue focused without changing its saved structure. Drag a container over the top, middle, or bottom of another row to place it before, move it inside, or place it after; use the root target to make it top-level. Sibling ordering remains available when the parent is completed because it does not change which spaces or items the parent contains, while a move to another parent uses the completed-parent safeguard described above. On a phone, select a container for a compact **Move** control that lets you choose its parent and exact sibling position without touch dragging. **Mark counted & next**, **Known empty & next**, and **Next unfinished** follow the full hierarchy order even when branches are collapsed or the queue is filtered, with the first two actions wrapping to the first remaining unchecked container when needed. **Next unfinished** does not change the status of the container you are reviewing. Nested-container shortcuts under the capture form let you descend without losing the current counting context. The stacked phone layout also provides direct controls to jump between the capture queue and the current-container editor. Printable text and optional QR labels are available from **Settings → Print text and QR labels**.

## Counting rules

- **Uncounted:** not inspected.
- **In progress:** partially inspected; do not optimize as complete.
- **Known empty:** inspected and empty.
- **Counted:** inspected and represented accurately enough to plan.

**Known empty & next** changes status only when no item or nested-space records remain. It does not mean "make empty." If item records remain, Stowplan opens a non-destructive review, names the records that prevent the observation, and makes no change. After physically removing the contents, close that review and choose the separately labeled **Empty container** action. Its own confirmation lists the records it will remove, remains undoable from Activity, and establishes the known-empty status as its result.

Do not mark a parent counted merely because its visible loose items are recorded; count or explicitly classify every nested container too.
