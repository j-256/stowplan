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
- Deterministic bounded retention protects the accepted change, retires the oldest full history first, and carries pruned command IDs into a compact receipt ledger.
- Server compare-and-swap serializes concurrent sync batches. IDs in retained history or the compact receipt ledger make retries safe within the documented replay window.
- A sync request that loses the first-write initialization race is re-authorized against the resulting membership; read access never authorizes a nonempty command batch.
- Every server query is scoped through an authenticated user and workspace membership.

## Boundaries

`src/domain` has no Cloudflare, React, SQL, or browser imports. `SnapshotStore` is the persistence port. D1 and Node SQLite are adapters. Route handlers use standard `Request`/`Response`; `runtimeEnv` is the small composition seam.

The Sites manifest binds D1 as `DB`. `db/schema.ts` is the typed collaboration schema and Drizzle generates the SQL packaged under `.openai/drizzle`. The packaged schema includes local-first workspace snapshots plus identities, memberships, sessions, guest links, OAuth state, and audit events. The artifact validator treats the binding and its migration payload as one deployment requirement.

`src/domain/app-url.ts` defines the runtime-neutral workspace route grammar. Canonical paths start with `/workspaces/:workspaceSlug@:workspaceId/:view`; Capture and Spaces may identify a readable location slug plus its stable ID, while Inventory may identify a location filter or item editor the same way. Parsers trust the stable ID and treat each slug as replaceable presentation, so renaming a record canonicalizes its link without changing what it opens. The client accepts ID-only and legacy workspace/container routes, activates or fetches the authorized replica before canonicalizing, and keeps searches plus unsaved form data out of URLs. Ordinary anchor clicks use same-document history so the IndexedDB provider remains mounted, while modified clicks and direct navigation use the App Router workspace shell.

IndexedDB is the interaction database, not a cache. It preserves the active replica plus inactive workspaces and each durable outbox. Workspace opening, guarded removal, reset, and restore use single-transaction selection or compare-and-swap so stale renders and concurrent tabs cannot overwrite a newer local replica. Reconnect and foreground reconciliation include inactive workspaces with pending commands.

The server is a durable backup and multi-device reconciliation authority. A rejected command remains inspectable; never silently drop it. Recovery-bundle uploads must prove that every retained outbox command is already represented in the bundled snapshot before recovery discards the queue.

The service worker caches document navigations and static application assets only. It never caches API responses or mixes React Server Component payloads with HTML, and it deletes only Stowplan-owned cache versions. Workspace-specific paths are not cache keys; an offline workspace navigation receives the generic cached root shell, which restores route context from the address and data from IndexedDB.

## Adding an adapter

Implement `SnapshotStore`, provide transactional compare-and-swap, run the shared sync and adapter conformance tests, expose runtime configuration without leaking secrets into the client, and document backup/restore semantics. "SQLite-compatible" is not enough: verify strict JSON, revision CAS, and concurrent writers.
