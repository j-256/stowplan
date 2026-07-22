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
