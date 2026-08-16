# Changelog

All notable changes follow Keep a Changelog. Versions use Semantic Versioning.

## [1.2.0] - 2026-08-16

### Added

- Authenticated, quota-aware live collaboration that streams remote workspace and administrative access changes without carrying workspace content through notifications.
- Guided CSV onboarding with bounded parsing, destination mapping, explicit invalid-row handling, atomic import, offline commit, and Activity restoration.
- A public landing experience with visitor-aware continuation, hosted Privacy Policy and Terms of Service, and truthful mobile-first screenshots.
- Inspectable Activity history with field-aware selective and batch undo and redo.

### Changed

- Reworked compact Capture, Spaces, Inventory, Plan, Account, and workspace creation flows around focused mobile actions while retaining full desktop controls.
- Split the workspace client into focused application, feature, interaction, and view modules without changing its local-first command path.
- Moved the application and documentation to their canonical custom domains and expanded release verification across GitHub, Sites, Node, Cloudflare, and both documentation bases.

### Fixed

- Preserved pending-work attribution, field-level history, invitation continuation, touch reordering, and offline recovery across account, browser, and synchronization edge cases.
- Hardened dependency, SBOM, browser, security, build-output, and deployment checks so release-only failures surface before publication.

## [1.1.0] - 2026-07-22

### Added

- Explicit nested trees and breadcrumbs in Capture, plus a connected hierarchy with before/inside/after drop cues in Spaces.
- Pointer and touch dragging for container nesting, sibling ordering, item ordering, and item-to-container moves, with auto-scroll and non-drag fallbacks.
- Containerless Inventory sorting, full location paths, visible edit/move actions, and contextual ordering only after filtering to one container.
- A workspace-first home screen with last-backup timestamps, pending/blocked change inspection, and guarded device-only removal.
- Keyboard-, touch-, and hover-accessible planner explanations with the exact scoring effect of every priority.

### Changed

- Mobile space selection now moves directly to the editor, while desktop preserves the two-pane tree and inspector workflow.
- Hierarchical destinations are consistently indented in parent, filter, bulk-move, and partial-move controls.
- Item editing now emphasizes identity and quantity, separates placement from metadata, and progressively discloses infrequent requirements and dimensions.
- Mobile navigation keeps five primary workflows in reach and moves Settings to the page header.

## [1.0.1] - 2026-07-22

### Added

- A persistent main menu with safe workspace switching and an isolated, confirmed kitchen-demo reset.
- An explicit local development sign-in form and end-to-end admin control-panel testing instructions.

### Fixed

- Next.js development now initializes OpenNext bindings, and non-OpenNext runtimes catch asynchronous Cloudflare-context failures before falling back to their environment adapter.
- Unconfigured showcase deployments now explain the missing database instead of surfacing a raw runtime exception.

## [1.0.0] - 2026-07-22

### Added

- Mobile-first nested-container onboarding, code/name jump, top-level space creation, and rapid quantity/unit/item capture.
- Local-first IndexedDB replica, durable outbox, adaptive debounce, idempotent server sync, and outage recovery.
- Structured spaces, environmental suitability, inventory search, partial/bulk/whole-container moves, drag-and-drop ordering, and weighted explainable planning.
- Field-level activity with selected and arbitrary-count batch undo/redo.
- System-default light/dark theme and installable PWA shell.
- D1 and Node SQLite adapters, Google/GitHub/Access/guest authentication, workspace authorization, and audited admin panel.
- Multi-workspace local switching, deeply validated compare-and-swap restore, independent VitePress docs, GitHub Pages deployment, and operator/maintainer runbooks.
