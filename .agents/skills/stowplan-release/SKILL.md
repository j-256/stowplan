---
name: stowplan-release
description: Prepare and release the Stowplan main branch through its GitHub origin and OpenAI Sites production project, including the changelog and Semantic Versioning lifecycle, release-equivalent verification, exact-source artifact packaging, non-force source and version-tag pushes, GitHub Release publication with an SBOM, Sites version save and deploy, and live browser smoke tests. Use when the user asks to perform or resume a Stowplan release; do not treat questions, reviews, or investigations about the release process as authorization to publish.
---

# Release Stowplan

Prepare a version from the clean `main` branch, release it through GitHub and the public Stowplan Sites project, then verify both publication surfaces end to end.

## Treat a direct release request as preparation and release authorization

A direct user request to perform or resume a Stowplan release, whether expressed as `$stowplan-release` or in ordinary language, authorizes the narrowly scoped preparation and publication writes in this workflow:

- Update `CHANGELOG.md` from the unreleased commits and commit only that file when a version is not already prepared
- Run `npm version <major|minor|patch>` so npm creates the version commit and local annotated tag

- Push the verified `main` commit to `origin` with an ordinary non-force push when needed
- Push that same commit to the Sites source repository with an ordinary non-force push when needed
- Push the npm-created annotated version tag at the verified commit to `origin` without force so the Release workflow publishes the GitHub release and SBOM
- Save a Sites version with the exact verified archive
- Deploy that saved version to public production

Do not ask for duplicate confirmation before those actions. The direct release request does not authorize any other commit, amending, merging, rebasing, force-pushing, changing environment variables, rolling back, deleting or moving tags or versions, or changing access and domain configuration.

Use the version increment named by the user when the release request specifies `major`, `minor`, or `patch`; otherwise default to `patch`. If a complete unpublished npm-created version tag already exists at `HEAD`, resume that prepared release instead of incrementing it again. Never guess through partial or contradictory changelog, package-version, commit, or tag state.

## Load the release surfaces

1. Resolve the Stowplan repository root with `git rev-parse --show-toplevel`, work only in that checkout, and read its `AGENTS.md`, `docs/maintainers/agents.md`, and `docs/maintainers/testing.md` before acting.
2. Read `package.json`, `package-lock.json`, `.npmrc`, `CHANGELOG.md`, `scripts/preversion.sh`, `.github/workflows/release.yml`, and `.openai/hosting.json`. Copy the opaque Sites `project_id` exactly.
3. Require the Release workflow to trigger on `v*` tag pushes and publish `stowplan-sbom.cdx.json`. Stop before creating a tag if that automation does not match.
4. Use `gh` against the repository resolved from `origin` for GitHub Actions and Releases. Do not hardcode the repository owner or name.
5. Use the connected Sites app for site inspection, source credentials, version saving, deployment, and deployment status. Never create another site.
6. Use the browser automation skill for production smoke tests and run `agent-browser skills get core` before browser commands.

## Preflight Git

1. Require branch `main` and a completely clean tracked and untracked worktree. Ignored build outputs are allowed.
2. Fetch `origin/main` and tags without changing the checkout.
3. Require `origin/main` to equal `HEAD` or be an ancestor of `HEAD`. Stop if local `main` is behind or diverged.
4. Require the `preversion` lifecycle to reject non-`main` branches and project npm configuration to set `git-tag-version=true`, `message=%s`, and `tag-version-prefix=v`.
5. Resolve the repository from `origin`, then inspect its stable version tags and GitHub Releases rather than assuming the package version is published or unpublished.
6. Inspect Sites project metadata and require the existing `stowplan` project, owner access, public mode, and custom live URL `https://stowplan.lasers.app`.
7. Read Sites environment metadata without printing secret values. A missing `NEXT_PUBLIC_DOCS_URL` is valid because the source default is canonical. Stop if it overrides the docs base to anything except `https://docs.stowplan.lasers.app/`. Do not mutate the environment.

## Prepare or resume the version

1. First check for a complete prepared release at `HEAD`: `package.json` and both root versions in `package-lock.json` contain the same stable `MAJOR.MINOR.PATCH` version, `CHANGELOG.md` has that version entry, and the local annotated `v<version>` tag dereferences to `HEAD` with the unprefixed version as its annotation subject. Resume it only when that tag is absent from both `origin` and GitHub Releases.
2. Otherwise require the declared package version and its reachable tag to identify the latest published stable release, require at least one unreleased commit after it, and require no other unpublished stable version tag in that range. Stop on a partial prior preparation instead of amending commits or deleting, moving, or recreating a tag.
3. Use the requested version increment, defaulting to `patch`, and derive the target version with npm's Semantic Versioning rules. Require the target version and `v<version>` tag to be absent from the changelog, local tags, `origin`, and GitHub Releases.
4. Summarize the actual user-visible changes since the latest published tag in a dated Keep a Changelog entry for the target version. Use only the `Added`, `Changed`, `Deprecated`, `Removed`, `Fixed`, and `Security` sections that the changes warrant; do not turn commit subjects into invented claims.
5. Inspect the complete worktree and staged diffs, then stage and commit only `CHANGELOG.md` with subject `docs(release): add <version> changelog`. Require the worktree to be clean afterward.
6. Run `npm version <major|minor|patch>` without flags that alter npm's configured commit or tag behavior. Require its version commit to change only `package.json` and `package-lock.json`, require all package versions to equal the target, and require the local annotated tag to dereference to the new `HEAD` with the unprefixed version as its annotation subject.
7. Record the full prepared `HEAD` commit and do not permit it to change during verification or publication. Require the release tag to remain absent from `origin` and GitHub Releases.

