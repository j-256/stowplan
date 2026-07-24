# Fast capture

Capture is container-first. Select a location, then repeat:

1. Enter quantity (decimals are supported).
2. Choose or type the unit.
3. Enter the item name.
4. Press **Save & add next**.

The command is durable on the device before the network is contacted. Closing the tab or losing service does not erase accepted rows. Once the queue grows, use **Jump by code or name** to reach the physical label in your hand without scrolling.

Tap an existing row to edit every structured attribute, move all or part of its quantity, or delete the record with confirmation. Drag the visible handle to reorder rows inside the current container; the handle supports pointer and touch input, while the adjacent up/down controls provide the keyboard and assistive-technology fallback. A mouse drag keeps the source muted and highlights the exact before-or-after destination until you release it. Item names wrap at compact desktop widths so the identity remains readable while the reorder controls stay available.

After a space is marked **Counted** or **Known empty**, its recorded contents become read-only in Capture, Spaces, and Inventory. Choose **Reopen capture** before adding or moving a nested container, adding, editing, moving, or deleting an item, or changing content order. You can still edit the space's own label and suitability details or add an unrelated top-level space. This keeps the completion marker trustworthy instead of allowing later content changes to leave a completed space with unreviewed contents.

## Nested containers

Use **Add space** while looking at the parent. It nests there by default; check **Add as another top-level space** for another room, storage area, or other root. Enter the friendly name first and Stowplan suggests a unique Short ID that you can edit before saving. A Short ID you type yourself is never replaced when the name or type changes. Every new container can have its own label and capture status. Moving that physical container later can replace many item-by-item plan steps.

The capture queue is itself a hierarchy, and the breadcrumb above the active container shows exactly where you are. Drag a container row or use its up/down controls to reorder it among siblings without leaving Capture; valid siblings show a before-or-after insertion cue during a mouse drag, while branches under another parent are muted because Capture never reparents them. Structural moves to a different parent remain in **Spaces**. **Mark counted & next** and **Known empty & next** follow this visible hierarchy order, wrapping to the first remaining unchecked container when needed. **Next unfinished** opens the next unchecked container without changing the status of the one you are reviewing. Nested-container shortcuts under the capture form let you descend without losing the current counting context. Printable text and optional QR labels are available from **Settings → Print text and QR labels**.

## Counting rules

- **Uncounted:** not inspected.
- **In progress:** partially inspected; do not optimize as complete.
- **Known empty:** inspected and empty.
- **Counted:** inspected and represented accurately enough to plan.

Do not mark a parent counted merely because its visible loose items are recorded; count or explicitly classify every nested container too.
