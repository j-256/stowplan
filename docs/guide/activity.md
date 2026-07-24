# Activity, undo, redo, and plucking

Every domain mutation records field-level before/after patches. Activity supports:

- **Undo this change:** reverse one selected applied activity ("pluck" it from history).
- **Reapply:** apply one selected undone activity again.
- **Undo N:** undo the latest N applied activities.
- **Redo N:** reapply the latest N undone activities.

History commands use the same local-first outbox. Before reversal, Stowplan checks that affected fields still contain the expected values. If a newer edit touches the same field, the reversal fails safely instead of overwriting it. Unrelated later fields can remain intact.

The audit list records history operations separately so an operator can distinguish the original action from its later undo or reapplication.

Server-backed workspaces retain a bounded history so old activity cannot prevent new cleanup. When the workspace reaches its history or storage limits, Stowplan keeps the current change reversible, removes the oldest audit detail first, then retires the oldest undoable activities. Retired command IDs remain in a compact receipt ledger for idempotent retry, but a retired activity can no longer be undone or reapplied.
