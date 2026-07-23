# Architecture

Stowplan uses ports and adapters around a deterministic domain.

```text
UI / PWA → local replica + outbox → authenticated sync API → SnapshotStore
                    ↓                         ↓                  ↙      ↘
            command/history engine      session/workspace     D1   Node SQLite
                    ↓
             planner + import validation
```

## Invariants

- A location parent is null or another live location in the workspace; cycles are forbidden.
- Active location codes are normalized; physical labels remain stable identifiers.
- Every item points to a location and has a positive finite quantity.
- A command envelope carries workspace, device, actor, base revision, field expectations, timestamp, and globally unique command ID.
- Applying a command is deterministic. Side effects happen outside the domain.
- History stores field-level patches; undo/reapply verifies current values before changing them.
- Server compare-and-swap serializes concurrent sync batches. Command IDs make retries safe.
- A sync request that loses the first-write initialization race is re-authorized against the resulting membership; read access never authorizes a nonempty command batch.
- Every server query is scoped through an authenticated user and workspace membership.

## Boundaries

`src/domain` has no Cloudflare, React, SQL, or browser imports. `SnapshotStore` is the persistence port. D1 and Node SQLite are adapters. Route handlers use standard `Request`/`Response`; `runtimeEnv` is the small composition seam.

IndexedDB is the interaction database, not a cache. It preserves the active replica plus inactive workspaces and each durable outbox. Workspace opening, guarded removal, reset, and restore use single-transaction selection or compare-and-swap so stale renders and concurrent tabs cannot overwrite a newer local replica. Reconnect and foreground reconciliation include inactive workspaces with pending commands.

The server is a durable backup and multi-device reconciliation authority. A rejected command remains inspectable; never silently drop it. Recovery-bundle uploads must prove that every retained outbox command is already represented in the bundled snapshot before recovery discards the queue.

The service worker caches document navigations and static application assets only. It never caches API responses or mixes React Server Component payloads with HTML, and it deletes only Stowplan-owned cache versions.

## Adding an adapter

Implement `SnapshotStore`, provide transactional compare-and-swap, run the shared sync and adapter conformance tests, expose runtime configuration without leaking secrets into the client, and document backup/restore semantics. “SQLite-compatible” is not enough: verify strict JSON, revision CAS, and concurrent writers.
