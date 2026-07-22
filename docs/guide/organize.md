# Spaces and inventory

The **Spaces** tree is the structural truth: room → zone → cabinet → shelf → bin is valid, as is room → box → box. Stowplan prevents parent cycles and guards operations that affect a subtree.

Use conditions to describe storage, not items: food-safe, warm, humid, dry, dark, dimensions, and tags such as `easy-reach`. Use item constraints for requirements: avoid warmth, avoid humidity, food-only, required tags, and keep-together groups.

Every space can be renamed, recoded, retyped, moved to a different parent, reordered, dimensioned, archived, restored, or deleted after an exact subtree review. The tree exposes the hierarchy with connector lines, nested counts, item counts, and paths. Drag a container over the top, middle, or bottom of another row to place it before, move it inside, or place it after. Drop it on the root target to make it top-level. Touch dragging uses the same handle and drop cues; parent selectors and arrow controls remain keyboard-friendly alternatives.

**Inventory** is deliberately containerless by default. Search covers names, categories, tags, placement requirements, and notes across the whole workspace; sort by name, location path, or quantity. Tap **Edit / move** for a task-oriented editor: identity and amount first, structured organization second, optional placement and dimensions collapsed separately, and partial movement in its own placement card. Select several records for one explicit destination. Quantity moves split a record when only some units move and merge equivalent records at the destination. Reorder handles appear only after filtering Inventory to one container, where order has an unambiguous meaning.

Archive preserves history. Reviewed deletion is reserved for intentional removal of the entire location subtree and its item records.
