# Contributing

Thank you for improving Stowplan. Open an issue for substantial behavior or schema changes so invariants and migration strategy can be agreed before implementation.

1. Use Node from `.nvmrc`, or a supported Node 26 release, with npm 11 and `npm ci`.
2. Branch from `main`; keep commits focused and never commit generated output or secrets.
3. Add a regression test before changing domain, sync, persistence, auth, or offline semantics.
4. Preserve the contracts in `AGENTS.md` and update both user and maintainer docs.
5. Run the full verification list in `README.md`.
6. Describe user impact, migration/rollback, tests, mobile/accessibility checks, and security implications in the pull request.

By contributing, you agree that your contribution is licensed under `AGPL-3.0-only`.
