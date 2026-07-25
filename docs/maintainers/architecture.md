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
- Every ordinary server query is scoped through an active authenticated user and workspace membership. Global admin scope is not an implicit membership.
- Server-backed roles and derived capabilities are explicit state. The presence of a local replica and a local owner-like device role never establish server authority.
- Membership and guest-link mutations advance monotonic membership and workspace-access counters through database triggers. Conditional writes recheck those counters, final-owner state, and quotas before the mutation and its audit record commit together.
- A workspace deletion tombstone prevents sync, invitation redemption, access changes, restore, or initialization from resurrecting a deleted stable ID.

## Boundaries

`src/domain` has no Cloudflare, React, SQL, or browser imports. `SnapshotStore` is the persistence port. D1 and Node SQLite are adapters. Route handlers use standard `Request`/`Response`; `runtimeEnv` is the small composition seam.

The Sites manifest binds D1 as `DB`. `db/schema.ts` is the typed collaboration schema and Drizzle generates the SQL packaged under `.openai/drizzle`. The packaged schema includes local-first workspace snapshots plus identities, memberships, sessions, guest links, OAuth state, and audit events. The artifact validator treats the binding and its migration payload as one deployment requirement.

## Workspace authority

`ServerWorkspaceSummary` is the canonical reconciliation record for an authorized server workspace: stable ID, current name, role, capabilities, snapshot revision, server update time, user membership revision, and workspace access revision. The member-scoped catalog produces those summaries without requiring known workspace IDs. The client merges them with device summaries by stable ID, preserving one card and one local replica for each workspace.

`owner`, `editor`, and `viewer` map to canonical capabilities in the runtime-neutral domain. Every role can read. Owners and editors can write workspace data. Only owners can manage members or guest links and delete the server workspace. Editors and viewers can leave; an owner can leave only when another active owner remains. Disabled accounts cannot receive ownership or satisfy the final-owner invariant. A device-only workspace can read and write locally before claim but cannot manage or delete server state.

Client capabilities are damage-prevention controls, not the security boundary. A known viewer is stopped before a command reaches the local replica or outbox, while the server independently checks role and active membership for every read, sync, restore, and access mutation. A role cached while offline can become stale. Commands accepted under a last-known writable role remain durable until reconciliation; an authoritative rejection becomes blocked, inspectable work instead of disappearing or being described as backed up.

Cached server summaries, authorization state, and newly queued server-backed commands carry the account ID that received or created them. Authenticated workspace requests bind that expected account in `X-Stowplan-Account-Id`; the server compares it with the session before any workspace read or mutation and echoes it on successful private responses. Switching accounts therefore fails closed until the new account's catalog or workspace response confirms its own role. Pending work explicitly associated with the previous account is retained and is neither submitted nor extended under the next account; older unscoped records remain readable and become account-scoped on the next authoritative reconciliation.

Routine collaboration is workspace-scoped self-service. Owners use the workspace access surface for member roles, ownership transfer, removal, invite-link enrollment, leave rules, and deletion. An invite URL can enroll one signed-in account; the resulting membership persists until leave, removal, or workspace deletion. The global admin control plane manages installation-wide users, sessions, identities, emergency membership changes, and audits. Its explicit operator mutations preserve the same quota, final-owner, revision, and audit invariants, but a global admin cannot use ordinary member APIs without an active membership.

`users.membership_revision` invalidates catalog traversals and user-specific authorization assumptions when any membership or active-account status for that user changes. `workspace_snapshots.access_revision` invalidates workspace access lists, derived capabilities, and mutations when membership, member status, or guest-link state changes. These counters are separate from the snapshot data `revision`; data edits must not make access cursors stale, and access edits must not masquerade as workspace content revisions. Both the numbered migration stream and packaged Drizzle stream implement matching triggers.

`src/domain/app-url.ts` defines the runtime-neutral workspace route grammar. Canonical paths start with `/workspaces/:workspaceSlug@:workspaceId/:view`; Capture and Spaces may identify a readable location slug plus its stable ID, while Inventory may identify a location filter or item editor the same way. Parsers trust the stable ID and treat each slug as replaceable presentation, so renaming a record canonicalizes its link without changing what it opens. The client accepts ID-only and legacy workspace/container routes, activates or fetches the authorized replica before canonicalizing, and keeps searches plus unsaved form data out of URLs. Ordinary anchor clicks use same-document history so the IndexedDB provider remains mounted, while modified clicks and direct navigation use the App Router workspace shell.

IndexedDB is the interaction database, not a cache. It preserves the active replica plus inactive workspaces and each durable outbox. Workspace opening, guarded removal, reset, and restore use single-transaction selection or compare-and-swap so stale renders and concurrent tabs cannot overwrite a newer local replica. Reconnect and foreground reconciliation include inactive workspaces with pending commands.

The server is a durable backup and multi-device reconciliation authority. A rejected command remains inspectable; never silently drop it. A full server snapshot is not disposable cache when pending or blocked local commands exist. Recovery-bundle uploads must prove that every retained outbox command is already represented in the bundled snapshot before recovery discards the queue.

Removing a workspace from one device deletes only that local replica after its pending and blocked work is disclosed. Leaving deletes only the caller's server membership and requires a separate choice for the retained local replica. Server deletion is owner-only, immediate, and non-recoverable: one transaction records a non-secret tombstone and audit event, revokes affected legacy guest-only sessions, deletes links and memberships, and removes the snapshot. Export the portable backup first and export the full recovery bundle when queued work exists. The export is user-held recovery data, not a promise that the deleted server ID can be undeleted.

The service worker caches document navigations and static application assets only. It never caches API responses or mixes React Server Component payloads with HTML, and it deletes only Stowplan-owned cache versions. Workspace-specific paths are not cache keys; an offline workspace navigation receives the generic cached root shell, which restores route context from the address and data from IndexedDB.

## Adding an adapter

Implement `SnapshotStore`, provide transactional compare-and-swap, run the shared sync and adapter conformance tests, expose runtime configuration without leaking secrets into the client, and document backup/restore semantics. "SQLite-compatible" is not enough: verify strict JSON, revision CAS, and concurrent writers.
