# Move plans

Generate a plan after most relevant spaces are counted. Each recommendation includes reasons; there is no opaque "AI says so" score.

The planning readiness panel separates minimum evidence from confidence improvements. It identifies unfinished spaces, quick-capture item defaults, basic destination suitability, and unmeasured capacity, then opens the exact Capture, Inventory, or Spaces editor that needs review. Capacity measurements remain optional unless physical fit is uncertain.

The planner weighs:

- hard suitability failures such as warm storage for heat-sensitive food;
- measured capacity when dimensions are available;
- keeping related records together;
- shallow access for daily and weekly items;
- physical move distance;
- the reduction in work from moving one nested container instead of every record inside it.

Steps execute in their displayed numbered order. A later step remains disabled until every earlier step is complete, so capacity freed by one move is available to the moves that follow. Completing an item step validates the expected source and quantity. Completing a container step validates the expected parent and prevents cycles. A stale step stops for review rather than moving something from an unexpected place.

Measured capacity is enforced only when the item and destination both have complete, compatible dimensions. When measurements are missing, the recommendation explicitly marks capacity as unverified rather than treating unknown volume as zero or claiming that the item fits. Each plan step can open its item or container and destination for review without moving anything. Saving corrected evidence discards the stale plan so a replacement can be generated from the new state.

Plans are suggestions. Adjust weights, discard a plan, or make manual changes at any time; generate a fresh plan after substantial edits.

Every priority has an **i** control that works with hover, keyboard focus, and touch. It exposes the scoring effect rather than only a friendly definition:

- **Accessibility:** `max(0, 5 − nesting depth) × frequency factor × value × 0.25`, where daily/weekly/monthly/rarely use factors 4/3/2/1.
- **Capacity:** `value × min(3, 1 + remaining volume ÷ total volume)` when measured capacity fits; an undersized measured space is always rejected.
- **Grouping:** one `value` bonus per matching nearby category or keep-together record, capped at four.
- **Move effort:** subtracts `tree distance × value`, adds `3 × value` for staying put, and raises the improvement threshold. Higher values also favor one whole-container move.
- **Suitability:** begins at `2 × value`, then adds `2 × value` for required food safety and `1 × value` for each satisfied warmth/humidity rule. Rule violations remain hard rejections at zero.
