# Agent handoff

Read in this order: `README.md`, `AGENTS.md`, this architecture guide, `src/domain/types.ts`, `src/domain/commands.ts`, `src/server/sync-service.ts`, `src/client/store.tsx`, then the adapter or route being changed.

## Non-negotiable contracts

- Never make network success a prerequisite for a local command.
- Never cache API responses in the service worker.
- Never discard or reorder an outbox envelope silently.
- Never bypass field expectations for conflict resolution or history reversal.
- Never scope a SQL query only in client code; authorization is server-side.
- Never transport workspace content through live notification adapters; revision-only hints wake authenticated sync.
- Never log raw session tokens, OAuth codes/tokens, guest URLs, Access assertions, or full production snapshots.
- Keep Cloudflare logic in adapters/composition roots. Run Node and D1 conformance gates after persistence changes.
- Add a numbered migration; do not edit an already-released migration.
- Treat uncounted and known-empty as distinct planner inputs.
- Preserve physical-container semantics when changing the planner.
- Keep Capture and Spaces hierarchy changes on the same guarded path: sibling reorders change only `order`, while reparenting changes `parentId` and atomically reopens affected completed parents only after explicit confirmation. Capture's "next" actions must follow the full flattened hierarchy order, independent of collapsed branches or search filters.

## Change workflow

State the invariant affected, write or extend a failing regression test, make the smallest domain change, test adapters and offline replay, then update user and maintainer docs in the same commit. For UI work, verify mobile first and avoid hover/drag-only interactions.

Generated directories (`node_modules`, `.next`, `.open-next`, `dist`, VitePress output, reports) do not belong in Git. Keep the worktree clean at handoff.