## Verify and package

Run the repository-local preparation gate:

```bash
bash "$(git rev-parse --show-toplevel)/.agents/skills/stowplan-release/scripts/prepare-release.sh" "$(git rev-parse --show-toplevel)"
```

The gate runs the repository's complete core and browser verification sequence for the exact prepared `HEAD`, records that commit in Git metadata, removes only the exact Next development block mechanically appended to an initially clean `AGENTS.md`, requires the tree to return clean, validates the compiled documentation origin, and writes the Sites archive at `<repository-root>/work/stowplan-sites.tar.gz`.

Stop on any failure. Do not weaken, skip, or rerun a narrower substitute for a failed gate.

## Push the verified commit

1. Reconfirm `HEAD` matches the recorded and packaged commit.
2. If `origin/main` is behind, push `HEAD:refs/heads/main` to `origin` without force. Verify the remote head equals the full commit. Skip the push when it already matches.
3. Request a short-lived Sites source-repository write credential through the Sites app. Never print, persist, place in a remote URL, or store its token in Git configuration.
4. Use the credential only through per-command Git authentication. Read the Sites source `main` head, fetch it when ancestry cannot be proven locally, and require it to equal the verified commit or be its ancestor.
5. Push `HEAD:refs/heads/main` to the exact credential-provided remote without force when needed. Verify with a credentialed `ls-remote`, then discard the token from working context.
6. Stop if either remote would require a force push or contains commits absent from local `main`.

## Publish the GitHub release

1. Reconfirm `HEAD` matches the recorded and packaged commit and `origin/main` resolves to that commit.
2. Reconfirm the local annotated release tag dereferences to the recorded commit and its annotation subject equals the unprefixed release version.
3. Push only that tag to `origin` without force. Verify the remote tag dereferences to the full recorded commit. Never force, move, delete, or recreate a release tag.
4. Locate the exact Release workflow run triggered by the tag push, require its tag and head commit to match the recorded values, and poll it until completion. Provide concise progress updates at least once per minute.
5. On workflow failure, stop and report the run URL plus the failing step and error. Do not create the release manually, bypass the workflow, or deploy Sites.
6. Require the published GitHub release to use the exact tag, be neither draft nor prerelease, and include the nonempty `stowplan-sbom.cdx.json` asset. Retain and report its public URL.

## Save and deploy Sites

Treat the GitHub semantic version and Sites integer version number as independent identifiers. Do not compare or synchronize them; correlate both publications through the recorded full commit and report both versions.

1. Save a new version using the exact project ID, verified full commit, and absolute archive path. Retain the returned opaque version ID and report its human-facing version number.
2. Deploy only that saved version with the public Sites deployment tool. The direct release request is the required production approval.
3. Poll the exact deployment ID with the exact project and version IDs until `succeeded` or `failed`. Provide concise progress updates at least once per minute.
4. On failure, stop and report the failure message plus the site, version number, and deployment ID. Do not roll back automatically.

## Verify public production

Use a new isolated browser session so an older client bundle cannot satisfy the checks.

1. Open `https://stowplan.lasers.app/` and verify the User guide, Privacy policy, Terms of Service, and Source destinations.
2. Open `/demo` and verify `Open the step-by-step demo guide` points to `https://docs.stowplan.lasers.app/guide/getting-started`.
3. Verify the account-menu User guide, workspace-hub User guide, Settings `Open full user guide`, offline quick-guide `Open full user guide`, and `Open all documentation` destinations.
4. Reject any rendered Stowplan link using `j-256.github.io/stowplan` or `stowplan.jklein.dev`.
5. Verify the getting-started documentation target and `/api/health` return successful responses.
6. Close release browser sessions when the audit is complete.

## Finish

Require the Git worktree to be clean. Report whether the version was prepared or resumed, the released commit and tag, GitHub release URL and workflow result, SBOM attachment result, Sites version number, production URL, complete verification result, and live smoke-test result. Send a Hero notification for success and a Sosumi notification only when a real blocker needs attention.
