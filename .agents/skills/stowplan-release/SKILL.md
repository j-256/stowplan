---
name: stowplan-release
description: Release the Stowplan main branch through its GitHub origin and OpenAI Sites production project, including release-equivalent verification, exact-source artifact packaging, non-force source pushes, Sites version save and deploy, and live browser smoke tests. Use only when the user explicitly invokes $stowplan-release.
---

# Release Stowplan

Release the clean `main` branch to the public Stowplan Sites project and verify the custom production domain end to end.

## Treat invocation as release authorization

An explicit invocation authorizes all ordinary release writes in this workflow:

- Push the verified `main` commit to `origin` with an ordinary non-force push when needed
- Push that same commit to the Sites source repository with an ordinary non-force push when needed
- Save a Sites version with the exact verified archive
- Deploy that saved version to public production

Do not ask for duplicate confirmation before those actions. Invocation does not authorize creating or amending commits, merging, rebasing, force-pushing, changing environment variables, rolling back, deleting versions, or changing access and domain configuration.

## Load the release surfaces

1. Resolve the Stowplan repository root with `git rev-parse --show-toplevel`, work only in that checkout, and read its `AGENTS.md` plus `docs/maintainers/agents.md` before acting.
2. Read `.openai/hosting.json` and copy its opaque `project_id` exactly.
3. Use the connected Sites app for site inspection, source credentials, version saving, deployment, and deployment status. Never create another site.
4. Use the browser automation skill for production smoke tests and run `agent-browser skills get core` before browser commands.

## Preflight Git

1. Require branch `main` and a completely clean tracked and untracked worktree. Ignored build outputs are allowed.
2. Fetch `origin/main` without changing the checkout.
3. Require `origin/main` to equal `HEAD` or be an ancestor of `HEAD`. Stop if local `main` is behind or diverged.
4. Record the full `HEAD` commit and do not permit it to change during the workflow.
5. Inspect Sites project metadata and require the existing `stowplan` project, owner access, public mode, and custom live URL `https://stowplan.lasers.app`.
6. Read Sites environment metadata without printing secret values. A missing `NEXT_PUBLIC_DOCS_URL` is valid because the source default is canonical. Stop if it overrides the docs base to anything except `https://docs.stowplan.lasers.app/`. Do not mutate the environment.

## Verify and package

Run the repository-local preparation gate:

```bash
bash "$(git rev-parse --show-toplevel)/.agents/skills/stowplan-release/scripts/prepare-release.sh" "$(git rev-parse --show-toplevel)"
```

The gate runs the repository's complete verification sequence, removes only the exact Next development block mechanically appended to an initially clean `AGENTS.md`, requires the tree to return clean, validates the compiled documentation origin, and writes the Sites archive at `<repository-root>/work/stowplan-sites.tar.gz`.

Stop on any failure. Do not weaken, skip, or rerun a narrower substitute for a failed gate.

## Push the verified commit

1. Reconfirm `HEAD` matches the recorded and packaged commit.
2. If `origin/main` is behind, push `HEAD:refs/heads/main` to `origin` without force. Verify the remote head equals the full commit. Skip the push when it already matches.
3. Request a short-lived Sites source-repository write credential through the Sites app. Never print, persist, place in a remote URL, or store its token in Git configuration.
4. Use the credential only through per-command Git authentication. Read the Sites source `main` head, fetch it when ancestry cannot be proven locally, and require it to equal the verified commit or be its ancestor.
5. Push `HEAD:refs/heads/main` to the exact credential-provided remote without force when needed. Verify with a credentialed `ls-remote`, then discard the token from working context.
6. Stop if either remote would require a force push or contains commits absent from local `main`.

## Save and deploy Sites

1. Save a new version using the exact project ID, verified full commit, and absolute archive path. Retain the returned opaque version ID and report its human-facing version number.
2. Deploy only that saved version with the public Sites deployment tool. The explicit skill invocation is the required production approval.
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

Require the Git worktree to be clean. Report the released commit, Sites version number, production URL, complete verification result, and live smoke-test result. Send a Hero notification for success and a Sosumi notification only when a real blocker needs attention.
