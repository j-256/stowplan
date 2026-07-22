# Move plans

Generate a plan after most relevant spaces are counted. Each recommendation includes reasons; there is no opaque “AI says so” score.

The planner weighs:

- hard suitability failures such as warm storage for heat-sensitive food;
- measured capacity when dimensions are available;
- keeping related records together;
- shallow access for daily and weekly items;
- physical move distance;
- the reduction in work from moving one nested container instead of every record inside it.

Completing an item step validates the expected source and quantity. Completing a container step validates the expected parent and prevents cycles. A stale step stops for review rather than moving something from an unexpected place.

Plans are suggestions. Adjust weights, discard a plan, or make manual changes at any time; generate a fresh plan after substantial edits.

Every priority has an **i** control that works with hover, keyboard focus, and touch. It exposes the scoring effect rather than only a friendly definition:

- **Accessibility:** `max(0, 5 − nesting depth) × frequency factor × value × 0.25`, where daily/weekly/monthly/rarely use factors 4/3/2/1.
- **Capacity:** `value × min(3, 1 + remaining volume ÷ total volume)` when measured capacity fits; an undersized measured space is always rejected.
- **Grouping:** one `value` bonus per matching nearby category or keep-together record, capped at four.
- **Move effort:** subtracts `tree distance × value`, adds `3 × value` for staying put, and raises the improvement threshold. Higher values also favor one whole-container move.
- **Suitability:** begins at `2 × value`, then adds `2 × value` for required food safety and `1 × value` for each satisfied warmth/humidity rule. Rule violations remain hard rejections at zero.
