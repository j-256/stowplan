# Spaces and inventory

Use **Spaces** when you know the place you want to inspect. Use **Inventory** when you know the thing you want to find.

## Find an item

Open **Inventory** and search by name, description, category, tag, or placement requirement. The result shows the item's location path so you can follow the same room-to-container route in the physical world.

Choose **Edit / move** for a record in an unfinished space. A record in a counted space instead says **Review, reopen to edit** because changing it makes that space's earlier count stale. Confirm **Reopen capture**, make the correction or move in the same dialog, then choose **Mark counted again** after checking the physical contents.

The item editor can:

- Change the everyday name, quantity, or Description
- Expand **More item details** for unit, categories, tags, or frequency
- Record placement requirements only when they affect where the item may safely go
- Move all or part of the quantity to another space
- Delete the item record with confirmation

Select several records to move them to one destination together. Records already at that destination stay put. Moving a partial quantity creates a separate record at the destination; equivalent records combine.

## Browse the physical hierarchy

Open **Spaces** to follow rooms, zones, cabinets, shelves, boxes, bins, and containers. A hierarchy can be as simple or as deep as the physical layout requires.

Select a space to inspect its details and direct contents. On a phone, the selected row exposes **Earlier**, **Later**, **Edit details**, and **Move**. Choose **Edit details** to switch from the hierarchy to the focused editor, then use **Back to hierarchy** when you are done. Switching panels preserves unfinished editor input. The move dialog lets you choose the new parent and exact position without dragging.

The space editor keeps name, Short ID, type, parent, and **Save space** in the primary flow. Expand **More space details** for tags, description, suitability, and interior dimensions. A planning-review action opens the relevant details automatically.

You can also drag a space before, inside, or after another row. Stowplan prevents a space from becoming its own parent or descendant.

## Describe useful storage facts

Space details can record conditions such as food safety, warmth, humidity, darkness, dimensions, and tags such as `easy-reach`. Item details can record requirements such as avoiding warmth, requiring food-safe storage, or staying with a group.

Only record facts that help answer a question. Dimensions are useful when fit is uncertain; they are not a prerequisite for ordinary capture.

## Keep completed spaces trustworthy

Changing only the display order of siblings does not change what a completed parent contains. Moving a space to another parent does.

When a move changes the membership of a counted or known-empty parent, Stowplan names each affected parent and asks before reopening it. The hierarchy move and those status changes happen together so the first-pass record does not claim more certainty than it has.

## Archive or delete a space

Archive a space when you want it out of ordinary views while preserving its history. Restore it later from the archived section.

Delete only when the physical location and the records beneath it should be removed. Stowplan shows the affected subtree for review first. Deletion remains visible in **Activity** and can be undone while the needed history is available.
