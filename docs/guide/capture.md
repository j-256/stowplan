# Fast capture

Capture is designed for a phone in one hand while the other hand opens boxes and cabinets. Stay with the physical space in front of you and record enough to find and move its contents later.

## Record one space

1. Select the physical space by its short ID or name. On a phone, choose **Capture queue** to find it; selecting the row opens **Current container** in one tap.
2. Enter **What is it?** and adjust **Qty** only when the default of one is not right.
3. Expand **Add description or unit** when a searchable description or a unit other than `each` will help.
4. Choose **Save & add next**.
5. Repeat until the loose items in that space are represented.
6. Add any nested boxes, bins, drawers, or shelves before moving on.
7. Choose **Counted & next**.

Each accepted row is saved in this browser before Stowplan tries online backup. You can close the tab or lose service after the save completes without losing that accepted row.

Use **Next unfinished** when you only want to navigate. It does not change the current space. **Counted & next** records that the current space is accurate enough and advances through the full hierarchy, including branches that are collapsed or hidden by a filter.

On a phone, **Capture queue** and **Current container** switch between the hierarchy and the focused form without discarding unfinished form input. Every queue row keeps **Move** available as a separate action when you need to change its exact parent or position.

## Add a container inside another

Select the parent and use **Add inside [name]**. Stowplan suggests a short ID from the friendly name, but you can replace it with the code on your physical label.

Use **Add as another top-level space** for a separate room, garage, storage unit, or other root rather than a container inside the selected space.

The breadcrumb above the capture form shows where the selected container sits. Expand or collapse branches to focus the queue; this changes only the display, not the saved structure.

## Record an empty space safely

Choose **Known empty & next** only after checking the physical space. When no records or nested spaces remain, the action stays beside **Counted & next**. When item records remain, expand **Contents no longer match?** to review the uncommon empty-space actions without putting them in the frequent completion path. Choosing **Known empty & next** there opens a review and changes nothing; move or remove the records first.

If the physical contents are already gone and the records should be removed, choose **Empty container** in the same disclosure. Its confirmation names what will be removed. The deletion and known-empty status become one Activity entry, so one undo restores both.

A space with a nested space cannot be marked known empty because the nested space is still part of its contents.

## Correct a completed space

Counted and known-empty spaces protect their contents from accidental edits. Choose **Reopen capture** before adding, editing, moving, reordering, or deleting their direct contents.

Reopening a space with contents returns it to **In progress**. Reopening an empty space returns it to **Uncounted**.

Inventory labels an item in a completed space **Review, reopen to edit**. The review keeps the confirmation explicit, then opens the full editor in the same dialog. After a successful edit or move, choose **Mark counted again** there to restore the original space's trusted first-pass status without detouring through Capture.

Moving a nested container can affect both its old and new completed parents. Stowplan names those parents and asks before reopening them and making the move as one change.

## Fix or move an item

Choose an existing item to edit its name, quantity, or searchable Description. Expand **More item details** for unit, category, frequency, and tags. Placement requirements and exact dimensions stay in their own optional disclosures. The placement card can move all or part of an item's quantity. A partial move leaves one record at the source and creates or combines the matching amount at the destination.

Reorder handles change the visible order inside one container. Arrow controls provide the same operation without dragging.

## Print labels

Open **Settings → Print text and QR labels**. A plain text code is enough for everyday use; QR labels are optional shortcuts into the matching Stowplan view.
